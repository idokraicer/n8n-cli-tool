import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflows } from "../src/commands/workflows";
import { buildCatalog } from "../src/catalog";

let home: string;
const fakeClient = {
  listWorkflows: async () => ({
    data: [
      { id: "WF1", name: "Alpha", active: true, isArchived: false, tags: [], triggerCount: 0, createdAt: "C", updatedAt: "U", nodes: [] },
    ],
    nextCursor: null,
  }),
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-wf-"));
  process.env.N8N_LOCATE_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runWorkflows searches an existing catalog", async () => {
  await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  const code = await runWorkflows("alph", { json: true, quiet: true, limit: "50", offset: "0" }, () => fakeClient as any);
  expect(code).toBe(0);
});

test("runWorkflows errors when --no-sync is set and no catalog exists", async () => {
  await expect(
    runWorkflows(undefined, { json: true, quiet: true, sync: false, limit: "50", offset: "0" }, () => fakeClient as any),
  ).rejects.toMatchObject({ code: "no-catalog" });
});
