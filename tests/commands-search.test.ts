import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSearch } from "../src/commands/search";

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
      runData: {
        "HTTP Request": [
          { executionStatus: "success", data: { main: [[{ json: { order: { id: "500857721" } } }]] } },
        ],
      },
    },
  },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-search-"));
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

test("runSearch returns exit 0 when a value is found in an execution", async () => {
  const client = { getExecution: async () => execution };
  const code = await runSearch(
    "500857721",
    "https://h.co/workflow/WF/executions/351694",
    { json: true, quiet: true, maxMatches: "100", truncate: "200" },
    () => client as any,
  );
  expect(code).toBe(0);
});

test("runSearch returns exit 1 when nothing matches", async () => {
  const client = { getExecution: async () => execution };
  const code = await runSearch(
    "nothere",
    "https://h.co/workflow/WF/executions/351694",
    { json: true, quiet: true, maxMatches: "100", truncate: "200" },
    () => client as any,
  );
  expect(code).toBe(1);
});

test("runSearch rejects conflicting match modes", async () => {
  const client = { getExecution: async () => execution };
  await expect(
    runSearch(
      "x",
      "https://h.co/workflow/WF/executions/351694",
      { json: true, quiet: true, exact: true, regex: true, maxMatches: "100", truncate: "200" },
      () => client as any,
    ),
  ).rejects.toMatchObject({ code: "bad-arguments" });
});

test("runSearch returns exit 0 for a workflow target with matches", async () => {
  const client = {
    listExecutions: async () => ({
      data: [{ id: 351694 }, { id: 351695 }],
      nextCursor: null,
    }),
    getExecution: async () => execution,
  };
  const code = await runSearch(
    "500857721",
    "WF",
    { json: true, quiet: true, maxMatches: "100", truncate: "200", limit: "20" },
    () => client as any,
  );
  expect(code).toBe(0);
});
