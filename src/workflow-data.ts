import {
  CliError,
  type NodeReference,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkflow(raw: unknown): WorkflowDefinition {
  if (!isRecord(raw)) {
    throw new CliError("parse", "Workflow must be an object.");
  }
  if (typeof raw.name !== "string") {
    throw new CliError("parse", "Workflow name must be a string.");
  }
  if (!Array.isArray(raw.nodes)) {
    throw new CliError("parse", "Workflow nodes must be an array.");
  }
  if (!isRecord(raw.connections)) {
    throw new CliError("parse", "Workflow connections must be an object.");
  }

  return raw as WorkflowDefinition;
}

export function findNode(
  def: WorkflowDefinition,
  name: string,
): WorkflowNode | undefined {
  return def.nodes.find((node) => node.name === name);
}

export function extractReferences(node: WorkflowNode): NodeReference[] {
  const refs: NodeReference[] = [];

  function pushNamed(referencedNode: string): void {
    refs.push({
      node: node.name,
      expression: `$('${referencedNode}')`,
      referencedNode,
    });
  }

  function inspectExpression(value: string): void {
    const modern = /\$\((['"])(.*?)\1\)/g;
    const legacyNode = /\$node\[(['"])(.*?)\1\]/g;
    const legacyItems = /\$items\((['"])(.*?)\1\)/g;
    const json = /\$json\b/g;

    for (const match of value.matchAll(modern)) {
      pushNamed(match[2]);
    }
    for (const match of value.matchAll(legacyNode)) {
      pushNamed(match[2]);
    }
    for (const match of value.matchAll(legacyItems)) {
      pushNamed(match[2]);
    }
    for (const match of value.matchAll(json)) {
      refs.push({ node: node.name, expression: match[0] });
    }
  }

  function walk(value: unknown): void {
    if (typeof value === "string") {
      if (value.startsWith("=")) inspectExpression(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    if (isRecord(value)) {
      for (const item of Object.values(value)) walk(item);
    }
  }

  walk(node.parameters ?? {});
  return refs;
}

function addEdge(
  graph: Map<string, Set<string>>,
  target: string,
  source: string,
): void {
  const sources = graph.get(target) ?? new Set<string>();
  sources.add(source);
  graph.set(target, sources);
}

export function buildGraph(def: WorkflowDefinition): {
  ancestors(node: string): Set<string>;
  mainPredecessors(node: string): Set<string>;
} {
  const allPredecessors = new Map<string, Set<string>>();
  const mainPredecessorMap = new Map<string, Set<string>>();

  for (const [sourceName, sourceConnections] of Object.entries(def.connections)) {
    if (!isRecord(sourceConnections)) continue;

    for (const [connectionType, outputs] of Object.entries(sourceConnections)) {
      if (!Array.isArray(outputs)) continue;

      for (const output of outputs) {
        if (!Array.isArray(output)) continue;

        for (const connection of output) {
          if (!isRecord(connection) || typeof connection.node !== "string") {
            continue;
          }

          addEdge(allPredecessors, connection.node, sourceName);
          if (connectionType === "main") {
            addEdge(mainPredecessorMap, connection.node, sourceName);
          }
        }
      }
    }
  }

  return {
    ancestors(nodeName: string): Set<string> {
      const ancestors = new Set<string>();
      const queue = [...(allPredecessors.get(nodeName) ?? [])];

      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];
        if (ancestors.has(current)) continue;

        ancestors.add(current);
        for (const predecessor of allPredecessors.get(current) ?? []) {
          if (!ancestors.has(predecessor)) queue.push(predecessor);
        }
      }

      return ancestors;
    },
    mainPredecessors(nodeName: string): Set<string> {
      return new Set(mainPredecessorMap.get(nodeName) ?? []);
    },
  };
}
