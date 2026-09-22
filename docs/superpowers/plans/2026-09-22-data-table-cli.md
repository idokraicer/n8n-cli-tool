# Data Table CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API-key-only CLI commands for n8n Data Table metadata, rows, and columns.

**Architecture:** Add one validated Data Table domain module, typed methods on the existing public API client, focused table/row/column command handlers, and one nested Commander registration module. Every mutation emits an exact local preview unless `--yes` is present; row update, upsert, and filtered delete also support a real n8n `dryRun` request.

**Tech Stack:** TypeScript, Bun, `bun:test`, Commander 14, n8n public API v1.

**Spec:** `docs/superpowers/specs/2026-09-22-data-table-cli-design.md`

## Global constraints

- Use only `/api/v1/data-tables` with `X-N8N-API-KEY`. Never call `/rest` for this feature.
- Add no dependencies and preserve all existing commands.
- Expose only `string`, `number`, `boolean`, and `date` column types.
- Treat all decoded JSON and API responses as `unknown` at their boundaries.
- Preserve JSON stdout, stderr progress, `--quiet`, and exit codes 0, 1, and 2.
- Every mutation is a local no-request preview unless `--yes` is present.
- `--dry-run` on row update, upsert, and delete calls n8n with `dryRun=true` and `returnData=true`; it does not require `--yes`. Reject combining `--dry-run` with `--yes`.
- Never perform a live mutation while implementing or verifying this plan.

## Review focus

- An HTTP 204 success must return `null` instead of failing JSON parsing.
- Table list sends `filter` as JSON and `sortBy`; row list sends `filter`, `sortBy`, and `search`.
- Row delete sends its filter and flags as query parameters, not as a JSON body.
- File and inline JSON options are mutually exclusive, and write filters cannot be empty.
- Older table responses without `sizeBytes` remain valid.

---

### Task 1: Domain validation and public API client

**Files:**

- Create: `src/data-table.ts`
- Modify: `src/client.ts`
- Create: `tests/data-table.test.ts`
- Create: `tests/client-data-table.test.ts`

**Interfaces:**

```typescript
// src/data-table.ts
export const DATA_TABLE_COLUMN_TYPES = ["string", "number", "boolean", "date"] as const;
export type DataTableColumnType = (typeof DATA_TABLE_COLUMN_TYPES)[number];
export type DataTableFilterCondition = "eq" | "neq" | "like" | "ilike" | "gt" | "gte" | "lt" | "lte";
export interface DataTableFilterRule { columnName: string; condition: DataTableFilterCondition; value: unknown }
export interface DataTableFilter { type: "and" | "or"; filters: DataTableFilterRule[] }
export interface DataTableColumn { id: string; name: string; type: DataTableColumnType; index: number; dataTableId?: string; createdAt?: string; updatedAt?: string }
export interface DataTableColumnInput { name: string; type: DataTableColumnType; index?: number }
export interface DataTable { id: string; name: string; projectId: string; columns: DataTableColumn[]; createdAt: string; updatedAt: string; sizeBytes?: number }
export interface CursorPage<T> { data: T[]; nextCursor: string | null }

export function parseJsonOption(input: {
  file?: string;
  inline?: string;
  label: string;
  required: boolean;
}): unknown | undefined;
export function requireRecord(value: unknown, label: string): Record<string, unknown>;
export function requireRows(value: unknown, label: string): Record<string, unknown>[];
export function requireFilter(value: unknown, label: string): DataTableFilter;
export function requireColumns(value: unknown, label: string): DataTableColumnInput[];
export function requireColumnType(value: string): DataTableColumnType;
```

```typescript
// methods added to N8nClient
listDataTables(params: { limit?: number; cursor?: string; name?: string; sortBy?: string }): Promise<CursorPage<DataTable>>;
getDataTable(tableId: string): Promise<DataTable>;
createDataTable(body: { name: string; projectId?: string; columns: DataTableColumnInput[] }): Promise<DataTable>;
renameDataTable(tableId: string, name: string): Promise<DataTable>;
deleteDataTable(tableId: string): Promise<null>;
listDataTableRows(params: { tableId: string; limit?: number; cursor?: string; filter?: DataTableFilter; sortBy?: string; search?: string }): Promise<CursorPage<Record<string, unknown>>>;
insertDataTableRows(tableId: string, body: { data: Record<string, unknown>[]; returnType: "count" | "id" | "all" }): Promise<unknown>;
updateDataTableRows(tableId: string, body: { filter: DataTableFilter; data: Record<string, unknown>; returnData: boolean; dryRun: boolean }): Promise<unknown>;
upsertDataTableRow(tableId: string, body: { filter: DataTableFilter; data: Record<string, unknown>; returnData: boolean; dryRun: boolean }): Promise<unknown>;
deleteDataTableRows(tableId: string, query: { filter: DataTableFilter; returnData: boolean; dryRun: boolean }): Promise<unknown>;
clearDataTableRows(tableId: string): Promise<{ deletedCount: number }>;
listDataTableColumns(tableId: string): Promise<DataTableColumn[]>;
addDataTableColumn(tableId: string, body: DataTableColumnInput): Promise<DataTableColumn>;
updateDataTableColumn(tableId: string, columnId: string, body: { name?: string; index?: number }): Promise<DataTableColumn>;
deleteDataTableColumn(tableId: string, columnId: string): Promise<null>;
```

