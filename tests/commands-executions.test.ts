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

test("runExecutions uses the internal session route for a time window", async () => {
  let internalParams: any;
  const fakeClient = {
    listExecutions: async () => {
      throw new Error("public API should not be used");
    },
    listExecutionsInternal: async (params: any) => {
      internalParams = params;
      return {
        results: [
          {
            id: "5",
            workflowId: "WF",
            status: "success",
            mode: "manual",
            finished: true,
            startedAt: "2026-07-14T06:30:00.000Z",
            stoppedAt: "2026-07-14T06:31:00.000Z",
          },
        ],
        count: 1,
        estimated: false,
      };
    },
  };
  const fakeSession = {
    hasSession: () => true,
    hasCredentials: () => false,
    getCookie: async () => "n8n-auth=saved",
    getBrowserId: () => "bid",
    refreshCookie: async () => null,
  };
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  }) as any;
  try {
    const code = await runExecutions(
      "WF",
      {
        json: true,
        quiet: true,
        limit: "20",
        from: "2026-07-14T06:00:00Z",
        to: "2026-07-14T07:00:00Z",
      },
      () => fakeClient as any,
      () => fakeSession as any,
    );
    expect(code).toBe(0);
  } finally {
    process.stdout.write = originalWrite as any;
  }

  expect(internalParams).toMatchObject({
    workflowId: "WF",
    startedAfter: "2026-07-14T06:00:00.000Z",
    startedBefore: "2026-07-14T07:00:00.000Z",
  });
  const payload = JSON.parse(chunks.join(""));
  expect(payload.timeWindow).toEqual({
    from: "2026-07-14T06:00:00.000Z",
    to: "2026-07-14T07:00:00.000Z",
  });
  expect(payload.executions.map((row: any) => row.id)).toEqual(["5"]);
});

test("runExecutions keeps the public API path without time options", async () => {
  let publicCalls = 0;
  const fakeClient = {
    listExecutions: async () => {
      publicCalls++;
      return { data: [], nextCursor: null };
    },
    listExecutionsInternal: async () => {
      throw new Error("internal REST should not be used");
    },
  };
  await runExecutions(
    "WF",
    { json: true, quiet: true, limit: "20" },
    () => fakeClient as any,
    () => {
      throw new Error("session should not be created");
    },
  );
  expect(publicCalls).toBe(1);
});
