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

  const seen = new Set<string>();
  function pushNamed(raw: string): void {
    // Unescape backslash-escaped delimiters so a name like O\'Brien matches the
    // real node name; dedupe so repeated references don't produce duplicate errors.
    const referencedNode = raw.replace(/\\(.)/g, "$1");
    const key = `named:${referencedNode}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({
      node: node.name,
      expression: `$('${referencedNode}')`,
      referencedNode,
    });
  }

  function inspectExpression(value: string): void {
    // Name captures allow escaped delimiters (\' or \") inside the node name.
    const modern = /\$\((['"])((?:\\.|(?!\1)[\s\S])*)\1\)/g;
    const legacyNode = /\$node\[(['"])((?:\\.|(?!\1)[\s\S])*)\1\]/g;
    const legacyItems = /\$items\((['"])((?:\\.|(?!\1)[\s\S])*)\1\)/g;
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
  // For a sub-node connected to a parent via a non-main (ai_*) input, record
  // the parent(s) it feeds. At runtime a sub-node executes inside its parent's
  // context, so it can reference the parent and everything upstream of it.
  const nonMainParents = new Map<string, Set<string>>();

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
          } else {
            addEdge(nonMainParents, sourceName, connection.node);
          }
        }
      }
    }
  }

  return {
    ancestors(nodeName: string): Set<string> {
      const ancestors = new Set<string>();
      const queue = [...(allPredecessors.get(nodeName) ?? [])];
      // Seed with the parents this node feeds via a non-main (ai_*) connection,
      // so a sub-node's references to the parent's upstream nodes resolve.
      for (const parent of nonMainParents.get(nodeName) ?? []) {
        queue.push(parent);
      }

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
