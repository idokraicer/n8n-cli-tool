import { test, expect, beforeEach, afterEach } from "bun:test";
import { runExecutions } from "../src/commands/executions";

beforeEach(() => {
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runExecutions lists executions for a bare workflow id", async () => {
  const fakeClient = {
    listExecutions: async () => ({
      data: [
        { id: 5, status: "success", mode: "manual", finished: true, startedAt: "S", stoppedAt: "T", workflowId: "WF" },
      ],
      nextCursor: null,
    }),
  };
  const code = await runExecutions("WF", { json: true, quiet: true, limit: "20" }, () => fakeClient as any);
  expect(code).toBe(0);
});