- [ ] **Step 1: Write domain validation tests.** Create `tests/data-table.test.ts` with this complete case matrix and a temporary JSON file created in `beforeEach`:

```typescript
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseJsonOption, requireColumnType, requireColumns, requireFilter, requireRecord, requireRows } from "../src/data-table";

let dir = "";
let jsonPath = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "n8n-table-test-"));
  jsonPath = join(dir, "input.json");
  writeFileSync(jsonPath, JSON.stringify({ value: 1 }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("parseJsonOption reads file or inline JSON and rejects conflicts", () => {
  expect(parseJsonOption({ file: jsonPath, label: "data", required: true })).toEqual({ value: 1 });
  expect(parseJsonOption({ inline: "{\"value\":2}", label: "data", required: true })).toEqual({ value: 2 });
  expect(() => parseJsonOption({ file: jsonPath, inline: "{}", label: "data", required: true })).toThrow(/only one/i);
  expect(() => parseJsonOption({ label: "data", required: true })).toThrow(/required/i);
  expect(parseJsonOption({ label: "filter", required: false })).toBeUndefined();
});

test("validators construct only supported records, rows, filters, columns, and types", () => {
  expect(requireRecord({ status: "active" }, "data")).toEqual({ status: "active" });
  expect(requireRows({ status: "active" }, "data")).toEqual([{ status: "active" }]);
  expect(requireRows([{ status: "active" }], "data")).toEqual([{ status: "active" }]);
  expect(requireFilter({ type: "and", filters: [{ columnName: "id", condition: "gte", value: 1 }] }, "filter").filters).toHaveLength(1);
  expect(requireColumns([{ name: "email", type: "string" }], "columns")).toEqual([{ name: "email", type: "string" }]);
  expect(requireColumnType("date")).toBe("date");
  expect(() => requireRecord([], "data")).toThrow(/object/i);
  expect(() => requireRows([], "data")).toThrow(/at least one/i);
  expect(() => requireFilter({ type: "and", filters: [] }, "filter")).toThrow(/at least one/i);
  expect(() => requireColumns([{ name: "payload", type: "json" }], "columns")).toThrow(/string.*number.*boolean.*date/i);
  expect(() => requireColumnType("json")).toThrow(/string.*number.*boolean.*date/i);
});
```

- [ ] **Step 2: Run the domain test and confirm RED.** Run `bun test tests/data-table.test.ts`. Expected failure: `Cannot find module '../src/data-table'`.

- [ ] **Step 3: Implement the domain module.** Validate every nested filter and column field before constructing the returned typed value. Throw `CliError("bad-arguments", message)` for file errors, invalid JSON, invalid shapes, unsupported conditions, empty write inputs, or conflicting options. Do not use `any` or unchecked casts.

- [ ] **Step 4: Run the domain test and confirm GREEN.** Run `bun test tests/data-table.test.ts`.

- [ ] **Step 5: Write client contract tests.** Create `tests/client-data-table.test.ts` using an injected fetch implementation. Cover every method in the interface above. Assert this exact wire matrix:

