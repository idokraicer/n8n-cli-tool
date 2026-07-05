import {
  CliError,
  type MergePlan,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./types";

const READ_ONLY_FIELDS = [
  "id",
  "active",
  "tags",
  "versionId",
  "triggerCount",
  "createdAt",
  "updatedAt",
  "pinData",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function cloneWorkflow(def: WorkflowDefinition): WorkflowDefinition {
  return structuredClone(def);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nodesByName(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  const byName = new Map<string, WorkflowNode>();
  const duplicates = new Set<string>();

  for (const node of nodes) {
    if (byName.has(node.name)) duplicates.add(node.name);
    byName.set(node.name, node);
  }

  if (duplicates.size > 0) {
    throw new CliError(
      "bad-arguments",
      `Workflow contains duplicate node names: ${[...duplicates].sort().join(", ")}`,
    );
  }

  return byName;
}

export function computeChangedNodes(
  local: WorkflowDefinition,
  live: WorkflowDefinition,
): string[] {
  const liveNodes = nodesByName(live.nodes ?? []);
  const changed: string[] = [];

  for (const localNode of local.nodes ?? []) {
    const liveNode = liveNodes.get(localNode.name);
    if (!liveNode || !deepEqual(localNode, liveNode)) {
      changed.push(localNode.name);
    }
  }

  return changed;
}

export function mergeNodes(
  live: WorkflowDefinition,
  local: WorkflowDefinition,
  nodeNames: string[] | null,
): MergePlan {
  const merged = cloneWorkflow(live);
  const liveNodes = nodesByName(live.nodes ?? []);
  const localNodes = nodesByName(local.nodes ?? []);
  const targets = nodeNames ?? computeChangedNodes(local, live);
  const updated: string[] = [];
  const addedNodes: string[] = [];

  for (const target of targets) {
    const localNode = localNodes.get(target);
    if (!localNode) continue;

    const liveIndex = (merged.nodes ?? []).findIndex((node) => node.name === target);
    if (liveIndex === -1 || !liveNodes.has(target)) {
      addedNodes.push(target);
      continue;
    }

    merged.nodes[liveIndex] = structuredClone(localNode);
    updated.push(target);
  }

  const removedNodes = (live.nodes ?? [])
    .filter((node) => !localNodes.has(node.name))
    .map((node) => node.name);

  return {
    merged,
    updated,
    excluded: {
      addedNodes,
      removedNodes,
      connectionsChanged: !deepEqual(live.connections, local.connections),
    },
  };
}

export function stripForPut(def: WorkflowDefinition): {
  body: Partial<WorkflowDefinition>;
  strippedFields: string[];
} {
  const body: Partial<WorkflowDefinition> = {
    name: def.name,
    nodes: def.nodes,
    connections: def.connections,
    settings: def.settings ?? {},
  };

  if (hasOwn(def, "staticData") && def.staticData !== undefined) {
    body.staticData = def.staticData;
  }

  const strippedFields = READ_ONLY_FIELDS.filter((field) => hasOwn(def, field));

  return { body, strippedFields };
}
