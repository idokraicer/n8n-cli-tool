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
  // UNVERIFIED: confirm against live /rest/workflows/:id/run
  return {
    workflowData: def,
    runData: {},
    startNodes: [triggerNode],
    pinData: { [triggerNode]: [{ json: data }] },
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
