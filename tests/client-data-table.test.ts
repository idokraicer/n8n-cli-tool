import { test, expect } from "bun:test";
import { N8nClient } from "../src/client";
import type { DataTable } from "../src/data-table";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function clientWith(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): N8nClient {
  return new N8nClient({
    baseUrl: "https://h.co",
    apiKey: "K",
    fetchImpl,
  });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers as Record<string, string>) ?? {};
}

const sampleFilter = {
  type: "and" as const,
  filters: [{ columnName: "id", condition: "eq" as const, value: 7 }],
};

const sampleTable: DataTable = {
  id: "T1",
  name: "Orders",
  projectId: "P1",
  columns: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("listDataTables GETs data-tables with limit, cursor, name filter, and sort", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ data: [sampleTable], nextCursor: null });
  });

  const page = await client.listDataTables({
    limit: 10,
    cursor: "C",
    name: "orders",
    sortBy: "name:asc",
  });

  expect(seenUrl).toBe(
    "https://h.co/api/v1/data-tables?limit=10&cursor=C&filter=%7B%22name%22%3A%22orders%22%7D&sortBy=name%3Aasc",
  );
  expect(seenInit?.method ?? "GET").toBe("GET");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(page).toEqual({ data: [sampleTable], nextCursor: null });
});

test("getDataTable GETs the URL-encoded table id", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({
      id: "T 1",
      name: "Orders",
      projectId: "P1",
      columns: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  const table = await client.getDataTable("T 1");

  expect(seenUrl).toBe("https://h.co/api/v1/data-tables/T%201");
  expect(seenInit?.method ?? "GET").toBe("GET");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(table.name).toBe("Orders");
});

test("createDataTable POSTs a JSON body that includes columns", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ id: "T1", name: "New", columns: [] });
  });

  await client.createDataTable({
    name: "New",
    projectId: "P1",
    columns: [],
  });

  expect(seenUrl).toBe("https://h.co/api/v1/data-tables");
  expect(seenInit?.method).toBe("POST");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(headersOf(seenInit)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(seenInit?.body as string)).toEqual({
    name: "New",
    projectId: "P1",
    columns: [],
  });
});

test("renameDataTable PATCHes the table id with a name-only body", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ id: "T1", name: "New" });
  });

  await client.renameDataTable("T1", "New");

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe("https://h.co/api/v1/data-tables/T1");
  expect(seenInit?.method).toBe("PATCH");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(headersOf(seenInit)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(seenInit?.body as string)).toEqual({ name: "New" });
});

test("deleteDataTable DELETEs the table and returns null for a 204", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return emptyResponse(204);
  });

  const result = await client.deleteDataTable("T1");

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe("https://h.co/api/v1/data-tables/T1");
  expect(seenInit?.method).toBe("DELETE");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(result).toBeNull();
});

test("listDataTableRows GETs rows with JSON filter, sort, search, limit, and cursor", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ data: [{ id: 1 }], nextCursor: "N" });
  });

  const page = await client.listDataTableRows({
    tableId: "T1",
    limit: 5,
    cursor: "C",
    filter: sampleFilter,
    sortBy: "name:desc",
    search: "acme",
  });

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://h.co/api/v1/data-tables/T1/rows",
  );
  expect(JSON.parse(url.searchParams.get("filter")!)).toEqual(sampleFilter);
  expect(url.searchParams.get("sortBy")).toBe("name:desc");
  expect(url.searchParams.get("search")).toBe("acme");
  expect(url.searchParams.get("limit")).toBe("5");
  expect(url.searchParams.get("cursor")).toBe("C");
  expect(seenInit?.method ?? "GET").toBe("GET");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(page).toEqual({ data: [{ id: 1 }], nextCursor: "N" });
});

test("insertDataTableRows POSTs a JSON body that uses returnType", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ inserted: 1 });
  });

  await client.insertDataTableRows("T1", {
    data: [{ name: "a" }],
    returnType: "all",
  });

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe("https://h.co/api/v1/data-tables/T1/rows");
  expect(seenInit?.method).toBe("POST");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(headersOf(seenInit)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(seenInit?.body as string)).toEqual({
    data: [{ name: "a" }],
    returnType: "all",
  });
});

