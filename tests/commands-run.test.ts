import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRun, type SessionFactory } from "../src/commands/run";
import { CliError, type WorkflowDefinition } from "../src/types";

let home: string;
let writes: string[];
const originalWrite = process.stdout.write;

const webhookWorkflow: WorkflowDefinition = {
  id: "WF",
  name: "Webhook WF",
  nodes: [
    {
      id: "n1",
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      parameters: { path: "orders/new" },
    },
  ],
  connections: {},
};

const internalWorkflow: WorkflowDefinition = {
  id: "WF",
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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-run-"));
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
  writes = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

function emitted() {
  return JSON.parse(writes.join(""));
}

test("runRun posts sample data to a webhook trigger and emits webhook mode", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => webhookWorkflow,
    postWebhook: async (url: string, body: unknown) => {
      calls.push({ url, body });
      return { status: 200, body: { data: { executionId: "900" }, status: "running" } };
    },
  };

  const code = await runRun(
    "WF",
    { dataInline: '{"orderId":123}', json: true, quiet: true },
    () => client as any,
  );

  expect(code).toBe(0);
  expect(calls).toEqual([
    { url: "https://h.co/webhook/orders/new", body: { orderId: 123 } },
  ]);
  expect(emitted()).toMatchObject({
    instance: "h.co",
    workflow: {
      id: "WF",
      name: "Webhook WF",
      url: "https://h.co/workflow/WF",
    },
    mode: "webhook",
    execution: {
      id: "900",
      url: "https://h.co/workflow/WF/executions/900",
      status: "running",
    },
  });
});

test("runRun reads sample data from a file", async () => {
  const sample = join(home, "sample.json");
  writeFileSync(sample, '{"file":true}');
  const calls: unknown[] = [];
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => webhookWorkflow,
    postWebhook: async (_url: string, body: unknown) => {
      calls.push(body);
      return { status: 200, body: { executionId: "901" } };
    },
  };

  const code = await runRun(
    "WF",
    { data: sample, json: true, quiet: true },
    () => client as any,
  );

  expect(code).toBe(0);
  expect(calls).toEqual([{ file: true }]);
});

test("runRun posts internal payload with a saved session and emits internal mode", async () => {
  const runCalls: { id: string; payload: unknown; cookie: string }[] = [];
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => internalWorkflow,
    runWorkflow: async (
      id: string,
      payload: unknown,
      opts: { cookie: string },
    ) => {
      runCalls.push({ id, payload, cookie: opts.cookie });
      return { status: 200, body: { executionId: "902", status: "new" } };
    },
  };
  const sessionFactory: SessionFactory = () => ({
    getCookie: async () => "n8n-auth=saved",
  });

  const code = await runRun(
    "WF",
    { dataInline: '{"x":1}', json: true, quiet: true },
    () => client as any,
    sessionFactory,
  );

  expect(code).toBe(0);
  expect(runCalls).toEqual([
    {
      id: "WF",
      cookie: "n8n-auth=saved",
      payload: {
        workflowId: "WF",
        startNodes: [],
        triggerToStartFrom: {
          name: "Execute Workflow Trigger",
          data: { data: { main: [[{ json: { x: 1 } }]] } },
        },
      },
    },
  ]);
  expect(emitted()).toMatchObject({
    mode: "internal",
    execution: {
      id: "902",
      url: "https://h.co/workflow/WF/executions/902",
      status: "new",
    },
  });
});

test("runRun polls an execution when --poll is set", async () => {
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => webhookWorkflow,
    postWebhook: async () => ({ status: 200, body: { executionId: "903" } }),
    getExecution: async (id: string) => ({ id, status: "success" }),
  };

  const code = await runRun(
    "WF",
    { poll: true, json: true, quiet: true },
    () => client as any,
  );

  expect(code).toBe(0);
  expect(emitted()).toMatchObject({
    execution: { id: "903", status: "success" },
    result: { id: "903", status: "success" },
  });
});

test("runRun returns 2 when no supported trigger exists", async () => {
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => ({
      id: "WF",
      name: "No Trigger",
      nodes: [{ id: "n1", name: "Set", type: "n8n-nodes-base.set" }],
      connections: {},
    }),
  };

  const code = await runRun(
    "WF",
    { json: true, quiet: true },
    () => client as any,
  );

  expect(code).toBe(2);
});

test("runRun refreshes the session and retries once on a 401 from the internal run", async () => {
  const runCalls: string[] = [];
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => internalWorkflow,
    runWorkflow: async (
      _id: string,
      _payload: unknown,
      opts: { cookie: string },
    ) => {
      runCalls.push(opts.cookie);
      if (opts.cookie === "stale") {
        throw new CliError("unauthorized", "HTTP 401");
      }
      return { status: 200, body: { executionId: "77" } };
    },
  };
  let refreshed = false;
  const sessionFactory: SessionFactory = () => ({
    getCookie: async () => "stale",
    refreshCookie: async () => {
      refreshed = true;
      return "fresh";
    },
  });

  const code = await runRun(
    "WF",
    { dataInline: '{"x":1}', json: true, quiet: true },
    () => client as any,
    sessionFactory,
  );

  expect(code).toBe(0);
  expect(refreshed).toBe(true);
  expect(runCalls).toEqual(["stale", "fresh"]);
  expect(emitted()).toMatchObject({ mode: "internal", execution: { id: "77" } });
});

test("runRun --poll keeps a started-run success when the execution isn't fetchable", async () => {
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => webhookWorkflow,
    postWebhook: async () => ({ status: 200, body: { executionId: "950" } }),
    getExecution: async () => {
      throw new CliError("not-found", "404");
    },
  };
  const code = await runRun(
    "WF",
    { poll: true, json: true, quiet: true },
    () => client as any,
  );
  expect(code).toBe(0);
  expect(emitted()).toMatchObject({ execution: { id: "950" } });
});

test("runRun returns exit 1 when the polled execution status is error", async () => {
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => webhookWorkflow,
    postWebhook: async () => ({ status: 200, body: { executionId: "951" } }),
    getExecution: async (id: string) => ({ id, status: "error" }),
  };
  const code = await runRun(
    "WF",
    { poll: true, json: true, quiet: true },
    () => client as any,
  );
  expect(code).toBe(1);
  expect(emitted()).toMatchObject({ execution: { id: "951", status: "error" } });
});

test("runRun reports bad-arguments for malformed inline sample data", async () => {
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => webhookWorkflow,
    postWebhook: async () => ({ status: 200, body: {} }),
  };
  const code = await runRun(
    "WF",
    { dataInline: "{not json", json: true, quiet: true },
    () => client as any,
  );
  expect(code).toBe(2);
  expect(emitted()).toMatchObject({ error: { code: "bad-arguments" } });
});
