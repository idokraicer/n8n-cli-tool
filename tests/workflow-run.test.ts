import { expect, test } from "bun:test";
import {
  buildInternalRunPayload,
  buildWebhookRequest,
  detectTrigger,
  summarizeRun,
} from "../src/workflow-run";
import { CliError, type WorkflowDefinition } from "../src/types";

const webhookWorkflow: WorkflowDefinition = {
  id: "wf1",
  name: "Webhook WF",
  nodes: [
    {
      id: "n1",
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      parameters: { path: "orders/new" },
    },
    {
      id: "n2",
      name: "Manual child",
      type: "n8n-nodes-base.executeWorkflowTrigger",
      parameters: {},
    },
  ],
  connections: {},
};

test("detectTrigger chooses webhook by default when a webhook node exists", () => {
  expect(detectTrigger(webhookWorkflow)).toEqual({
    kind: "webhook",
    triggerNode: "Webhook",
  });
});

test("detectTrigger chooses internal when only executeWorkflowTrigger exists", () => {
  const def: WorkflowDefinition = {
    id: "wf2",
    name: "Internal WF",
    nodes: [
      {
        id: "n1",
        name: "Execute Workflow Trigger",
        type: "n8n-nodes-base.executeWorkflowTrigger",
        parameters: {},
      },
    ],
    connections: {},
  };

  expect(detectTrigger(def)).toEqual({
    kind: "internal",
    triggerNode: "Execute Workflow Trigger",
  });
});

test("detectTrigger honors --node override and classifies by node type", () => {
  expect(detectTrigger(webhookWorkflow, "Manual child")).toEqual({
    kind: "internal",
    triggerNode: "Manual child",
  });
});

test("detectTrigger throws when no supported trigger exists", () => {
  const def: WorkflowDefinition = {
    id: "wf3",
    name: "No Trigger WF",
    nodes: [{ id: "n1", name: "Set", type: "n8n-nodes-base.set" }],
    connections: {},
  };

  expect(() => detectTrigger(def)).toThrow(CliError);
  expect(() => detectTrigger(def)).toThrow("No supported trigger; pass --node");
});

test("buildWebhookRequest defaults to GET and encodes sample data as query params", () => {
  const data = { orderId: 123, tag: "vip" };

  // The Webhook node has no httpMethod, so it defaults to GET like n8n does;
  // GET carries no body, so sample data rides in the query string instead.
  expect(
    buildWebhookRequest("https://n8n.example", webhookWorkflow, "Webhook", data),
  ).toEqual({
    url: "https://n8n.example/webhook/orders/new?orderId=123&tag=vip",
    method: "GET",
    body: undefined,
  });
});

test("buildWebhookRequest honors POST and puts sample data in the body", () => {
  const data = { orderId: 123 };
  const def: WorkflowDefinition = {
    ...webhookWorkflow,
    nodes: [
      {
        id: "n1",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        parameters: { path: "orders/new", httpMethod: "POST" },
      },
    ],
  };

  expect(buildWebhookRequest("https://n8n.example", def, "Webhook", data)).toEqual({
    url: "https://n8n.example/webhook/orders/new",
    method: "POST",
    body: data,
  });
});

test("buildWebhookRequest resolves the first method when multiple are configured", () => {
  const def: WorkflowDefinition = {
    ...webhookWorkflow,
    nodes: [
      {
        id: "n1",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        parameters: { path: "orders/new", httpMethod: ["PUT", "POST"] },
      },
    ],
  };

  expect(
    buildWebhookRequest("https://n8n.example", def, "Webhook", { a: 1 }),
  ).toEqual({
    url: "https://n8n.example/webhook/orders/new",
    method: "PUT",
    body: { a: 1 },
  });
});

test("buildInternalRunPayload matches n8n's verified /rest run shape (id + triggerToStartFrom)", () => {
  const data = { customer: "Ada" };

  expect(buildInternalRunPayload(webhookWorkflow, "Manual child", data)).toEqual({
    workflowId: "wf1",
    startNodes: [],
    triggerToStartFrom: {
      name: "Manual child",
      data: { data: { main: [[{ json: data }]] } },
    },
  });
});

test("buildInternalRunPayload omits trigger data when none is provided", () => {
  expect(buildInternalRunPayload(webhookWorkflow, "Manual child", undefined)).toEqual({
    workflowId: "wf1",
    startNodes: [],
    triggerToStartFrom: { name: "Manual child" },
  });
});

test("summarizeRun extracts executionId and status from common response shapes", () => {
  expect(
    summarizeRun({ data: { executionId: "101" }, status: "running" }),
  ).toEqual({
    executionId: "101",
    status: "running",
  });
  expect(summarizeRun({ executionId: "102", status: "success" })).toEqual({
    executionId: "102",
    status: "success",
  });
});
