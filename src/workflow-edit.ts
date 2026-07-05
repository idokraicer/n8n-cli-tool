import { findNode } from "./workflow-data";
import {
  CliError,
  type EditResult,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./types";

type PromptOpts = {
  system?: string;
  user?: string;
  systemPath?: string;
  userPath?: string;
  literal?: boolean;
};

function availableNodeNames(def: WorkflowDefinition): string {
  return def.nodes.map((node) => node.name).join(", ");
}

function requireNode(
  def: WorkflowDefinition,
  nodeName: string,
): WorkflowNode {
  const node = findNode(def, nodeName);
  if (!node) {
    throw new CliError(
      "bad-arguments",
      `Unknown node '${nodeName}'. Available: ${availableNodeNames(def)}`,
    );
  }
  return node;
}

function charLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function pathSegments(path: string): string[] {
  const parts = path.split(".");
  for (const part of parts) {
    if (UNSAFE_SEGMENTS.has(part)) {
      throw new CliError(
        "bad-arguments",
        `Unsafe path segment '${part}' in '${path}'.`,
      );
    }
  }
  return parts;
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of pathSegments(path)) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = pathSegments(path);
  let current = obj;

  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

function setStringField(
  node: WorkflowNode,
  path: string,
  value: string,
): EditResult {
  const before = getByPath(node, path);
  setByPath(node, path, value);
  return {
    node: node.name,
    field: path,
    action: "set",
    beforeChars: charLength(before),
    afterChars: value.length,
  };
}

const CODE_NODE_TYPE = "n8n-nodes-base.code";
const AGENT_NODE_TYPE = "@n8n/n8n-nodes-langchain.agent";

export function setCode(
  def: WorkflowDefinition,
  nodeName: string,
  code: string,
  lang: "js" | "python",
): EditResult {
  const node = requireNode(def, nodeName);
  const field = lang === "js" ? "parameters.jsCode" : "parameters.pythonCode";
  const result = setStringField(node, field, code);
  if (node.type !== CODE_NODE_TYPE) {
    result.warning = `Node '${nodeName}' is type '${node.type}', not ${CODE_NODE_TYPE}; ${field} may be ignored at runtime.`;
  }
  return result;
}

function promptValue(
  existing: unknown,
  next: string,
  literal: boolean | undefined,
): string {
  if (literal) return next;
  if (typeof existing === "string" && existing.startsWith("=")) {
    return next.startsWith("=") ? next : `=${next}`;
  }
  return next;
}

export function setPrompt(
  def: WorkflowDefinition,
  nodeName: string,
  opts: PromptOpts,
): EditResult[] {
  if (opts.system === undefined && opts.user === undefined) {
    throw new CliError(
      "bad-arguments",
      "Provide at least one of --system/--system-file or --user/--user-file.",
    );
  }

  const node = requireNode(def, nodeName);
  const results: EditResult[] = [];

  if (opts.system !== undefined) {
    const field = opts.systemPath ?? "parameters.options.systemMessage";
    const existing = getByPath(node, field);
    results.push(
      setStringField(
        node,
        field,
        promptValue(existing, opts.system, opts.literal),
      ),
    );
  }

  if (opts.user !== undefined) {
    const field = opts.userPath ?? "parameters.text";
    const existing = getByPath(node, field);
    results.push(
      setStringField(
        node,
        field,
        promptValue(existing, opts.user, opts.literal),
      ),
    );
    // n8n ignores parameters.text unless promptType is "define"; setting the
    // default user field without this leaves the prompt silently inert.
    if (!opts.userPath) {
      setByPath(node, "parameters.promptType", "define");
    }
  }

  if (node.type !== AGENT_NODE_TYPE) {
    const warning = `Node '${nodeName}' is type '${node.type}', not ${AGENT_NODE_TYPE}; the prompt field(s) may be ignored at runtime.`;
    for (const result of results) result.warning = warning;
  }

  return results;
}

export function replaceNode(
  def: WorkflowDefinition,
  nodeName: string,
  replacement: Partial<WorkflowNode> & Record<string, unknown>,
): EditResult {
  const index = def.nodes.findIndex((node) => node.name === nodeName);
  if (index === -1) {
    throw new CliError(
      "bad-arguments",
      `Unknown node '${nodeName}'. Available: ${availableNodeNames(def)}`,
    );
  }

  const existing = def.nodes[index];
  if (
    typeof replacement.name === "string" &&
    replacement.name !== nodeName
  ) {
    throw new CliError(
      "bad-arguments",
      `Replacement node name '${replacement.name}' does not match '${nodeName}'. Renames are out of scope.`,
    );
  }

  const next = {
    ...replacement,
    name: replacement.name ?? existing.name,
    id: replacement.id ?? existing.id,
    position: replacement.position ?? existing.position,
  } as WorkflowNode;

  const beforeChars = JSON.stringify(existing).length;
  const afterChars = JSON.stringify(next).length;
  def.nodes[index] = next;

  return {
    node: nodeName,
    field: "node",
    action: "replaced",
    beforeChars,
    afterChars,
  };
}
