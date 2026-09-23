import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runTableRowsClear,
  runTableRowsDelete,
  runTableRowsInsert,
  runTableRowsList,
  runTableRowsUpdate,
  runTableRowsUpsert,
} from "../src/commands/table-rows";

// Public output contract exercised below (JSON mode):
//   list   -> { instance, rows: Record<string, unknown>[], count, nextCursor }
//   insert -> preview: { preview: true, operation, request: { data, returnType }, hint }
//             write:   { instance, ... }
//   update -> preview: { preview: true, operation, request: { filter, data }, hint }
//             dryRun:  { instance, dryRun: true,  persisted: false, ... }
//             write:   { instance, dryRun: false, persisted: true,  ... }
//   upsert -> same envelope as update, but backed by upsertDataTableRow only.
//   delete -> preview: { preview: true, operation, request: { filter }, hint }
//             dryRun:  { instance, dryRun: true,  persisted: false, ... }
//             write:   { instance, dryRun: false, persisted: true,  ... }
//   clear  -> preview: { preview: true, operation, request: { tableId }, hint }
//             write:   { instance, ... }
//
// Previews never call the client. A real n8n request is issued when --dry-run or
// --yes is supplied; unsupported flag combinations (and the list/insert/clear
// commands that do not support --dry-run) fail with `bad-arguments` before a
// client is resolved. The list page array is exposed under `rows` (the
// assertion tolerates `data`, the client page field name, as a fallback).

let home: string;

const VALID_FILTER = {
  type: "and",
  filters: [{ columnName: "id", condition: "eq", value: 7 }],
};
const VALID_FILTER_INLINE = JSON.stringify(VALID_FILTER);

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

function errorCode(stdout: string): string {
  return JSON.parse(stdout).error.code;
}

/** A client factory that must never be reached for rejected flag combinations. */
const neverClient = () => {
  throw new Error("client factory must not be resolved for invalid flags");
};

/** A client whose row methods throw, used to prove a validation path made no call. */
function countingClient(method: string): {
  client: Record<string, unknown>;
  calls: () => number;
} {
  let count = 0;
  return {
    client: {
      [method]: async () => {
        count++;
        throw new Error("unexpected API call");
      },
    },
    calls: () => count,
  };
}

function emittedRows(parsed: Record<string, unknown>): unknown[] {
  return (parsed.rows ?? parsed.data) as unknown[];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-rows-home-"));
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

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("runTableRowsList forwards the validated filter, limit, cursor and search and maps sort to sortBy", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    listDataTableRows: async (params: Record<string, unknown>) => {
      calls.push(params);
      return { data: [{ id: 1 }, { id: 2 }], nextCursor: "c2" };
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsList(
      "T1",
      {
        filterInline: VALID_FILTER_INLINE,
        sortBy: "createdAt:desc",
        search: "ada",
        limit: "25",
        cursor: "c1",
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    tableId: "T1",
    limit: 25,
    cursor: "c1",
    sortBy: "createdAt:desc",
    search: "ada",
    filter: VALID_FILTER,
  });
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(emittedRows(parsed)).toEqual([{ id: 1 }, { id: 2 }]);
  expect(parsed.count).toBe(2);
  // A plain list is a single page: the cursor is reported but not followed.
  expect(parsed.nextCursor).toBe("c2");
});

test("runTableRowsList reads the filter from a JSON file", async () => {
  const file = join(home, "filter.json");
  writeFileSync(file, `${JSON.stringify(VALID_FILTER)}\n`);
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    listDataTableRows: async (params: Record<string, unknown>) => {
      calls.push(params);
      return { data: [], nextCursor: null };
    },
  };

  const { result } = await captureStdout(() =>
    runTableRowsList("T1", { filterFile: file, json: true, quiet: true }, () =>
      client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0].filter).toEqual(VALID_FILTER);
});

