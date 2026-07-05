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

export function buildWebhookRequest(
  baseUrl: string,
  def: WorkflowDefinition,
  triggerNode: string,
  data: unknown,
): { url: string; body: unknown } {
  const node = findNode(def, triggerNode);
  const webhookPath = node.parameters?.path;
  if (typeof webhookPath !== "string" || webhookPath.length === 0) {
    throw new CliError(
      "bad-arguments",
      `Webhook node "${triggerNode}" has no parameters.path.`,
    );
  }
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/webhook/${webhookPath.replace(/^\/+/, "")}`,
    body: data,
  };
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
