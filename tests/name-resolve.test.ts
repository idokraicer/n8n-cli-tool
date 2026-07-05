import { test, expect } from "bun:test";
import { resolveWorkflowRef } from "../src/name-resolve";
import type { N8nClient } from "../src/client";
import type { WorkflowRow } from "../src/types";

type CatalogSearch = (
  host: string,
  q: { query?: string; field?: "id" | "name" | "webhook" | "tag"; limit: number; offset: number },
) => Promise<{ rows: WorkflowRow[]; totalMatches: number }>;

function row(id: string, name: string, url = `https://n8n.example.com/workflow/${id}`): WorkflowRow {
  return {
    id,
    name,
    active: true,
    isArchived: false,
    tags: [],
    triggerCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    webhooks: [],
    url,
  };
}

function fakeClient(pages: Array<{ data: Array<{ id: string; name: string }>; nextCursor: string | null }> = []) {
  return {
    getWorkflow: async (id: string) => ({
      id,
      name: id,
      nodes: [],
      connections: {},
    }),
    listWorkflows: async ({ cursor }: { limit?: number; cursor?: string }) => {
      if (!cursor) return pages[0] ?? { data: [], nextCursor: null };
      const index = Number(cursor);
      return pages[index] ?? { data: [], nextCursor: null };
    },
  } as unknown as N8nClient;
}

test("resolves a workflow URL without catalog or live scan", async () => {
  const catalogSearch: CatalogSearch = async () => {
    throw new Error("catalog should not be searched");
  };

  const ref = "https://n8n.example.com/workflow/WF_URL";
  await expect(
    resolveWorkflowRef(ref, {
      host: "n8n.example.com",
      client: fakeClient(),
      catalogSearch,
    }),
  ).resolves.toEqual({ id: "WF_URL", name: ref });
});

test("resolves a single exact catalog name match", async () => {
  const calls: Array<{ host: string; query?: string; field?: string; limit: number; offset: number }> = [];
  const catalogSearch: CatalogSearch = async (host, q) => {
    calls.push({ host, ...q });
    return { rows: [row("WF_CATALOG", "Nightly Sync")], totalMatches: 1 };
  };

  await expect(
    resolveWorkflowRef("Nightly Sync", {
      host: "n8n.example.com",
      client: fakeClient(),
      catalogSearch,
    }),
  ).resolves.toEqual({ id: "WF_CATALOG", name: "Nightly Sync" });
  expect(calls).toEqual([
    {
      host: "n8n.example.com",
      query: "Nightly Sync",
      field: "name",
      limit: 1000,
      offset: 0,
    },
  ]);
});

test("falls back to live workflow pages after catalog exact-name miss", async () => {
  const catalogSearch: CatalogSearch = async () => ({
    rows: [row("WF_PARTIAL", "Sales Daily Copy")],
    totalMatches: 1,
  });
  const client = fakeClient([
    { data: [{ id: "WF_OTHER", name: "Other" }], nextCursor: "1" },
    { data: [{ id: "WF_LIVE", name: "Sales Daily" }], nextCursor: null },
  ]);

  await expect(
    resolveWorkflowRef("Sales Daily", {
      host: "n8n.example.com",
      client,
      catalogSearch,
    }),
  ).resolves.toEqual({ id: "WF_LIVE", name: "Sales Daily" });
});

test("throws bad-arguments when exact catalog matches collide", async () => {
  const catalogSearch: CatalogSearch = async () => ({
    rows: [
      row("WF_ONE", "Duplicate", "https://n8n.example.com/workflow/WF_ONE"),
      row("WF_TWO", "Duplicate", "https://n8n.example.com/workflow/WF_TWO"),
    ],
    totalMatches: 2,
  });

  await expect(
    resolveWorkflowRef("Duplicate", {
      host: "n8n.example.com",
      client: fakeClient(),
      catalogSearch,
    }),
  ).rejects.toMatchObject({
    code: "bad-arguments",
    message:
      "Multiple workflows named 'Duplicate': WF_ONE (https://n8n.example.com/workflow/WF_ONE), WF_TWO (https://n8n.example.com/workflow/WF_TWO)",
    hint: expect.stringContaining("full workflow URL"),
  });
});

test("treats a ref with no name matches as a bare id", async () => {
  const catalogSearch: CatalogSearch = async () => ({ rows: [], totalMatches: 0 });
  const client = fakeClient([{ data: [{ id: "WF_OTHER", name: "Other" }], nextCursor: null }]);

  await expect(
    resolveWorkflowRef("WF_BARE", {
      host: "n8n.example.com",
      client,
      catalogSearch,
    }),
  ).resolves.toEqual({ id: "WF_BARE", name: "WF_BARE" });
});
