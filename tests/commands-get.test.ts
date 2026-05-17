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
