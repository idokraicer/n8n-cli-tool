import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectWorkflow,
  buildCatalog,
  readManifest,
  catalogExists,
  searchCatalog,
} from "../src/catalog";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-cat-"));
  process.env.N8N_HELPER_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
});

test("projectWorkflow keeps searchable fields and drops the node graph", () => {
  const row = projectWorkflow(
    {
      id: "WF",
      name: "Sales",
      active: true,
      isArchived: false,
      tags: [{ name: "sales" }],
      triggerCount: 1,
      createdAt: "C",
      updatedAt: "U",
      nodes: [
        { name: "Webhook", type: "n8n-nodes-base.webhook", parameters: { path: "p1" } },
      ],
    },
    "https://h.co",
  );
  expect(row.id).toBe("WF");
  expect(row.tags).toEqual(["sales"]);
  expect(row.webhooks[0].path).toBe("p1");
  expect(row.url).toBe("https://h.co/workflow/WF");
  expect((row as any).nodes).toBeUndefined();
});

const fakeClient = {
  listWorkflows: async (params: { cursor?: string }) => {
    if (!params.cursor) {
      return {
        data: [
          { id: "WF1", name: "Alpha", active: true, isArchived: false, tags: [], triggerCount: 0, createdAt: "C", updatedAt: "U", nodes: [] },
        ],
        nextCursor: "next",
      };
    }
    return {
      data: [
        { id: "WF2", name: "Beta", active: false, isArchived: false, tags: [], triggerCount: 0, createdAt: "C", updatedAt: "U", nodes: [] },
      ],
      nextCursor: null,
    };
  },
};

test("buildCatalog pages through all workflows and writes a manifest", async () => {
  const manifest = await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  expect(manifest.workflowCount).toBe(2);
  expect(catalogExists("h.co")).toBe(true);
  expect(readManifest("h.co")?.workflowCount).toBe(2);
});

test("searchCatalog matches by name substring", async () => {
  await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  const r = await searchCatalog("h.co", { query: "alph", limit: 50, offset: 0 });
  expect(r.totalMatches).toBe(1);
  expect(r.rows[0].id).toBe("WF1");
});

test("searchCatalog filters by active", async () => {
  await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  const r = await searchCatalog("h.co", { active: true, limit: 50, offset: 0 });
  expect(r.rows.every((row) => row.active)).toBe(true);
});

test("searchCatalog applies offset and limit", async () => {
  await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  const r = await searchCatalog("h.co", { limit: 1, offset: 1 });
  expect(r.totalMatches).toBe(2);
  expect(r.rows.length).toBe(1);
});
