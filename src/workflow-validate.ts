import {
  buildGraph,
  extractReferences,
  findNode,
  parseWorkflow,
} from "./workflow-data";
import { CliError, type WorkflowDefinition, type WorkflowNode } from "./types";

export interface WorkflowDiff {
  nameChanged: boolean;
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesModified: string[];
  nodesRenamed: Array<{ id: string; from: string; to: string }>;
  connectionsChanged: boolean;
  settingsChanged: boolean;
}

export type ValidationError =
  | {
      type: "broken-reference";
      node: string;
      expression: string;
      referencedNode: string;
      reason: "non-existent" | "not-upstream";
      hint?: string;
    }
  | {
      type: "parse";
      reason: "parse";
      message: string;
    };

export interface ValidationWarning {
  type: "stale-json";
  node: string;
  from: string[];
  to: string[];
  expressions: string[];
  reason: "stale-json";
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  diff?: WorkflowDiff;
  summary: {
    errorCount: number;
    warningCount: number;
  };
}

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

function byId(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function result(
  errors: ValidationError[],
  warnings: ValidationWarning[],
  diff?: WorkflowDiff,
): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ...(diff ? { diff } : {}),
    summary: {
      errorCount: errors.length,
      warningCount: warnings.length,
    },
  };
}

function parseLocalWorkflow(local: unknown): WorkflowDefinition {
  if (typeof local === "string") {
    try {
      return parseWorkflow(JSON.parse(local));
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(
        "parse",
        `Workflow JSON could not be parsed: ${(err as Error).message}`,
      );
    }
  }
  return parseWorkflow(local);
}

export function diffWorkflows(
  local: WorkflowDefinition,
  remote: WorkflowDefinition,
): WorkflowDiff {
  const localById = byId(local.nodes);
  const remoteById = byId(remote.nodes);
  const nodesAdded: string[] = [];
  const nodesRemoved: string[] = [];
  const nodesModified: string[] = [];
  const nodesRenamed: WorkflowDiff["nodesRenamed"] = [];

  for (const localNode of local.nodes) {
    const remoteNode = remoteById.get(localNode.id);
    if (!remoteNode) {
      nodesAdded.push(localNode.name);
      continue;
    }

    const nameChanged = localNode.name !== remoteNode.name;
    if (nameChanged) {
      nodesRenamed.push({
        id: localNode.id,
        from: remoteNode.name,
        to: localNode.name,
      });
    }

    const implementationChanged =
      localNode.type !== remoteNode.type ||
      localNode.typeVersion !== remoteNode.typeVersion ||
      !deepEqual(localNode.parameters, remoteNode.parameters) ||
      !deepEqual(localNode.position, remoteNode.position);

    if (nameChanged || implementationChanged) {
      nodesModified.push(localNode.name);
    }
  }

  for (const remoteNode of remote.nodes) {
    if (!localById.has(remoteNode.id)) nodesRemoved.push(remoteNode.name);
  }

  return {
    nameChanged: local.name !== remote.name,
    nodesAdded,
    nodesRemoved,
    nodesModified,
    nodesRenamed,
    connectionsChanged: !deepEqual(local.connections, remote.connections),
    settingsChanged: !deepEqual(local.settings, remote.settings),
  };
}

function localReferenceErrors(local: WorkflowDefinition): ValidationError[] {
  const graph = buildGraph(local);
  const errors: ValidationError[] = [];

  for (const node of local.nodes) {
    const ancestors = graph.ancestors(node.name);
    for (const ref of extractReferences(node)) {
      if (!ref.referencedNode) continue;

      const referencedNode = findNode(local, ref.referencedNode);
      if (!referencedNode) {
        errors.push({
          type: "broken-reference",
          node: node.name,
          expression: ref.expression,
          referencedNode: ref.referencedNode,
          reason: "non-existent",
        });
        continue;
      }

      if (!ancestors.has(ref.referencedNode)) {
        errors.push({
          type: "broken-reference",
          node: node.name,
          expression: ref.expression,
          referencedNode: ref.referencedNode,
          reason: "not-upstream",
        });
      }
    }
  }

  return errors;
}

function extractJsonExpressions(node: WorkflowNode): string[] {
  const expressions = new Set<string>();
  const jsonReference =
    /\$json\b(?:\.[A-Za-z_$][\w$]*|\[['"][^'"\]]+['"]\]|\[\d+\])*/g;

  function walk(value: unknown): void {
    if (typeof value === "string") {
      if (!value.startsWith("=")) return;
      for (const match of value.matchAll(jsonReference)) {
        expressions.add(match[0]);
      }
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
  return sorted(expressions);
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function staleJsonWarnings(
  local: WorkflowDefinition,
  remote: WorkflowDefinition,
): ValidationWarning[] {
  const localById = byId(local.nodes);
  const remoteById = byId(remote.nodes);
  const localGraph = buildGraph(local);
  const remoteGraph = buildGraph(remote);
  const warnings: ValidationWarning[] = [];

  for (const [id, localNode] of localById) {
    const remoteNode = remoteById.get(id);
    if (!remoteNode) continue;

    const localPredecessors = localGraph.mainPredecessors(localNode.name);
    const remotePredecessors = remoteGraph.mainPredecessors(remoteNode.name);
    if (sameSet(localPredecessors, remotePredecessors)) continue;

    const expressions = extractJsonExpressions(localNode);
    if (expressions.length === 0) continue;

    warnings.push({
      type: "stale-json",
      node: localNode.name,
      from: sorted(remotePredecessors),
      to: sorted(localPredecessors),
      expressions,
      reason: "stale-json",
    });
  }

  return warnings;
}

function attachRenameHints(
  errors: ValidationError[],
  diff: WorkflowDiff,
): ValidationError[] {
  return errors.map((error) => {
    if (error.type !== "broken-reference" || error.reason !== "non-existent") {
      return error;
    }

    const rename = diff.nodesRenamed.find(
      (item) => item.from === error.referencedNode,
    );
    if (!rename) return error;

    return {
      ...error,
      hint: `node was renamed '${rename.from}' -> '${rename.to}'`,
    };
  });
}

export function validateWorkflow(
  local: unknown,
  remote: WorkflowDefinition | null,
): ValidationResult {
  let parsedLocal: WorkflowDefinition;
  try {
    parsedLocal = parseLocalWorkflow(local);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return result([{ type: "parse", reason: "parse", message }], []);
  }

  const parsedRemote = remote === null ? null : parseWorkflow(remote);
  let errors = localReferenceErrors(parsedLocal);
  let diff: WorkflowDiff | undefined;
  let warnings: ValidationWarning[] = [];

  if (parsedRemote) {
    diff = diffWorkflows(parsedLocal, parsedRemote);
    errors = attachRenameHints(errors, diff);
    warnings = staleJsonWarnings(parsedLocal, parsedRemote);
  }

  return result(errors, warnings, diff);
}
