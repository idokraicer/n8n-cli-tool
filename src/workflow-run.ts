import {
  CliError,
  type RunPlan,
  type WorkflowDefinition,
  type WorkflowNode,
} from "./types";

const WEBHOOK_TYPE = "n8n-nodes-base.webhook";
const INTERNAL_TYPE = "n8n-nodes-base.executeWorkflowTrigger";

function triggerKind(node: WorkflowNode): RunPlan["kind"] | null {
  if (node.type === WEBHOOK_TYPE) return "webhook";
  if (node.type === INTERNAL_TYPE) return "internal";
  return null;
}

function findNode(def: WorkflowDefinition, name: string): WorkflowNode {
  const node = def.nodes.find((candidate) => candidate.name === name);
  if (!node) {
    throw new CliError("bad-arguments", `Node "${name}" was not found.`);
  }
  return node;
}

export function detectTrigger(
  def: WorkflowDefinition,
  override?: string,
): RunPlan {
  if (override) {
    const node = findNode(def, override);
    const kind = triggerKind(node);
    if (!kind) {
      throw new CliError(
        "bad-arguments",
        `Node "${override}" is not a supported trigger.`,
      );
    }
    return { kind, triggerNode: node.name };
  }

  const webhook = def.nodes.find((node) => node.type === WEBHOOK_TYPE);
  if (webhook) return { kind: "webhook", triggerNode: webhook.name };

  const internal = def.nodes.find((node) => node.type === INTERNAL_TYPE);
  if (internal) return { kind: "internal", triggerNode: internal.name };

  throw new CliError("bad-arguments", "No supported trigger; pass --node");
}

// Methods whose test payload rides in the request body. GET/HEAD carry no body,
// so their sample data is encoded as query params instead (matching how n8n's
// Webhook node reads inputs for those verbs).
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function resolveWebhookMethod(raw: unknown): string {
  // n8n stores httpMethod as a string, or an array when "multiple methods" is
  // on; default to GET (the Webhook node's own default) when unset.
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().toUpperCase();
  }
  return "GET";
}

function appendQueryParams(url: string, data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    params.append(
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    );
  }
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}

export function buildWebhookRequest(
  baseUrl: string,
  def: WorkflowDefinition,
  triggerNode: string,
  data: unknown,
): { url: string; method: string; body: unknown } {
  const node = findNode(def, triggerNode);
  const webhookPath = node.parameters?.path;
  if (typeof webhookPath !== "string" || webhookPath.length === 0) {
    throw new CliError(
      "bad-arguments",
      `Webhook node "${triggerNode}" has no parameters.path.`,
    );
  }
  const method = resolveWebhookMethod(node.parameters?.httpMethod);
  const url = `${baseUrl.replace(/\/+$/, "")}/webhook/${webhookPath.replace(/^\/+/, "")}`;
  if (BODY_METHODS.has(method)) {
    return { url, method, body: data };
  }
  return { url: appendQueryParams(url, data), method, body: undefined };
}

export function buildInternalRunPayload(
  def: WorkflowDefinition,
  triggerNode: string,
  data: unknown,
): unknown {
  // Verified against a live n8n instance (2026-07-05) by capturing the editor's
  // real POST /rest/workflows/:id/run request: n8n runs the SAVED workflow by
  // id and starts from the trigger. Sample input rides in triggerToStartFrom.data
  // as an ITaskData (the trigger's main output items).
  const triggerToStartFrom: { name: string; data?: unknown } = {
    name: triggerNode,
  };
  if (data !== undefined) {
    triggerToStartFrom.data = { data: { main: [[{ json: data }]] } };
  }
  return {
    workflowId: def.id,
    startNodes: [],
    triggerToStartFrom,
  };
}

export function summarizeRun(response: any): {
  executionId?: string;
  status?: string;
} {
  const executionId = response?.data?.executionId ?? response?.executionId;
  const status = response?.status ?? response?.data?.status;
  return {
    ...(executionId === undefined ? {} : { executionId: String(executionId) }),
    ...(status === undefined ? {} : { status: String(status) }),
  };
}
