import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGet } from "../src/commands/get";

let home: string;

const execution = {
  id: 351694,
  workflowId: "WF",
  status: "success",
  mode: "trigger",
  finished: true,
  startedAt: "S",
  stoppedAt: "T",
  data: {
    resultData: {
      lastNodeExecuted: "HTTP Request",
      runData: {
        "HTTP Request": [
          { executionStatus: "success", data: { main: [[{ json: { order: { id: "500857721" } } }]] } },
        ],
      },
    },
  },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-get-"));
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runGet returns 0 for an execution summary", async () => {
  const client = { getExecution: async () => execution };
  const code = await runGet(
    "https://h.co/workflow/WF/executions/351694",
    { json: true, quiet: true },
    () => client as any,
  );
  expect(code).toBe(0);
});

test("runGet returns 0 when drilling a node and path", async () => {
  const client = { getExecution: async () => execution };
  const code = await runGet(
    "351694",
    { json: true, quiet: true, node: "HTTP Request", path: "json.order.id" },
    () => client as any,
  );
  expect(code).toBe(0);
});

test("runGet throws when a path resolves to nothing", async () => {
  const client = { getExecution: async () => execution };
  await expect(
    runGet("351694", { json: true, quiet: true, node: "HTTP Request", path: "json.missing" }, () => client as any),
  ).rejects.toMatchObject({ code: "bad-arguments" });
});

function chainExecution(
  id: string,
  workflowId: string,
  name: string,
  parent?: { executionId: string; workflowId: string },
) {
  return {
    id,
    workflowId,
    status: "success",
    mode: parent ? "integrated" : "webhook",
    finished: true,
    startedAt: "S",
    stoppedAt: "T",
    workflowData: { name },
    data: {
      resultData: { runData: {} },
      ...(parent
        ? {
            parentExecution: {
              ...parent,
              executionContext: {
                source: "webhook",
                triggerNode: { name: "Webhook" },
              },
            },
          }
        : {}),
    },
  };
}

test("runGet --trace walks the parent chain root-first", async () => {
  const executions: Record<string, unknown> = {
    "3": chainExecution("3", "WF-C", "Child", { executionId: "2", workflowId: "WF-B" }),
    "2": chainExecution("2", "WF-B", "Middle", { executionId: "1", workflowId: "WF-A" }),
    "1": chainExecution("1", "WF-A", "Root"),
  };
  const client = { getExecution: async (id: string) => executions[id] };
  const out = join(home, "trace.json");
  const code = await runGet(
    "3",
    { json: true, quiet: true, trace: true, cache: false, out },
    () => client as any,
  );
  expect(code).toBe(0);
  const payload = JSON.parse(await Bun.file(out).text());
  expect(payload.trace.map((e: any) => e.executionId)).toEqual(["1", "2", "3"]);
  expect(payload.trace[0].triggeredBy).toBeNull();
  expect(payload.trace[0].mode).toBe("webhook");
  expect(payload.trace[2].triggeredBy).toMatchObject({
    executionId: "2",
    workflowId: "WF-B",
    source: "webhook",
    triggerNode: "Webhook",
  });
  expect(payload.summary).toMatchObject({ depth: 3, truncated: false });
  expect(payload.summary.root).toMatchObject({ executionId: "1", workflowName: "Root" });
});

test("runGet --trace handles an execution with no parent", async () => {
  const client = {
    getExecution: async () => chainExecution("9", "WF", "Solo"),
  };
  const out = join(home, "trace.json");
  const code = await runGet(
    "9",
    { json: true, quiet: true, trace: true, cache: false, out },
    () => client as any,
  );
  expect(code).toBe(0);
  const payload = JSON.parse(await Bun.file(out).text());
  expect(payload.trace).toHaveLength(1);
  expect(payload.summary.depth).toBe(1);
});

test("runGet --trace stops on a parent cycle", async () => {
  const a = chainExecution("1", "WF-A", "A", { executionId: "2", workflowId: "WF-B" });
  const b = chainExecution("2", "WF-B", "B", { executionId: "1", workflowId: "WF-A" });
  const client = {
    getExecution: async (id: string) => (id === "1" ? a : b),
  };
  const out = join(home, "trace.json");
  const code = await runGet(
    "1",
    { json: true, quiet: true, trace: true, cache: false, out },
    () => client as any,
  );
  expect(code).toBe(0);
  const payload = JSON.parse(await Bun.file(out).text());
  expect(payload.trace).toHaveLength(2);
});
