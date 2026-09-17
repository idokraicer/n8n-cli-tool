import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-stop-"));
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

test("runStop previews explicit execution ids without sending stop requests", async () => {
  const stopModule = await import("../src/commands/stop").catch(() => null);
  expect(stopModule).not.toBeNull();
  if (!stopModule) return;

  let stopCalls = 0;
  const fakeClient = {
    stopExecution: async () => {
      stopCalls++;
      return { status: 200, body: null };
    },
  };
  const code = await stopModule.runStop(
    ["723605", "723606"],
    { json: true, quiet: true },
    () => fakeClient as any,
  );

  expect(code).toBe(0);
  expect(stopCalls).toBe(0);
});

test("runStop stops explicit ids only after --yes and reports failures", async () => {
  const stopModule = await import("../src/commands/stop").catch(() => null);
  expect(stopModule).not.toBeNull();
  if (!stopModule) return;

  const stopped: string[] = [];
  const fakeClient = {
    stopExecution: async (id: string) => {
      stopped.push(id);
      if (id === "723606") throw new Error("not active");
      return { status: 200, body: { data: { status: "canceled" } } };
    },
  };

  const code = await stopModule.runStop(
    ["723605", "723606"],
    { json: true, quiet: true, yes: true, concurrency: "1" },
    () => fakeClient as any,
  );

  expect(code).toBe(1);
  expect(stopped).toEqual(["723605", "723606"]);
});