test("updateDataTableRows PATCHes rows/update with a JSON body", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ updated: 1 });
  });

  const body = {
    filter: sampleFilter,
    data: { name: "b" },
    returnData: true,
    dryRun: false,
  };
  await client.updateDataTableRows("T1", body);

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://h.co/api/v1/data-tables/T1/rows/update",
  );
  expect(seenInit?.method).toBe("PATCH");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(headersOf(seenInit)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(seenInit?.body as string)).toEqual(body);
});

test("upsertDataTableRow POSTs rows/upsert with a JSON body", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ id: 1 });
  });

  const body = {
    filter: sampleFilter,
    data: { name: "c" },
    returnData: false,
    dryRun: true,
  };
  await client.upsertDataTableRow("T1", body);

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://h.co/api/v1/data-tables/T1/rows/upsert",
  );
  expect(seenInit?.method).toBe("POST");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(headersOf(seenInit)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(seenInit?.body as string)).toEqual(body);
});

test("deleteDataTableRows sends filter and flags as query parameters", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse(true);
  });
  const filter = { type: "and" as const, filters: [{ columnName: "id", condition: "eq" as const, value: 7 }] };
  await client.deleteDataTableRows("T1", { filter, returnData: true, dryRun: true });
  const url = new URL(seenUrl);
  expect(url.pathname).toBe("/api/v1/data-tables/T1/rows/delete");
  expect(JSON.parse(url.searchParams.get("filter")!)).toEqual(filter);
  expect(url.searchParams.get("returnData")).toBe("true");
  expect(url.searchParams.get("dryRun")).toBe("true");
  expect(seenInit?.method).toBe("DELETE");
  expect(seenInit?.body).toBeUndefined();
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
});

test("clearDataTableRows DELETEs rows/clear and returns the deleted count", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ deletedCount: 3 });
  });

  const result = await client.clearDataTableRows("T1");

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://h.co/api/v1/data-tables/T1/rows/clear",
  );
  expect(seenInit?.method).toBe("DELETE");
  expect(seenInit?.body).toBeUndefined();
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(result).toEqual({ deletedCount: 3 });
});

test("listDataTableColumns GETs a bare array of columns", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse([
      { id: "C1", name: "email", type: "string", index: 0 },
    ]);
  });

  const columns = await client.listDataTableColumns("T1");

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://h.co/api/v1/data-tables/T1/columns",
  );
  expect(seenInit?.method ?? "GET").toBe("GET");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(Array.isArray(columns)).toBe(true);
  expect(columns).toEqual([
    { id: "C1", name: "email", type: "string", index: 0 },
  ]);
});

test("addDataTableColumn POSTs a JSON column body", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ id: "C2", name: "age", type: "number", index: 1 });
  });

  await client.addDataTableColumn("T1", { name: "age", type: "number" });

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://h.co/api/v1/data-tables/T1/columns",
  );
  expect(seenInit?.method).toBe("POST");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(headersOf(seenInit)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(seenInit?.body as string)).toEqual({
    name: "age",
    type: "number",
  });
});

test("updateDataTableColumn PATCHes the URL-encoded column id with a JSON body", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return jsonResponse({ id: "C 1", name: "age", type: "number", index: 2 });
  });

  await client.updateDataTableColumn("T1", "C 1", { name: "age", index: 2 });

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://h.co/api/v1/data-tables/T1/columns/C%201",
  );
  expect(seenInit?.method).toBe("PATCH");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(headersOf(seenInit)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(seenInit?.body as string)).toEqual({
    name: "age",
    index: 2,
  });
});

test("deleteDataTableColumn DELETEs the column and returns null for a 204", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return emptyResponse(204);
  });

  const result = await client.deleteDataTableColumn("T1", "C1");

  const url = new URL(seenUrl);
  expect(url.origin + url.pathname).toBe(
    "https://h.co/api/v1/data-tables/T1/columns/C1",
  );
  expect(seenInit?.method).toBe("DELETE");
  expect(headersOf(seenInit)["X-N8N-API-KEY"]).toBe("K");
  expect(result).toBeNull();
});
