import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRetry } from "../src/commands/retry";
import { CliError } from "../src/types";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-retry-"));
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_SESSION_COOKIE;
});

test("runRetry retries explicit ids and counts results", async () => {
  const retried: string[] = [];
  const fakeClient = {
    listExecutions: async () => ({ data: [], nextCursor: null }),
    retryExecution: async (id: string) => {
      retried.push(id);
      if (id === "3") throw Object.assign(new Error("nope"), { code: "n8n-error" });
      return { status: 200, body: { success: true } };
    },
  };
  const code = await runRetry(
    "WF",
    { json: true, quiet: true, ids: "1,2,3", concurrency: "2", limit: "10" },
    () => fakeClient as any,
  );
  expect(retried.sort()).toEqual(["1", "2", "3"]);
  expect(code).toBe(1); // one failure
});

test("runRetry dry-run lists candidates from listExecutions without calling retry", async () => {
  let retryCalls = 0;
  const fakeClient = {
    listExecutions: async () => ({
      data: [
        { id: 10, status: "error", startedAt: "2026-05-25T06:00:00Z" },
        { id: 11, status: "error", startedAt: "2026-05-25T07:00:00Z" },
      ],
      nextCursor: null,
    }),
    retryExecution: async () => {
      retryCalls++;
      return { status: 200, body: null };
    },
  };
  const code = await runRetry(
    "WF",
    {
      json: true,
      quiet: true,
      status: "error",
      startedAfter: "2026-05-25T00:00:00Z",
      dryRun: true,
      limit: "10",
      concurrency: "2",
    },
    () => fakeClient as any,
  );
  expect(retryCalls).toBe(0);
  expect(code).toBe(0);
});

test("runRetry uses the saved session cookie when none is passed", async () => {
  const cookies: (string | undefined)[] = [];
  const fakeClient = {
    listExecutions: async () => ({ data: [], nextCursor: null }),
    retryExecution: async (_id: string, opts: { cookie?: string }) => {
      cookies.push(opts.cookie);
      return { status: 200, body: null };
    },
  };
  const session = {
    hasCredentials: () => true,
    getCookie: async () => "n8n-auth=saved",
    refreshCookie: async () => "n8n-auth=saved",
  };
  const code = await runRetry(
    "WF",
    { json: true, quiet: true, ids: "1", concurrency: "1", limit: "10" },
    () => fakeClient as any,
    () => session,
  );
  expect(code).toBe(0);
  expect(cookies).toEqual(["n8n-auth=saved"]);
});

test("runRetry refreshes the session once on 401 and retries", async () => {
  const attempts: { id: string; cookie?: string }[] = [];
  const fakeClient = {
    listExecutions: async () => ({ data: [], nextCursor: null }),
    retryExecution: async (id: string, opts: { cookie?: string }) => {
      attempts.push({ id, cookie: opts.cookie });
      if (opts.cookie === "n8n-auth=stale") {
        throw new CliError("unauthorized", "HTTP 401");
      }
      return { status: 200, body: null };
    },
  };
  let refreshes = 0;
  const session = {
    hasCredentials: () => true,
    getCookie: async () => "n8n-auth=stale",
    refreshCookie: async () => {
      refreshes++;
      return "n8n-auth=fresh";
    },
  };
  const code = await runRetry(
    "WF",
    { json: true, quiet: true, ids: "1,2", concurrency: "1", limit: "10" },
    () => fakeClient as any,
    () => session,
  );
  expect(code).toBe(0);
  expect(refreshes).toBe(1);
  expect(attempts).toEqual([
    { id: "1", cookie: "n8n-auth=stale" },
    { id: "1", cookie: "n8n-auth=fresh" },
    { id: "2", cookie: "n8n-auth=fresh" },
  ]);
});

test("runRetry prefers an explicit --cookie over the saved session", async () => {
  const cookies: (string | undefined)[] = [];
  const fakeClient = {
    listExecutions: async () => ({ data: [], nextCursor: null }),
    retryExecution: async (_id: string, opts: { cookie?: string }) => {
      cookies.push(opts.cookie);
      return { status: 200, body: null };
    },
  };
  let sessionUsed = false;
  const session = {
    hasCredentials: () => true,
    getCookie: async () => {
      sessionUsed = true;
      return "n8n-auth=saved";
    },
    refreshCookie: async () => null,
  };
  await runRetry(
    "WF",
    {
      json: true,
      quiet: true,
      ids: "1",
      concurrency: "1",
      limit: "10",
      cookie: "n8n-auth=explicit",
    },
    () => fakeClient as any,
    () => session,
  );
  expect(sessionUsed).toBe(false);
  expect(cookies).toEqual(["n8n-auth=explicit"]);
});

test("runRetry respects --exclude", async () => {
  const retried: string[] = [];
  const fakeClient = {
    listExecutions: async () => ({ data: [], nextCursor: null }),
    retryExecution: async (id: string) => {
      retried.push(id);
      return { status: 200, body: null };
    },
  };
  await runRetry(
    "WF",
    { json: true, quiet: true, ids: "1,2,3,4", exclude: "2 4", concurrency: "2", limit: "10" },
    () => fakeClient as any,
  );
  expect(retried.sort()).toEqual(["1", "3"]);
});