| Method | HTTP contract |
|---|---|
| `listDataTables` | `GET /api/v1/data-tables?limit=10&cursor=C&filter=%7B%22name%22%3A%22orders%22%7D&sortBy=name%3Aasc` |
| `getDataTable` | `GET /api/v1/data-tables/T%201` |
| `createDataTable` | `POST /api/v1/data-tables`, body includes `columns: []` |
| `renameDataTable` | `PATCH /api/v1/data-tables/T1`, body `{ "name": "New" }` |
| `deleteDataTable` | `DELETE /api/v1/data-tables/T1`, HTTP 204 returns `null` |
| `listDataTableRows` | `GET /api/v1/data-tables/T1/rows` with JSON `filter`, `sortBy`, `search`, `limit`, `cursor` |
| `insertDataTableRows` | `POST /api/v1/data-tables/T1/rows`, body uses `returnType` |
| `updateDataTableRows` | `PATCH /api/v1/data-tables/T1/rows/update`, JSON body |
| `upsertDataTableRow` | `POST /api/v1/data-tables/T1/rows/upsert`, JSON body |
| `deleteDataTableRows` | `DELETE /api/v1/data-tables/T1/rows/delete` with JSON `filter`, `returnData`, `dryRun` in query and no body |
| `clearDataTableRows` | `DELETE /api/v1/data-tables/T1/rows/clear` |
| `listDataTableColumns` | `GET /api/v1/data-tables/T1/columns`, response is a bare array |
| `addDataTableColumn` | `POST /api/v1/data-tables/T1/columns`, JSON body |
| `updateDataTableColumn` | `PATCH /api/v1/data-tables/T1/columns/C%201`, JSON body |
| `deleteDataTableColumn` | `DELETE /api/v1/data-tables/T1/columns/C1`, HTTP 204 returns `null` |

Use this representative test and repeat the same direct URL/method/body assertions for every matrix row:

```typescript
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
});
```

- [ ] **Step 6: Run client tests and confirm RED.** Run `bun test tests/client-data-table.test.ts`. Expected failures: methods do not exist, and an empty 204 response cannot be parsed.

- [ ] **Step 7: Implement safe success parsing and all client methods.** Change the final line of `N8nClient.request<T>` from `response.json()` to `parseResponseBody(response)`, returning `null` for an empty body. Serialize table name filters with `JSON.stringify({ name })`, row filters with `JSON.stringify(filter)`, and booleans with `String(value)`.

- [ ] **Step 8: Run focused and full tests.** Run `bun test tests/data-table.test.ts tests/client-data-table.test.ts`, then `bun test` and `bun run typecheck`.

- [ ] **Step 9: Commit.** Commit only Task 1 files with `feat: add data table API client`.

---

### Task 2: Table metadata commands and nested registration

**Files:**

- Create: `src/commands/table.ts`
- Create: `src/commands/register-table.ts`
- Modify: `src/cli.ts`
- Create: `tests/commands-table.test.ts`
- Create: `tests/cli-table.test.ts`

**Interfaces:**

```typescript
export function registerTable(program: Command, executeCommand: (
  opts: { json?: boolean; text?: boolean },
  fn: () => Promise<number>,
) => Promise<never>): void;
export async function runTableList(opts: TableListOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableGet(tableId: string, opts: CommonOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableCreate(name: string, opts: TableCreateOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableRename(tableId: string, name: string, opts: WriteOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableDelete(tableId: string, opts: WriteOpts, clientFactory?: ClientFactory): Promise<number>;
```

- [ ] **Step 1: Write failing handler tests.** In `tests/commands-table.test.ts`, capture stdout as existing command tests do. Cover: list sends `name` and `sortBy` to the typed client and follows cursors only with `--all`; get emits a table without requiring `sizeBytes`; create defaults to `columns: []`, validates file/inline columns, previews with zero API calls, and writes only with `--yes`; rename and delete preview exact targets and write only with `--yes`. Set the combined `--all` cap to 1,000 returned records and preserve the final `nextCursor` if the cap stops pagination.

```typescript
test("runTableCreate previews the exact request and does not write", async () => {
  let calls = 0;
  const fake = { createDataTable: async () => { calls++; throw new Error("unexpected"); } };
  const { result, stdout } = await captureStdout(() =>
    runTableCreate("Customers", { columnsInline: '[{"name":"email","type":"string"}]', json: true, quiet: true }, () => fake as never),
  );
  expect(result).toBe(0);
  expect(calls).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    preview: true,
    operation: "create-table",
    request: { name: "Customers", columns: [{ name: "email", type: "string" }] },
  });
});
```

- [ ] **Step 2: Confirm handler RED.** Run `bun test tests/commands-table.test.ts`. Expected failure: `../src/commands/table` is missing.

- [ ] **Step 3: Implement table handlers.** Resolve the configured instance for every command, use `requireIntOption` for limits, emit exact previews with `hint`, and call only the Task 1 client methods. Do not cache table metadata.

- [ ] **Step 4: Confirm handler GREEN.** Run `bun test tests/commands-table.test.ts`.

