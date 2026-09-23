# Data Table CLI design

## Goal

Add complete n8n Data Table management to `n8n-helper` through the supported
public `/api/v1/data-tables` API. The feature must use the API key already
stored by `n8n-helper login`; it must not require an n8n browser session or
call editor-private `/rest` endpoints.

The CLI must support:

- creating, listing, reading, renaming, and deleting tables;
- reading and querying rows;
- inserting, updating, atomically upserting, deleting, and clearing rows; and
- listing, adding, renaming, reordering, and deleting columns.

## Command structure

The top-level command is the singular `table`. Nested command groups separate
table metadata from rows and columns.

```text
n8n-helper table list
n8n-helper table get <table-id>
n8n-helper table create <name>
n8n-helper table rename <table-id> <name>
n8n-helper table delete <table-id>

n8n-helper table rows list <table-id>
n8n-helper table rows insert <table-id>
n8n-helper table rows update <table-id>
n8n-helper table rows upsert <table-id>
n8n-helper table rows delete <table-id>
n8n-helper table rows clear <table-id>

n8n-helper table columns list <table-id>
n8n-helper table columns add <table-id> <name> <type>
n8n-helper table columns update <table-id> <column-id>
n8n-helper table columns delete <table-id> <column-id>
```

Table and column references use IDs in the first release. Name resolution is
out of scope because table names are unique only within a project and the
public API already exposes stable IDs.

## Public API mapping

| CLI operation | Method and path |
|---|---|
| `table list` | `GET /api/v1/data-tables` |
| `table get` | `GET /api/v1/data-tables/{tableId}` |
| `table create` | `POST /api/v1/data-tables` |
| `table rename` | `PATCH /api/v1/data-tables/{tableId}` |
| `table delete` | `DELETE /api/v1/data-tables/{tableId}` |
| `table rows list` | `GET /api/v1/data-tables/{tableId}/rows` |
| `table rows insert` | `POST /api/v1/data-tables/{tableId}/rows` |
| `table rows update` | `PATCH /api/v1/data-tables/{tableId}/rows/update` |
| `table rows upsert` | `POST /api/v1/data-tables/{tableId}/rows/upsert` |
| `table rows delete` | `DELETE /api/v1/data-tables/{tableId}/rows/delete` |
| `table rows clear` | `DELETE /api/v1/data-tables/{tableId}/rows/clear` |
| `table columns list` | `GET /api/v1/data-tables/{tableId}/columns` |
| `table columns add` | `POST /api/v1/data-tables/{tableId}/columns` |
| `table columns update` | `PATCH /api/v1/data-tables/{tableId}/columns/{columnId}` |
| `table columns delete` | `DELETE /api/v1/data-tables/{tableId}/columns/{columnId}` |

The client will reuse its existing API-key request path, timeout handling,
429 retry behavior, and `CliError` mapping.

## Inputs

### Table inputs

`table list` accepts:

- `--limit <n>` and `--cursor <cursor>` for pagination;
- `--all` to follow cursors up to a fixed safety cap;
- `--name <text>` to send a name filter; and
- `--sort <field:direction>` for n8n's supported table sorting.

`table create` accepts:

- `--project <project-id>` to create the table in a team project; omission
  uses the API user's personal project;
- `--columns <path>` for a JSON array of `{ "name", "type" }` objects; and
- `--columns-inline <json>` for the same array inline.

The first release exposes the four confirmed column types: `string`, `number`,
`boolean`, and `date`. Although one current OpenAPI request schema mentions
`json`, n8n's response schemas and shared Data Table types do not. The CLI will
not advertise `json` until the upstream contract is consistent and a live
instance confirms it.

### Row data

Commands that write rows accept exactly one of:

- `--data <path>`, where the file contains a JSON object or array as required
  by the operation; or
- `--data-inline <json>`.

`rows insert` accepts one object or an array and normalizes one object to a
single-element array. It also accepts `--return <count|id|all>`, defaulting to
`count`.

`rows update` and `rows upsert` require one data object. They accept
`--return-data` to return affected rows.

