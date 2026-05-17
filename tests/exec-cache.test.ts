import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionCached } from "../src/exec-cache";
import { execCachePath } from "../src/config";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-ec-"));
  process.env.N8N_LOCATE_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
});

function clientReturning(execution: any) {
  let calls = 0;
  return {
    getExecution: async () => {
      calls++;
      return execution;
    },
    callCount: () => calls,
  };
}

test("a finished execution is cached and reused on the next call", async () => {
  const client = clientReturning({ id: 9, finished: true, data: {} });
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: false });
  expect(existsSync(execCachePath("h.co", "9"))).toBe(true);
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: false });
  expect(client.callCount()).toBe(1);
});

test("an unfinished execution is not cached", async () => {
  const client = clientReturning({ id: 9, finished: false, data: {} });
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: false });
  expect(existsSync(execCachePath("h.co", "9"))).toBe(false);
});

test("refresh bypasses the cache and re-fetches", async () => {
  const client = clientReturning({ id: 9, finished: true, data: {} });
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: false });
  await getExecutionCached(client as any, "h.co", "9", { refresh: true, noCache: false });
  expect(client.callCount()).toBe(2);
});

test("noCache neither reads nor writes the cache", async () => {
  const client = clientReturning({ id: 9, finished: true, data: {} });
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: true });
  expect(existsSync(execCachePath("h.co", "9"))).toBe(false);
});