test("runTableRowsList --all follows cursors until nextCursor is null", async () => {
  const pages = [
    { data: [{ id: 1 }, { id: 2 }], nextCursor: "c2" },
    { data: [{ id: 3 }], nextCursor: null },
  ];
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    listDataTableRows: async (params: Record<string, unknown>) => {
      calls.push(params);
      return pages[Math.min(calls.length - 1, pages.length - 1)];
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsList("T1", { all: true, json: true, quiet: true }, () =>
      client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls[0].cursor).toBeUndefined();
  expect(calls[1].cursor).toBe("c2");
  const parsed = JSON.parse(stdout);
  expect(emittedRows(parsed)).toHaveLength(3);
  expect(parsed.count).toBe(3);
  expect(parsed.nextCursor).toBeNull();
});

test("runTableRowsList --all stops at the 1000-row cap and preserves the final cursor", async () => {
  // Each page returns 500 records with a live nextCursor. The cap must stop the
  // run at exactly 1000 and surface the cursor that would fetch row 1001.
  let calls = 0;
  const client = {
    listDataTableRows: async () => {
      calls++;
      const start = (calls - 1) * 500;
      const data = Array.from({ length: 500 }, (_, i) => ({
        id: `r${start + i + 1}`,
      }));
      const nextCursor = calls < 4 ? `cursor-${calls}` : null;
      return { data, nextCursor };
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsList("T1", { all: true, json: true, quiet: true }, () =>
      client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toBe(2);
  const parsed = JSON.parse(stdout);
  expect(emittedRows(parsed)).toHaveLength(1000);
  expect(parsed.count).toBe(1000);
  expect(parsed.nextCursor).toBe("cursor-2");
});

test("runTableRowsList --all caps API pages at 250 without skipping rows", async () => {
  // A single 2000-row request would blow past the 1000-row cap. The API limit
  // must be clamped to the remaining capacity and the returned cursor must
  // resume exactly after the last emitted row.
  const TOTAL = 5000;
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    listDataTableRows: async (params: Record<string, unknown>) => {
      calls.push(params);
      const offset = params.cursor
        ? Number(String(params.cursor).replace("offset:", ""))
        : 0;
      const size = (params.limit as number | undefined) ?? TOTAL;
      const data = Array.from(
        { length: Math.max(0, Math.min(size, TOTAL - offset)) },
        (_, i) => ({ id: `r${offset + i + 1}` }),
      );
      const next = offset + data.length;
      return { data, nextCursor: next < TOTAL ? `offset:${next}` : null };
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsList(
      "T1",
      { all: true, limit: "2000", json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toHaveLength(4);
  expect(calls.map((call) => call.limit)).toEqual([250, 250, 250, 250]);
  const parsed = JSON.parse(stdout);
  const rows = emittedRows(parsed);
  expect(rows).toHaveLength(1000);
  expect((rows[999] as { id: string }).id).toBe("r1000");
  expect(parsed.nextCursor).toBe("offset:1000");
});

test("runTableRowsList rejects an invalid filter without calling the API", async () => {
  const { client, calls } = countingClient("listDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsList(
      "T1",
      {
        filterInline: '{"type":"and","filters":[]}',
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsList rejects a non-integer --limit without calling the API", async () => {
  const { client, calls } = countingClient("listDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsList("T1", { limit: "nope", json: true, quiet: true }, () =>
      client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsList rejects --limit 0 without calling the API", async () => {
  const { client, calls } = countingClient("listDataTableRows");
  const { result, stdout } = await captureStdout(() =>
    runTableRowsList("T1", { limit: "0", json: true, quiet: true }, () => client as never),
  );
  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsList rejects mixing --filter-file and --filter-json", async () => {
  const { client, calls } = countingClient("listDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsList(
      "T1",
      {
        filterFile: join(home, "filter.json"),
        filterInline: VALID_FILTER_INLINE,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsList rejects --dry-run as an unsupported option", async () => {
  const { result, stdout } = await captureStdout(() =>
    runTableRowsList(
      "T1",
      { dryRun: true, json: true, quiet: true },
      neverClient as never,
    ),
  );

  expect(result).toBe(2);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsList rejects --yes as an unsupported option", async () => {
  const { result, stdout } = await captureStdout(() =>
    runTableRowsList(
      "T1",
      { yes: true, json: true, quiet: true },
      neverClient as never,
    ),
  );

  expect(result).toBe(2);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

test("runTableRowsInsert previews an object row as a one-element array without writing", async () => {
  let calls = 0;
  const fake = {
    insertDataTableRows: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      {
        dataInline: '{"name":"Ada"}',
        returnType: "all",
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(parsed.preview).toBe(true);
  expect(parsed.request).toMatchObject({
    data: [{ name: "Ada" }],
    returnType: "all",
  });
  expect(parsed.hint).toContain("--yes");
});

test("runTableRowsInsert previews an array of rows without writing", async () => {
  let calls = 0;
  const fake = {
    insertDataTableRows: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      {
        dataInline: '[{"name":"Ada"},{"name":"Bob"}]',
        returnType: "id",
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
  expect(parsed.request).toMatchObject({
    data: [{ name: "Ada" }, { name: "Bob" }],
    returnType: "id",
  });
});

test("runTableRowsInsert defaults an omitted --return to count in the preview", async () => {
  const { client, calls } = countingClient("insertDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      { dataInline: '{"name":"Ada"}', json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls()).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.request).toEqual({
    data: [{ name: "Ada" }],
    returnType: "count",
  });
});

test("runTableRowsInsert maps --return to returnType and writes exactly once with --yes", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = {
    insertDataTableRows: async (
      _tableId: string,
      body: Record<string, unknown>,
    ) => {
      bodies.push(body);
      return { count: 1 };
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      {
        dataInline: '{"name":"Ada"}',
        returnType: "id",
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toEqual([{ data: [{ name: "Ada" }], returnType: "id" }]);
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
});

test("runTableRowsInsert reads rows from a JSON file and writes exactly once", async () => {
  const file = join(home, "rows.json");
  writeFileSync(file, `${JSON.stringify([{ name: "Ada" }, { name: "Bob" }])}\n`);
  const bodies: Array<Record<string, unknown>> = [];
  const client = {
    insertDataTableRows: async (
      _tableId: string,
      body: Record<string, unknown>,
    ) => {
      bodies.push(body);
      return { count: 2 };
    },
  };

  const { result } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      { dataFile: file, returnType: "all", yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toEqual([
    { data: [{ name: "Ada" }, { name: "Bob" }], returnType: "all" },
  ]);
});

test("runTableRowsInsert rejects an empty data array", async () => {
  const { client, calls } = countingClient("insertDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      { dataInline: "[]", returnType: "all", yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsInsert rejects a data array containing a non-object entry", async () => {
  const { client, calls } = countingClient("insertDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      {
        dataInline: "[1]",
        returnType: "all",
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsInsert rejects an unsupported returnType", async () => {
  const { client, calls } = countingClient("insertDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      {
        dataInline: '{"name":"Ada"}',
        returnType: "bogus",
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsInsert rejects --dry-run as an unsupported option", async () => {
  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      {
        dataInline: '{"name":"Ada"}',
        returnType: "all",
        dryRun: true,
        json: true,
        quiet: true,
      },
      neverClient as never,
    ),
  );

  expect(result).toBe(2);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsInsert rejects mixing --data-file and --data-json", async () => {
  const { client, calls } = countingClient("insertDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      {
        dataFile: join(home, "rows.json"),
        dataInline: '{"name":"Ada"}',
        returnType: "all",
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsInsert rejects invalid inline JSON", async () => {
  const { client, calls } = countingClient("insertDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsInsert(
      "T1",
      {
        dataInline: "{not json",
        returnType: "all",
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

test("runTableRowsUpdate previews the exact filter and row data without writing", async () => {
  let calls = 0;
  const fake = {
    updateDataTableRows: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(parsed.preview).toBe(true);
  expect(parsed.request).toMatchObject({
    filter: VALID_FILTER,
    data: { status: "done" },
  });
  expect(parsed.hint).toContain("--yes");
});

test("row update dry-run calls n8n without --yes and forces returned data", async () => {
  let body: unknown;
  const fake = {
    updateDataTableRows: async (_id: string, value: unknown) => {
      body = value;
      return [{ id: 7 }];
    },
  };
  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        dryRun: true,
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );
  expect(result).toBe(0);
  expect(body).toEqual({
    filter: VALID_FILTER,
    data: { status: "done" },
    returnData: true,
    dryRun: true,
  });
  expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, persisted: false });
});

test("runTableRowsUpdate --yes writes with dryRun false and the requested returnData", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = {
    updateDataTableRows: async (
      _tableId: string,
      body: Record<string, unknown>,
    ) => {
      bodies.push(body);
      return [{ id: 7 }];
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        returnData: true,
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(bodies).toEqual([
    {
      filter: VALID_FILTER,
      data: { status: "done" },
      returnData: true,
      dryRun: false,
    },
  ]);
  expect(JSON.parse(stdout)).toMatchObject({
    instance: "h.co",
    dryRun: false,
    persisted: true,
  });
});

test("runTableRowsUpdate rejects non-object row data", async () => {
  const { client, calls } = countingClient("updateDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      {
        dataInline: "[1,2]",
        filterInline: VALID_FILTER_INLINE,
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsUpdate rejects an empty filter", async () => {
  const { client, calls } = countingClient("updateDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: '{"type":"and","filters":[]}',
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsUpdate requires a filter", async () => {
  const { client, calls } = countingClient("updateDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      { dataInline: '{"status":"done"}', yes: true, json: true, quiet: true },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsUpdate rejects combining --yes and --dry-run before resolving a client", async () => {
  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        yes: true,
        dryRun: true,
        json: true,
        quiet: true,
      },
      neverClient as never,
    ),
  );

  expect(result).toBe(2);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsUpdate rejects mixing --data-file and --data-json", async () => {
  const { client, calls } = countingClient("updateDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      {
        dataFile: join(home, "data.json"),
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsUpdate rejects mixing --filter-file and --filter-json", async () => {
  const { client, calls } = countingClient("updateDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpdate(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterFile: join(home, "filter.json"),
        filterInline: VALID_FILTER_INLINE,
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

// ---------------------------------------------------------------------------
// upsert
// ---------------------------------------------------------------------------

test("runTableRowsUpsert previews the exact filter and row data without writing", async () => {
  let calls = 0;
  const fake = {
    upsertDataTableRow: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpsert(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(parsed.preview).toBe(true);
  expect(parsed.request).toMatchObject({
    filter: VALID_FILTER,
    data: { status: "done" },
  });
  expect(parsed.hint).toContain("--yes");
});

test("row upsert dry-run calls upsertDataTableRow exactly once and never falls back to list/update/insert", async () => {
  const bodies: unknown[] = [];
  let fallbacks = 0;
  const fake = {
    // The only legitimate row-write method for an upsert.
    upsertDataTableRow: async (_id: string, body: unknown) => {
      bodies.push(body);
      return [{ id: 7 }];
    },
    // Tripwires: any client-side lookup or fallback must fail loudly.
    listDataTableRows: async () => {
      fallbacks++;
      throw new Error("unexpected list fallback");
    },
    updateDataTableRows: async () => {
      fallbacks++;
      throw new Error("unexpected update fallback");
    },
    insertDataTableRows: async () => {
      fallbacks++;
      throw new Error("unexpected insert fallback");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpsert(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        dryRun: true,
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(fallbacks).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toEqual({
    filter: VALID_FILTER,
    data: { status: "done" },
    returnData: true,
    dryRun: true,
  });
  expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, persisted: false });
});

test("runTableRowsUpsert --yes writes once with dryRun false and no fallback", async () => {
  const bodies: unknown[] = [];
  let fallbacks = 0;
  const fake = {
    upsertDataTableRow: async (_id: string, body: unknown) => {
      bodies.push(body);
      return [{ id: 7 }];
    },
    listDataTableRows: async () => {
      fallbacks++;
      throw new Error("unexpected list fallback");
    },
    updateDataTableRows: async () => {
      fallbacks++;
      throw new Error("unexpected update fallback");
    },
    insertDataTableRows: async () => {
      fallbacks++;
      throw new Error("unexpected insert fallback");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpsert(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        returnData: true,
        yes: true,
        json: true,
        quiet: true,
      },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(fallbacks).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toEqual({
    filter: VALID_FILTER,
    data: { status: "done" },
    returnData: true,
    dryRun: false,
  });
  expect(JSON.parse(stdout)).toMatchObject({
    instance: "h.co",
    dryRun: false,
    persisted: true,
  });
});

test("runTableRowsUpsert rejects an empty filter", async () => {
  const { client, calls } = countingClient("upsertDataTableRow");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpsert(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: '{"type":"and","filters":[]}',
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsUpsert rejects combining --yes and --dry-run", async () => {
  const { result, stdout } = await captureStdout(() =>
    runTableRowsUpsert(
      "T1",
      {
        dataInline: '{"status":"done"}',
        filterInline: VALID_FILTER_INLINE,
        yes: true,
        dryRun: true,
        json: true,
        quiet: true,
      },
      neverClient as never,
    ),
  );

  expect(result).toBe(2);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

test("runTableRowsDelete previews the exact filter without writing", async () => {
  let calls = 0;
  const fake = {
    deleteDataTableRows: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsDelete(
      "T1",
      { filterInline: VALID_FILTER_INLINE, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(parsed.preview).toBe(true);
  expect(parsed.request).toMatchObject({ filter: VALID_FILTER });
  expect(parsed.hint).toContain("--yes");
});

test("runTableRowsDelete --dry-run sends the delete query with both booleans true", async () => {
  const queries: unknown[] = [];
  const fake = {
    deleteDataTableRows: async (_id: string, query: unknown) => {
      queries.push(query);
      return { deletedCount: 1 };
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsDelete(
      "T1",
      { filterInline: VALID_FILTER_INLINE, dryRun: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toEqual({
    filter: VALID_FILTER,
    returnData: true,
    dryRun: true,
  });
  expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, persisted: false });
});

test("runTableRowsDelete --yes sends the delete query with returnData and dryRun false", async () => {
  const queries: unknown[] = [];
  const fake = {
    deleteDataTableRows: async (_id: string, query: unknown) => {
      queries.push(query);
      return { deletedCount: 1 };
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsDelete(
      "T1",
      { filterInline: VALID_FILTER_INLINE, yes: true, json: true, quiet: true },
      () => fake as never,
    ),
  );

  expect(result).toBe(0);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toEqual({
    filter: VALID_FILTER,
    returnData: false,
    dryRun: false,
  });
  expect(JSON.parse(stdout)).toMatchObject({
    instance: "h.co",
    dryRun: false,
    persisted: true,
  });
});

test("runTableRowsDelete rejects an empty filter", async () => {
  const { client, calls } = countingClient("deleteDataTableRows");

  const { result, stdout } = await captureStdout(() =>
    runTableRowsDelete(
      "T1",
      {
        filterInline: '{"type":"and","filters":[]}',
        yes: true,
        json: true,
        quiet: true,
      },
      () => client as never,
    ),
  );

  expect(result).toBe(2);
  expect(calls()).toBe(0);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

test("runTableRowsDelete rejects combining --yes and --dry-run", async () => {
  const { result, stdout } = await captureStdout(() =>
    runTableRowsDelete(
      "T1",
      {
        filterInline: VALID_FILTER_INLINE,
        yes: true,
        dryRun: true,
        json: true,
        quiet: true,
      },
      neverClient as never,
    ),
  );

  expect(result).toBe(2);
  expect(errorCode(stdout)).toBe("bad-arguments");
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

test("runTableRowsClear previews the exact table and does not write", async () => {
  let calls = 0;
  const fake = {
    clearDataTableRows: async () => {
      calls++;
      throw new Error("unexpected");
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsClear("T1", { json: true, quiet: true }, () => fake as never),
  );

  expect(result).toBe(0);
  expect(calls).toBe(0);
  const parsed = JSON.parse(stdout);
  expect(parsed.instance).toBe("h.co");
  expect(parsed.preview).toBe(true);
  expect(parsed.request).toEqual({ tableId: "T1" });
  expect(parsed.hint).toContain("--yes");
});

test("runTableRowsClear --yes clears the table exactly once", async () => {
  const ids: string[] = [];
  const client = {
    clearDataTableRows: async (tableId: string) => {
      ids.push(tableId);
      return { deletedCount: 3 };
    },
  };

  const { result, stdout } = await captureStdout(() =>
    runTableRowsClear("T1", { yes: true, json: true, quiet: true }, () =>
      client as never,
    ),
  );

  expect(result).toBe(0);
  expect(ids).toEqual(["T1"]);
  expect(JSON.parse(stdout)).toMatchObject({ instance: "h.co" });
});

test("runTableRowsClear rejects --dry-run as an unsupported option", async () => {
  const { result, stdout } = await captureStdout(() =>
    runTableRowsClear(
      "T1",
      { dryRun: true, json: true, quiet: true },
      neverClient as never,
    ),
  );

  expect(result).toBe(2);
  expect(errorCode(stdout)).toBe("bad-arguments");
});
