import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTableColumnsAdd,
  runTableColumnsDelete,
  runTableColumnsList,
  runTableColumnsUpdate,
} from "../src/commands/table-columns";
import type { DataTableColumn } from "../src/data-table";

// Public output contract exercised below (JSON mode):
//   list   -> { instance, columns: DataTableColumn[], count: number }
//             The columns endpoint returns a bare array, not a cursor page.
//   add    -> preview: { preview: true, operation: "add-column", request: { tableId, name, type, index? }, hint }
//             write:   { instance, operation: "add-column", added: true, column: DataTableColumn }
//   update -> preview: { preview: true, operation: "update-column", request: { tableId, columnId, name?, index? }, hint }
//             write:   { instance, operation: "update-column", updated: true, column: DataTableColumn }
//   delete -> preview: { preview: true, operation: "delete-column", request: { tableId, columnId }, hint }
//             write:   { instance, operation: "delete-column", deleted: true, tableId, columnId }
// Preview envelopes never issue a client call; the write booleans require --yes.
// `--type` is validated against the supported column types and `--index` must be
// a non-negative integer, both rejected before any client call is made.

let home: string;

function column(overrides: Partial<DataTableColumn> = {}): DataTableColumn {
  return {
    id: "c1",
    name: "email",
    type: "string",
    index: 0,
    dataTableId: "t1",
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
  home = mkdtempSync(join(tmpdir(), "n8n-helper-columns-home-"));
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

test("runTableColumnsList surfaces the bare array returned by the columns endpoint", async () => {
  // The columns endpoint returns a bare array (no cursor page); the handler must
  // not expect `{ data, nextCursor }`.
  const calls: string[] = [];
  const client = {
    listDataTableColumns: async (tableId: string) => {
      calls.push(tableId);
      return [
        column(),
        column({ id: "c2", name: "amount", type: "number", index: 1 }),
      ];
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsList("t1", { json: true, quiet: true }, () => client as never),
  );

  expect(result).toBe(0);
  expect(calls).toEqual(["t1"]);
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(parsed.columns).toHaveLength(2);
  expect(parsed.columns[0].name).toBe("email");
  expect(parsed.columns[1].name).toBe("amount");
});

test("runTableColumnsList treats an empty bare array as zero columns", async () => {
  const client = {
    listDataTableColumns: async () => [] as DataTableColumn[],
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsList("t1", { json: true, quiet: true }, () => client as never),
  );

  expect(result).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.columns).toEqual([]);
});

test("runTableColumnsAdd rejects an unsupported --type without calling the API", async () => {
  let calls = 0;
  const fake = {
    addDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsAdd(
      "t1",
      "email",
      "json",
      { yes: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableColumnsAdd rejects an empty --type without calling the API", async () => {
  let calls = 0;
  const fake = {
    addDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsAdd(
      "t1",
      "email",
      "",
      { yes: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableColumnsAdd --yes adds the column with a non-negative --index", async () => {
  const bodies: unknown[] = [];
  const client = {
    addDataTableColumn: async (_table: string, body: unknown) => {
      bodies.push(body);
      return column({ id: "c9", name: "amount", type: "number", index: 3 });
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsAdd(
      "t1",
      "amount",
      "number",
      { index: "3", yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toEqual([{ name: "amount", type: "number", index: 3 }]);
  const parsed = JSON.parse(stdout);
  expect(parsed.operation).toBe("add-column");
  expect(parsed.added).toBe(true);
  expect(parsed.column.id).toBe("c9");
});

test("runTableColumnsAdd omits --index from the column body when it is not given", async () => {
  const bodies: unknown[] = [];
  const client = {
    addDataTableColumn: async (_table: string, body: unknown) => {
      bodies.push(body);
      return column();
    },
  };

  const { result } = await captureStdout(() =>
    runTableColumnsAdd(
      "t1",
      "email",
      "string",
      { yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toEqual([{ name: "email", type: "string" }]);
});

test("runTableColumnsAdd rejects a negative --index without calling the API", async () => {
  let calls = 0;
  const fake = {
    addDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsAdd(
      "t1",
      "email",
      "string",
      { index: "-1", yes: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableColumnsAdd rejects a non-integer --index without calling the API", async () => {
  let calls = 0;
  const fake = {
    addDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsAdd(
      "t1",
      "email",
      "string",
      { index: "1.5", yes: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableColumnsAdd previews the column without --yes and makes zero API calls", async () => {
  let calls = 0;
  const fake = {
    addDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsAdd(
      "t1",
      "email",
      "string",
      { index: "2", json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.preview).toBe(true);
  expect(parsed.operation).toBe("add-column");
  expect(parsed.request).toMatchObject({
    tableId: "t1",
    name: "email",
    type: "string",
    index: 2,
  });
  expect(parsed.hint).toContain("--yes");
});

test("runTableColumnsUpdate rejects an update with neither --name nor --index", async () => {
  let calls = 0;
  const fake = {
    updateDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsUpdate(
      "T1",
      "C1",
      { yes: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableColumnsUpdate requires --name or --index even in preview mode", async () => {
  let calls = 0;
  const fake = {
    updateDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsUpdate("T1", "C1", { json: true, quiet: true }, () => fake as never),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableColumnsUpdate can rename with only --name", async () => {
  const bodies: unknown[] = [];
  const client = {
    updateDataTableColumn: async (_table: string, _column: string, body: unknown) => {
      bodies.push(body);
      return column();
    },
  };

  const { result } = await captureStdout(() =>
    runTableColumnsUpdate(
      "T1",
      "C1",
      { name: "email", yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toEqual([{ name: "email" }]);
});

test("runTableColumnsUpdate can move with only --index", async () => {
  const bodies: unknown[] = [];
  const client = {
    updateDataTableColumn: async (_table: string, _column: string, body: unknown) => {
      bodies.push(body);
      return column();
    },
  };

  const { result } = await captureStdout(() =>
    runTableColumnsUpdate(
      "T1",
      "C1",
      { index: "0", yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toEqual([{ index: 0 }]);
});

test("column update can rename and move in one gated request", async () => {
  const calls: Array<[string, string, unknown]> = [];
  const fake = {
    updateDataTableColumn: async (
      table: string,
      columnId: string,
      value: unknown,
    ) => {
      calls.push([table, columnId, value]);
      return { id: "C1", name: "email", type: "string", index: 0 };
    },
  };

  const { result } = await captureStdout(() =>
    runTableColumnsUpdate(
      "T1",
      "C1",
      { name: "email", index: "0", yes: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(["T1", "C1", { name: "email", index: 0 }]);
});

test("runTableColumnsUpdate rejects a negative --index without calling the API", async () => {
  let calls = 0;
  const fake = {
    updateDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsUpdate(
      "T1",
      "C1",
      { index: "-1", yes: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout).error.code).toBe("bad-arguments");
});

test("runTableColumnsUpdate previews the rename/move without --yes and makes zero API calls", async () => {
  let calls = 0;
  const fake = {
    updateDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsUpdate(
      "T1",
      "C1",
      { name: "email", index: "2", json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.preview).toBe(true);
  expect(parsed.operation).toBe("update-column");
  expect(parsed.request).toMatchObject({
    tableId: "T1",
    columnId: "C1",
    name: "email",
    index: 2,
  });
  expect(parsed.hint).toContain("--yes");
});

test("runTableColumnsDelete previews the exact target without --yes and makes zero API calls", async () => {
  let calls = 0;
  const fake = {
    deleteDataTableColumn: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsDelete("T1", "C1", { json: true, quiet: true }, () => fake as never),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.preview).toBe(true);
  expect(parsed.operation).toBe("delete-column");
  expect(parsed.request).toMatchObject({ tableId: "T1", columnId: "C1" });
  expect(parsed.hint).toContain("--yes");
});

test("runTableColumnsDelete --yes deletes exactly once and reports the target", async () => {
  const calls: Array<[string, string]> = [];
  const client = {
    deleteDataTableColumn: async (tableId: string, columnId: string) => {
      calls.push([tableId, columnId]);
      return null;
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableColumnsDelete(
      "T1",
      "C1",
      { yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toEqual([["T1", "C1"]]);
  const parsed = JSON.parse(stdout);
  expect(parsed.operation).toBe("delete-column");
  expect(parsed.deleted).toBe(true);
});