`rows upsert` is the atomic write operation. It sends one request to n8n's
public `/rows/upsert` endpoint and never performs a client-side read followed by
separate update or insert requests. n8n executes the match and update-or-insert
inside one database transaction, so concurrent callers cannot observe the
CLI splitting the operation into multiple writes.

### Row filters

Query, update, upsert, and delete commands accept exactly one of:

- `--filter <path>` containing a Data Table filter object; or
- `--filter-inline <json>`.

The filter shape is:

```json
{
  "type": "and",
  "filters": [
    { "columnName": "status", "condition": "eq", "value": "active" }
  ]
}
```

The supported public API conditions are `eq`, `neq`, `like`, `ilike`, `gt`,
`gte`, `lt`, and `lte`. `type` is `and` or `or`. Every write filter must contain
at least one condition. The CLI validates this before making a request.

`rows list` also accepts:

- `--limit <n>`, `--cursor <cursor>`, and `--all`;
- `--sort <column:direction>`; and
- `--search <text>` to search all string columns.

### Column inputs

`columns add` accepts `--index <n>` to place the new column at a zero-based
position. The type argument is one of the four confirmed types.

`columns update` requires at least one of:

- `--name <new-name>`; or
- `--index <n>`.

One request can rename and reorder the column together.

## Mutation safety

Every mutating command previews by default and performs no write. The JSON
preview names the instance, operation, target IDs, and exact request payload,
then tells the caller to repeat the command with `--yes`.

With `--yes`:

- create, insert, rename, column mutation, clear, and table deletion send the
  corresponding request once;
- row update, upsert, and filtered deletion send the real write request;
- row upsert always uses one public upsert request and has no read/update/insert
  fallback in the CLI;
- no command silently falls back to a private endpoint.

The public API supports `dryRun` for row update, upsert, and filtered delete.
The CLI exposes this separately as `--dry-run` for callers who want n8n to
evaluate the filter without committing. `--dry-run` sends the request without
requiring `--yes`, sets `dryRun: true`, requests returned rows, and labels the
output as a server-evaluated preview. This is different from the default local
preview, which makes no request.

`rows clear`, table deletion, and column deletion remain explicit `--yes`
operations because they permanently remove data and have no server dry-run.

## Output

The commands preserve the existing output contract:

- JSON is the default when stdout is piped;
- `--json` and `--text` remain global overrides;
- machine-readable output goes to stdout;
- progress goes to stderr and respects `--quiet`; and
- exit codes remain `0` for success, `1` for a normal partial or negative
  result, and `2` for argument, authentication, network, or API errors.

List responses preserve `nextCursor`. `--all` returns the combined data plus a
summary count and stops at a documented cap to prevent accidental unbounded
reads. Response parsing tolerates additive fields and older instances that do
not return newer metadata such as `sizeBytes`.

## Code organization

The implementation will add:

- Data Table types and public API methods in focused modules rather than
  expanding workflow-specific types;
- one command registration module that builds the nested Commander command
  tree;
- separate table, row, and column command handlers;
- shared JSON-file/inline parsing and filter validation helpers; and
- focused tests for client request contracts, argument validation, pagination,
  previews, write gating, and output envelopes.

`src/cli.ts` will register the `table` command group. `README.md` and
`skills/n8n-helper/SKILL.md` will document compact examples and the `--yes`
write rule.

No local table catalog or cache will be added. Data Table metadata and rows can
change outside this CLI, so each command reads live state from n8n.

## Verification

Implementation follows test-driven development:

1. Add failing client tests for every HTTP method, path, query, and body.
2. Add failing command tests for validation, preview behavior, and `--yes`.
3. Implement the smallest code that passes those tests.
4. Run the focused tests, the full `bun test` suite, and `bun run typecheck`.
5. Run read-only live checks against the configured instance for table list,
   table get, row filtering, and column listing.
6. Before any live mutation test, show the exact disposable table operation
   and obtain separate scoped approval. No live mutation is part of ordinary
   automated verification.

## Out of scope

- Editor-private `/rest` endpoints and browser-session authentication.
- CSV upload, import, and download.
- Data Table storage quota reporting.
- Resolving tables or columns by name.
- Changing a column's type. n8n does not expose that operation.
- A local Data Table cache.