- [ ] **Step 5: Write failing Commander tests.** In `tests/cli-table.test.ts`, spawn the CLI with auto-update disabled. Assert `table --help` lists `list`, `get`, `create`, `rename`, `delete`, `rows`, and `columns`; `table list --help` lists `--limit`, `--cursor`, `--all`, `--name`, and `--sort`; each metadata mutation help includes `--yes`.

```typescript
test("table help exposes metadata and nested resource commands", async () => {
  const { stdout, exitCode } = await run(["table", "--help"]);
  expect(exitCode).toBe(0);
  for (const name of ["list", "get", "create", "rename", "delete", "rows", "columns"]) expect(stdout).toContain(name);
});
```

- [ ] **Step 6: Confirm Commander RED.** Run `bun test tests/cli-table.test.ts`. Expected failure: `table` is unknown.

- [ ] **Step 7: Register the command tree.** `registerTable` creates the singular `table` command and metadata subcommands. Each action calls `command.optsWithGlobals()` and passes the result to the injected `executeCommand`. Add `registerTable(program, execute)` in `src/cli.ts`. Create empty `rows` and `columns` parent commands now so Task 3 can attach children without changing the top-level contract.

- [ ] **Step 8: Verify and commit.** Run `bun test tests/commands-table.test.ts tests/cli-table.test.ts`, `bun test`, and `bun run typecheck`. Commit Task 2 files with `feat: add table metadata commands`.

---

### Task 3: Row and column commands

**Files:**

- Create: `src/commands/table-rows.ts`
- Create: `src/commands/table-columns.ts`
- Modify: `src/commands/register-table.ts`
- Create: `tests/commands-table-rows.test.ts`
- Create: `tests/commands-table-columns.test.ts`
- Modify: `tests/cli-table.test.ts`

**Interfaces:**

```typescript
export async function runTableRowsList(tableId: string, opts: RowsListOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableRowsInsert(tableId: string, opts: RowsInsertOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableRowsUpdate(tableId: string, opts: RowsWriteOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableRowsUpsert(tableId: string, opts: RowsWriteOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableRowsDelete(tableId: string, opts: RowsDeleteOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableRowsClear(tableId: string, opts: WriteOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableColumnsList(tableId: string, opts: CommonOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableColumnsAdd(tableId: string, name: string, type: string, opts: ColumnAddOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableColumnsUpdate(tableId: string, columnId: string, opts: ColumnUpdateOpts, clientFactory?: ClientFactory): Promise<number>;
export async function runTableColumnsDelete(tableId: string, columnId: string, opts: WriteOpts, clientFactory?: ClientFactory): Promise<number>;
```

- [ ] **Step 1: Write failing row tests.** Cover this exact behavior matrix in `tests/commands-table-rows.test.ts`:

| Command | Required validation | No flag | `--dry-run` | `--yes` |
|---|---|---|---|---|
| list | optional validated filter, integer limit | read API | invalid option | invalid option |
| insert | data object or non-empty array, returnType enum | local preview | invalid option | insert API |
| update | record data, non-empty filter | local preview | update API with both booleans true | update API with `returnData` option and `dryRun:false` |
| upsert | record data, non-empty filter | local preview | upsert API with both booleans true | upsert API with `returnData` option and `dryRun:false` |
| delete | non-empty filter | local preview | delete API query with both booleans true | delete API query with `returnData:false,dryRun:false` |
| clear | none | local preview | invalid option | clear API |

Also test that combining `--yes` and `--dry-run` throws `bad-arguments`, list maps `--sort` to `sortBy`, `--all` follows cursors up to 1,000 rows, and insert maps `--return` to `returnType`.

```typescript
test("row update dry-run calls n8n without --yes and forces returned data", async () => {
  let body: unknown;
  const fake = { updateDataTableRows: async (_id: string, value: unknown) => { body = value; return [{ id: 7 }]; } };
  const { result, stdout } = await captureStdout(() => runTableRowsUpdate("T1", {
    dataInline: '{"status":"done"}',
    filterInline: '{"type":"and","filters":[{"columnName":"id","condition":"eq","value":7}]}',
    dryRun: true, json: true, quiet: true,
  }, () => fake as never));
  expect(result).toBe(0);
  expect(body).toMatchObject({ dryRun: true, returnData: true });
  expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, persisted: false });
});
```

- [ ] **Step 2: Confirm row RED.** Run `bun test tests/commands-table-rows.test.ts`. Expected failure: row handler module is missing.

