import { test, expect } from "bun:test";
import { extractWebhooks } from "../src/webhooks";

test("extracts a webhook node with path and method", () => {
  const nodes = [
    {
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      parameters: { path: "abc-123", httpMethod: "POST" },
    },
  ];
  expect(extractWebhooks(nodes, "https://h.co")).toEqual([
    {
      node: "Webhook",
      method: "POST",
      path: "abc-123",
      productionUrl: "https://h.co/webhook/abc-123",
      testUrl: "https://h.co/webhook-test/abc-123",
    },
  ]);
});

test("falls back to webhookId and GET when parameters are absent", () => {
  const nodes = [
    { name: "Hook", type: "n8n-nodes-base.webhook", webhookId: "wid-9" },
  ];
  const [w] = extractWebhooks(nodes, "https://h.co");
  expect(w.path).toBe("wid-9");
  expect(w.method).toBe("GET");
});

test("treats any node carrying a webhookId as a webhook", () => {
  const nodes = [
    { name: "Form", type: "n8n-nodes-base.formTrigger", webhookId: "f1", parameters: {} },
  ];
  expect(extractWebhooks(nodes, "https://h.co").length).toBe(1);
});

test("ignores non-webhook nodes", () => {
  const nodes = [{ name: "Set", type: "n8n-nodes-base.set", parameters: {} }];
  expect(extractWebhooks(nodes, "https://h.co")).toEqual([]);
});

test("handles a missing or empty nodes array", () => {
  expect(extractWebhooks(undefined as any, "https://h.co")).toEqual([]);
  expect(extractWebhooks([], "https://h.co")).toEqual([]);
});
