import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTableCreate,
  runTableDelete,
  runTableGet,
  runTableList,
  runTableRename,
} from "../src/commands/table";
import type { CursorPage, DataTable } from "../src/data-table";

// Public output contract exercised below (JSON mode):
//   list   -> { instance, tables: DataTable[], count: number, nextCursor: string | null }
//   get    -> { instance, table: DataTable }
//   create -> preview: { preview: true, operation: "create-table", request: { name, columns }, hint }
//             write:   { instance, operation: "create-table", created: true, table: DataTable }
//   rename -> preview: { preview: true, operation: "rename-table", request: { tableId, name }, hint }
//             write:   { instance, operation: "rename-table", renamed: true, table: DataTable }
//   delete -> preview: { preview: true, operation: "delete-table", request: { tableId }, hint }
//             write:   { instance, operation: "delete-table", deleted: true, tableId }
// Preview envelopes never issue a client call; the write booleans require --yes.

let home: string;

function dataTable(overrides: Partial<DataTable> = {}): DataTable {
  return {
    id: "t1",
    name: "Customers",
    projectId: "p1",
    columns: [
      { id: "c1", name: "email", type: "string", index: 0, dataTableId: "t1" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string }> {
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-table-home-"));
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_API_KEY = "K";
  process.env.N8N_BASE_URL = "https://h.co";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_BASE_URL;
});

test("runTableList maps --name/--sort to the typed client and issues one page by default", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const page: CursorPage<DataTable> = {
    data: [dataTable(), dataTable({ id: "t2", name: "Orders" })],
    nextCursor: "c2",
  };
  const client = {
    listDataTables: async (params: Record<string, unknown>) => {
      calls.push(params);
      return page;
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableList(
      { name: "Orders", sort: "name", limit: "25", json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ name: "Orders", sortBy: "name", limit: 25 });
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(parsed.tables).toHaveLength(2);
  expect(parsed.count).toBe(2);
  // A plain list is a single page: the cursor is reported but not followed.
  expect(parsed.nextCursor).toBe("c2");
});

test("runTableList --all follows cursors until nextCursor is null", async () => {
  const pages: Array<CursorPage<DataTable>> = [
    { data: [dataTable({ id: "t1" }), dataTable({ id: "t2" })], nextCursor: "c2" },
    { data: [dataTable({ id: "t3" })], nextCursor: null },
  ];
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    listDataTables: async (params: Record<string, unknown>) => {
      calls.push(params);
      return pages[Math.min(calls.length - 1, pages.length - 1)];
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableList({ all: true, json: true, quiet: true }, () => client as never),
  );

  expect(result).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[1].cursor).toBe("c2");
  const parsed = JSON.parse(stdout);
  expect(parsed.tables).toHaveLength(3);
  expect(parsed.count).toBe(3);
  expect(parsed.nextCursor).toBeNull();
});

test("runTableList --all stops at the 1000-record cap and preserves the final cursor", async () => {
  // Each page returns 500 records with a live nextCursor. The cap must stop the
  // run at exactly 1000 and surface the cursor that would fetch record 1001.
  let calls = 0;
  const client = {
    listDataTables: async () => {
      calls++;
      const start = (calls - 1) * 500;
      const data = Array.from({ length: 500 }, (_, i) =>
        dataTable({
          id: `t${start + i + 1}`,
          name: `Table ${start + i + 1}`,
        }),
      );
      const nextCursor = calls < 4 ? `cursor-${calls}` : null;
      return { data, nextCursor };
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableList({ all: true, json: true, quiet: true }, () => client as never),
  );

  expect(result).toBe(0);
  // 500 + 500 hits the cap; the third page must never be requested.
  expect(calls).toBe(2);
  const parsed = JSON.parse(stdout);
  expect(parsed.tables).toHaveLength(1000);
  expect(parsed.count).toBe(1000);
  // The final cursor is preserved so the caller can resume with --cursor.
  expect(parsed.nextCursor).toBe("cursor-2");
});

test("runTableList rejects a non-integer --limit without calling the API", async () => {
  let calls = 0;
  const client = {
    listDataTables: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableList({ limit: "nope", json: true, quiet: true }, () => client as never),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableGet emits a table without requiring sizeBytes", async () => {
  const ids: string[] = [];
  const client = {
    // No sizeBytes on the payload; the command must not depend on it.
    getDataTable: async (id: string) => {
      ids.push(id);
      return dataTable();
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableGet("t1", { json: true, quiet: true }, () => client as never),
  );

  expect(result).toBe(0);
  expect(ids).toEqual(["t1"]);
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(parsed.table.id).toBe("t1");
  expect(parsed.table.name).toBe("Customers");
  expect(parsed.table.columns).toHaveLength(1);
  expect("sizeBytes" in parsed.table).toBe(false);
});

test("runTableCreate previews the exact request and does not write", async () => {
  let calls = 0;
  const fake = {
    createDataTable: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };
  const { result, stdout } = await captureStdout(() =>
    runTableCreate(
      "Customers",
      {
        columnsInline: '[{"name":"email","type":"string"}]',
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );
  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.preview).toBe(true);
  expect(parsed.operation).toBe("create-table");
  expect(parsed.request).toEqual({
    name: "Customers",
    columns: [{ name: "email", type: "string" }],
  });
  expect(parsed.hint).toContain("--yes");
});

test("runTableCreate defaults columns to an empty array", async () => {
  let calls = 0;
  const fake = {
    createDataTable: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };
  const { result, stdout } = await captureStdout(() =>
    runTableCreate("Empty", { json: true, quiet: true }, () => fake as never),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.preview).toBe(true);
  expect(parsed.request).toEqual({ name: "Empty", columns: [] });
  expect(parsed.hint).toContain("--yes");
});

test("runTableCreate parses columns from a JSON file without writing", async () => {
  const file = join(home, "columns.json");
  writeFileSync(file, `${JSON.stringify([{ name: "amount", type: "number" }])}\n`);
  let calls = 0;
  const fake = {
    createDataTable: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableCreate(
      "Orders",
      { columnsFile: file, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.request).toEqual({
    name: "Orders",
    columns: [{ name: "amount", type: "number" }],
  });
});

test("runTableCreate --yes writes the parsed request exactly once", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = {
    createDataTable: async (body: Record<string, unknown>) => {
      bodies.push(body);
      return dataTable({ id: "t7", name: "Customers" });
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableCreate(
      "Customers",
      {
        columnsInline: '[{"name":"email","type":"string"}]',
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    name: "Customers",
    columns: [{ name: "email", type: "string" }],
  });
  const parsed = JSON.parse(stdout);
  expect(parsed.created).toBe(true);
  expect(parsed.table.id).toBe("t7");
  expect(parsed.table.name).toBe("Customers");
});

test("runTableCreate --yes writes default empty columns", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = {
    createDataTable: async (body: Record<string, unknown>) => {
      bodies.push(body);
      return dataTable({ id: "t8", name: "Empty", columns: [] });
    },
  };

  const { result } = await captureStdout(() =>
    runTableCreate(
      "Empty",
      { yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(bodies[0].columns).toEqual([]);
});

test("runTableCreate rejects an unsupported column type without calling the API", async () => {
  let calls = 0;
  const fake = {
    createDataTable: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableCreate(
      "Bad",
      {
        columnsInline: '[{"name":"x","type":"json"}]',
        yes: true,
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableCreate rejects mixing --columns-file and --columns-json", async () => {
  const file = join(home, "columns.json");
  writeFileSync(file, "[]\n");
  let calls = 0;
  const fake = {
    createDataTable: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableCreate(
      "Both",
      {
        columnsFile: file,
        columnsInline: "[]",
        yes: true,
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableRename previews the exact target and does not write", async () => {
  let calls = 0;
  const fake = {
    renameDataTable: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRename("t1", "Renamed", { json: true, quiet: true }, () => fake as never),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.preview).toBe(true);
  expect(parsed.operation).toBe("rename-table");
  expect(parsed.request).toEqual({ tableId: "t1", name: "Renamed" });
  expect(parsed.hint).toContain("--yes");
});

test("runTableRename --yes renames the table exactly once", async () => {
  const calls: Array<[string, string]> = [];
  const client = {
    renameDataTable: async (id: string, name: string) => {
      calls.push([id, name]);
      return dataTable({ id, name });
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRename(
      "t1",
      "Renamed",
      { yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toEqual([["t1", "Renamed"]]);
  const parsed = JSON.parse(stdout);
  expect(parsed.operation).toBe("rename-table");
  expect(parsed.renamed).toBe(true);
  expect(parsed.table.name).toBe("Renamed");
});

test("runTableDelete previews the exact target and does not write", async () => {
  let calls = 0;
  const fake = {
    deleteDataTable: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableDelete("t1", { json: true, quiet: true }, () => fake as never),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.preview).toBe(true);
  expect(parsed.operation).toBe("delete-table");
  expect(parsed.request).toEqual({ tableId: "t1" });
  expect(parsed.hint).toContain("--yes");
});

test("runTableDelete --yes deletes the table exactly once", async () => {
  const deleted: string[] = [];
  const client = {
    deleteDataTable: async (id: string) => {
      deleted.push(id);
      return null;
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableDelete("t1", { yes: true, json: true, quiet: true }, () => client as never),
  );

  expect(result).toBe(0);
  expect(deleted).toEqual(["t1"]);
  const parsed = JSON.parse(stdout);
  expect(parsed.operation).toBe("delete-table");
  expect(parsed.deleted).toBe(true);
  expect(parsed.tableId).toBe("t1");
});
