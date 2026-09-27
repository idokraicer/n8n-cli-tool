import type { WebhookEntry } from "./types";

const WEBHOOK_NODE_TYPES = new Set([
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.formTrigger",
  "@n8n/n8n-nodes-langchain.chatTrigger",
]);

function isWebhookNode(node: any): boolean {
  return WEBHOOK_NODE_TYPES.has(node?.type) || typeof node?.webhookId === "string";
}

export function extractWebhooks(
  nodes: any[] | undefined,
  baseUrl: string,
): WebhookEntry[] {
  if (!Array.isArray(nodes)) return [];
  const entries: WebhookEntry[] = [];
  for (const node of nodes) {
    if (!isWebhookNode(node)) continue;
    const isChat = node.type === "@n8n/n8n-nodes-langchain.chatTrigger";
    const path = isChat
      ? `${String(node.webhookId ?? "")}/chat`
      : String(node?.parameters?.path || node?.webhookId || "");
    const method = isChat ? "POST" : String(node?.parameters?.httpMethod ?? "GET").toUpperCase();
    entries.push({
      node: String(node?.name ?? ""),
      method,
      path,
      productionUrl: `${baseUrl}/webhook/${path}`,
      testUrl: `${baseUrl}/webhook-test/${path}`,
    });
  }
  return entries;
}