- [ ] **Step 3: Implement row handlers.** Parse all JSON at the command boundary with Task 1 helpers. Previews include the exact request body or query and make no API call. `--return-data` applies to real update and upsert calls; dry-run always overrides it to true. Reject unsupported flag combinations before resolving a client.

- [ ] **Step 4: Confirm row GREEN.** Run `bun test tests/commands-table-rows.test.ts`.

- [ ] **Step 5: Write failing column tests.** Cover bare-array listing; add type validation and non-negative optional index; update requiring at least one of name/index and permitting both; delete target preview; zero API calls without `--yes`; exactly one API call with `--yes`.

```typescript
test("column update can rename and move in one gated request", async () => {
  let body: unknown;
  const fake = { updateDataTableColumn: async (_table: string, _column: string, value: unknown) => { body = value; return { id: "C1", name: "email", type: "string", index: 0 }; } };
  const { result } = await captureStdout(() => runTableColumnsUpdate("T1", "C1", {
    name: "email", index: "0", yes: true, json: true, quiet: true,
  }, () => fake as never));
  expect(result).toBe(0);
  expect(body).toEqual({ name: "email", index: 0 });
});
```

- [ ] **Step 6: Confirm column RED.** Run `bun test tests/commands-table-columns.test.ts`. Expected failure: column handler module is missing.

- [ ] **Step 7: Implement column handlers.** Use `requireColumnType` and `requireIntOption`; reject a negative index through existing integer validation. Emit exact previews and use only Task 1 client methods.

- [ ] **Step 8: Confirm column GREEN.** Run `bun test tests/commands-table-columns.test.ts`.

- [ ] **Step 9: Write and run failing nested help tests.** Extend `tests/cli-table.test.ts` to assert all six row commands and four column commands, all JSON input flags, `--return`, `--return-data`, `--dry-run`, `--yes`, `--index`, and the `<type>` argument. Run it before registration and confirm missing subcommands.

- [ ] **Step 10: Register row and column children.** Attach handlers to the Task 2 parent commands. User-facing `--sort <column:direction>` becomes handler field `sortBy` and public query key `sortBy`. Use hyphenated CLI options and Commander camel-case properties.

- [ ] **Step 11: Verify and commit.** Run all three Task 3 test files, then `bun test` and `bun run typecheck`. Commit with `feat: add table row and column commands`.

---

### Task 4: Documentation and end-to-end read verification

**Files:**

- Modify: `README.md`
- Modify: `skills/n8n-helper/SKILL.md`
- Modify: `tests/cli-table.test.ts`

- [ ] **Step 1: Add failing documentation assertions.** Read both files in `tests/cli-table.test.ts` and assert they contain `n8n-helper table list`, `table rows update`, `table columns add`, `--yes`, `--dry-run`, and a statement that Data Table commands need only an API key.

- [ ] **Step 2: Confirm documentation RED.** Run `bun test tests/cli-table.test.ts`. Expected failure: the new command examples are absent.

- [ ] **Step 3: Document the final commands.** Add `table` to the README command table and compact examples for metadata, rows, columns, local previews, `--yes`, server dry-run, file/inline exclusivity, and API-key-only authentication. Mirror the operational subset in `skills/n8n-helper/SKILL.md`; keep detailed examples in README.

- [ ] **Step 4: Confirm documentation GREEN.** Run `bun test tests/cli-table.test.ts`.

- [ ] **Step 5: Run the complete automated verification.** Run `bun test` and `bun run typecheck`. Any failure, including an unrelated pre-existing failure, must be named before completion.

- [ ] **Step 6: Run CLI smoke checks.** Run help for `table`, all metadata children, `table rows`, all row children, `table columns`, and all column children with `N8N_HELPER_AUTO_UPDATE=0`.

- [ ] **Step 7: Run read-only live checks.** Against the configured instance, run `table list --limit 1 --json`. Use the returned ID only in memory to run `table get`, `table rows list --limit 1`, and `table columns list`. Report statuses and response keys without printing table names, IDs, row values, credentials, or private payloads. Do not run any mutation, including `--dry-run`, without separate scoped approval.

- [ ] **Step 8: Final self-review.** Confirm there are no placeholder comments or TODOs; client signatures match handler calls; every method/path/query/body matches the spec and current OpenAPI; every spec requirement has a test; `rg -n '/rest'` finds no Data Table implementation; and `git diff --check` passes.

- [ ] **Step 9: Commit.** Commit Task 4 files with `docs: document table commands`.
