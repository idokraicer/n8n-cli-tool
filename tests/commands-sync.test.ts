import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../src/commands/sync";
import { catalogExists } from "../src/catalog";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-sync-"));
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

test("runSync builds a catalog for the resolved instance", async () => {
  const fakeClient = {
    listWorkflows: async () => ({
      data: [
        { id: "WF1", name: "Alpha", active: true, isArchived: false, tags: [], triggerCount: 0, createdAt: "C", updatedAt: "U", nodes: [] },
      ],
      nextCursor: null,
    }),
  };
  const code = await runSync({ json: true, quiet: true }, () => fakeClient as any);
  expect(code).toBe(0);
  expect(catalogExists("h.co")).toBe(true);
});
