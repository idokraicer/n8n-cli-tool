# n8n-locate CLI — Design

**Date:** 2026-05-17
**Status:** Approved direction; expanded with disk-backed catalog, pending plan

## Purpose

A command-line tool that helps autonomous agents (and humans, via a future
Raycast wrapper) navigate n8n and locate data. It can:

- search **workflows** by id, name, webhook, or tag (partial) — fast, from a
  disk-backed local catalog;
- search **execution data** for a value (partial) inside one execution or
  across a workflow's recent executions;
- browse executions and extract data at a precise location.

All over the n8n public API.

Core motivating example:

```
n8n-locate search "500857721" "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694"
```

## Goals

- **Locate data precisely:** report which node, run, item, and JSON path a value
  appears at.
- **Fast workflow search:** find a workflow by id / name / webhook / tag from a
  local catalog, without re-hitting the API each time.
- **Memory-bounded:** large data lives on disk, not in memory. The workflow
  catalog is streamed line by line; execution payloads are cached to disk and
  searched one execution at a time. (Technique borrowed from the Raycast Make
  extension's disk catalog.)
- **Agent-first:** stable JSON contract, clean stdout/stderr separation,
  meaningful exit codes, output-size controls.
- **Raycast-ready:** list/search commands return presentation-agnostic JSON
  with canonical URLs; core modules are decoupled from the CLI so a future
  Raycast extension can shell out to the binary *or* import the modules.
- **Legible:** pretty-printed JSON output reads cleanly in a terminal; richer
  human formatting is a post-v1 enhancement.
- **Consistent with `make-fixer`:** `commander`, a `login` command writing
  global config, `--json` everywhere, URL-or-ID arguments.

## Non-Goals (v1)

- Modifying, deleting, or re-running executions or workflows (read-only tool).
- An MCP server interface.
- A background/daemon sync. `sync` is an explicit, foreground command.
- Cataloguing executions. Executions are volatile and numerous; they are
  listed live and cached only as individually fetched payloads.
- Searching credentials, users, or other non-execution resources.

## Runtime & Tooling

- Language: TypeScript. Runtime: bun. Use `bun`/`bunx`, never `npm`/`npx`.
- CLI framework: `commander` (matches `make-fixer`).
- API-response shape checks: lightweight manual guards; no schema library.
- Tests: `bun test`.
- Single runtime dependency: `commander`.
- `package.json` `bin`: `{ "n8n-locate": "./src/cli.ts" }`, shebang
  `#!/usr/bin/env bun`.

## Conventions for Agentic & Raycast Use

Contractual — agents and the Raycast wrapper depend on these.

1. **stdout/stderr separation.** In JSON mode, stdout carries *only* the single
   final JSON document. Progress, warnings, and human-readable errors go to
   stderr. `n8n-locate ... --json | jq` is always safe.
2. **Output.** All command data output is pretty-printed JSON on stdout. The
   `--json` / `--text` flags and TTY detection control how *errors* are
   presented — a JSON error envelope (piped or `--json`) or a plain stderr line
   (a TTY or `--text`). Dedicated human-formatted rendering of command data is
   a post-v1 enhancement; pretty-printed JSON stays legible in a terminal.
3. **Exit codes.** `0` success (`search`: success *with* ≥1 match); `1` =
   `search` only, success with zero matches; `2` any error.
4. **JSON error envelope.** On error in JSON mode, stdout receives
   `{ "error": { "code": "<code>", "message": "<text>", "details": {...} } }`
   and the process exits `2`.
5. **Canonical URLs.** Every workflow and execution in JSON output includes a
   `url` field to the n8n UI.
6. **Output-size control.** `search`/`get` cap and truncate by default;
   `--max-matches`, `--truncate`, `--out <file>` widen or redirect output.
7. **`--quiet`.** Suppresses stderr progress messages (errors still print).

## Configuration & On-Disk Layout

Everything lives under `~/.n8n-locate/`:

```
~/.n8n-locate/
  config.json                         credentials, multi-instance
  catalog/<host>/
    manifest.json                     sync metadata
    workflows.jsonl                   one WorkflowRow per line
  cache/<host>/executions/<id>.json   fetched execution payloads
```

`<host>` directory names are `encodeURIComponent`-encoded so ports/special
characters are safe.

`config.json` (created `0600`):

```json
{
  "defaultInstance": "n8n.example.com",
  "instances": {
    "n8n.example.com": {
      "baseUrl": "https://n8n.example.com",
      "apiKey": "<n8n public API key>"
    }
  }
}
```

The `login` command populates it. Environment variables override it (the
recommended path for agents and CI): `N8N_API_KEY`, `N8N_BASE_URL`. bun
auto-loads a working-directory `.env`, so a project-local `.env` with
`N8N_API_KEY` works without `login`.

**Resolution per invocation:**

1. **Target host:** from a URL argument if the command has one; else
   `--instance <host>`; else `N8N_BASE_URL`; else `defaultInstance`. If none
   resolve, exit `2` with code `no-credentials`.
2. **API key:** `N8N_API_KEY` env var if set (wins — supports agent/CI
   injection); else the config entry for the target host.
3. **Base URL:** from the URL argument; else the config entry; else
   `N8N_BASE_URL`.

## Workflow Catalog (disk-backed index)

The catalog makes workflow search fast and memory-bounded. It stores a
**flattened, searchable projection** of every workflow — never the full node
graph.

**`WorkflowRow`** (one per line in `workflows.jsonl`):

```json
{
  "id": "NDiulczinIqHUJJF",
  "name": "Sales AI Agent",
  "active": true,
  "isArchived": false,
  "tags": ["sales"],
  "triggerCount": 1,
  "createdAt": "2026-04-21T10:48:59.638Z",
  "updatedAt": "2026-05-17T09:25:04.000Z",
  "webhooks": [
    { "node": "Webhook", "method": "POST", "path": "abc-123",
      "productionUrl": "https://n8n.example.com/webhook/abc-123",
      "testUrl": "https://n8n.example.com/webhook-test/abc-123" }
  ],
  "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF"
}
```

`manifest.json`: `{ schemaVersion, instance, baseUrl, syncedAt, workflowCount }`.

**Build (`sync`):** page through `GET /workflows?limit=250&cursor=` (the list
response includes each workflow's `nodes`). For each workflow, project to a
`WorkflowRow`, extracting webhooks from its nodes (see below). Append rows to
`workflows.jsonl.tmp` as each page arrives — node graphs are never accumulated
in memory. After the last page, write `manifest.json.tmp`, then atomically
`rename` both `.tmp` files over the live files. A failed sync leaves the
previous catalog intact.

**Read/search:** stream `workflows.jsonl` line by line, parse one `WorkflowRow`
at a time, test it against the query, and collect matches up to `--limit`. The
full file is never loaded into memory.

**Webhook extraction:** from a workflow's `nodes`, select nodes whose `type` is
a known webhook trigger (`n8n-nodes-base.webhook`, `n8n-nodes-base.formTrigger`,
`@n8n/n8n-nodes-langchain.chatTrigger`) or that carry a `webhookId`. For each,
derive `path` from `parameters.path` (fallback: `webhookId`), `method` from
`parameters.httpMethod` (fallback `GET`), and build `productionUrl`
(`{baseUrl}/webhook/{path}`) and `testUrl` (`{baseUrl}/webhook-test/{path}`).

**Staleness:** `workflows` reads `manifest.syncedAt` and prints the catalog age
to stderr. If the catalog is missing it auto-runs `sync` first (stderr notice);
`--refresh` forces a sync before searching; `--no-sync` disables the auto-sync
and errors instead.

## Execution Cache (disk-backed payloads)

`search` and `get` fetch execution data with `includeData=true` (payloads run
to hundreds of KB). To stay memory-bounded and avoid re-fetching:

- A fetched execution is written to
  `cache/<host>/executions/<id>.json` and re-read from there on later runs.
- Only **finished** executions are cached; finished executions are immutable in
  n8n, so cache entries never expire. Running/waiting executions are always
  fetched live.
- `--refresh` forces a re-fetch; `--no-cache` skips reading and writing the
  cache.
- Workflow-wide `search` processes executions with a **bounded concurrency**
  (up to 5 in flight) — fetch (to cache) → parse → search → release. At most a
  few payloads are resident at once; only the small match records accumulate.

## CLI Surface

Binary: `n8n-locate`. Six commands. URL-or-ID arguments accepted everywhere an
n8n resource is referenced.

**Global options** (all commands): `--json`, `--text`, `--instance <host>`,
`--quiet`, `-h, --help`, `-V, --version`.

### `login`

```
n8n-locate login --url <base-url> [--key <api-key>] [--default]
```

- Prompts for `--key` on stdin if omitted (the `--key` flag or `N8N_API_KEY`
  is the normal path; the prompt is a convenience fallback).
- Validates the key with `GET /api/v1/workflows?limit=1` before saving.
- Writes/updates the host entry in `config.json`. The first instance saved
  becomes `defaultInstance`; `--default` re-points it.
- Exit `0` on success, `2` on validation failure.

### `sync`

```
n8n-locate sync [--instance <host>]
```

- Rebuilds the workflow catalog for the resolved instance (see Workflow
  Catalog).
- JSON: `{ instance, baseUrl, workflowCount, syncedAt, catalogPath }`.
- Exit `0`, `2` on error.

### `workflows`

```
n8n-locate workflows [query] [--field <f>] [--active]
                     [--limit <n>] [--offset <n>] [--refresh] [--no-sync]
```

- Searches the local catalog. `query` is matched case-insensitively as a
  substring against the workflow's **id, name, tags, and webhook paths/URLs**.
- `--field` ∈ `id | name | webhook | tag` restricts matching to one field.
- `--active` filters to active workflows.
- `--limit` (default `50`) and `--offset` (default `0`) page the results.
- `--refresh` syncs before searching; `--no-sync` disables auto-sync.
- JSON:
  ```json
  {
    "instance": "n8n.example.com",
    "catalog": { "syncedAt": "2026-05-17T09:00:00.000Z",
                 "workflowCount": 412, "ageSeconds": 3600 },
    "workflows": [ /* WorkflowRow objects */ ],
    "summary": { "totalMatches": 3, "returned": 3, "offset": 0 }
  }
  ```
- Exit `0` (even when empty), `2` on error.

### `executions`

```
n8n-locate executions <workflow-url-or-id> [--status <s>]
                      [--limit <n>] [--cursor <c>] [--all]
```

- Lists a workflow's executions live (not catalogued), newest first.
- `--status` ∈ `success | error | waiting`. `--limit` default `20`. `--cursor`
  fetches a page; `--all` auto-paginates up to a `1000`-item cap.
- JSON:
  ```json
  {
    "instance": "n8n.example.com",
    "workflow": { "id": "NDiulczinIqHUJJF",
      "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF" },
    "executions": [
      { "id": "358559", "status": "success", "mode": "manual",
        "finished": true,
        "startedAt": "2026-05-17T09:25:02.939Z",
        "stoppedAt": "2026-05-17T09:25:04.075Z",
        "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/358559" }
    ],
    "nextCursor": "eyJsYXN0SWQ...",
    "summary": { "count": 1 }
  }
  ```
- Exit `0`, `2` on error.

### `search`

```
n8n-locate search <value> <target> [options]
```

- `<value>` — the value to locate.
- `<target>` — an **execution** URL/ID (search that execution) **or** a
  **workflow** URL/ID (search across its recent executions).
- Options:

  | Flag | Description | Default |
  |------|-------------|---------|
  | `--node <name>` | Restrict to one node by name. | all nodes |
  | `--exact` | Match a whole string value, not a substring. | off |
  | `--regex` | Treat `<value>` as a regular expression. | off |
  | `--case-sensitive` | Case-sensitive matching. | off |
  | `--limit <n>` | Workflow target: how many recent executions to search. | `20` |
  | `--status <s>` | Workflow target: only executions of this status. | any |
  | `--max-matches <n>` | Stop after this many matches. | `100` |
  | `--context` | Include each match's immediate parent object. | off |
  | `--truncate <n>` | Max characters of a matched value to show. | `200` |
  | `--no-truncate` | Show full matched values. | off |
  | `--refresh` | Re-fetch execution(s), bypassing the disk cache. | off |
  | `--no-cache` | Do not read or write the execution cache. | off |
  | `--out <file>` | Write the JSON result to a file instead of stdout. | — |

  `--exact`, `--regex`, and plain substring are mutually exclusive.

- Workflow target: list executions (cheap), then fetch+search them with a
  bounded concurrency (up to 5 in flight), streaming through the disk cache.
- JSON:
  ```json
  {
    "query": { "value": "500857721", "mode": "substring",
               "caseSensitive": false },
    "scope": { "type": "execution", "executionId": "351694",
               "workflowId": "NDiulczinIqHUJJF" },
    "matches": [
      { "executionId": "351694", "node": "HTTP Request",
        "runIndex": 0, "outputIndex": 0, "itemIndex": 2,
        "path": "json.order.id", "value": "500857721",
        "valueType": "string",
        "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694",
        "context": { "id": "500857721", "status": "paid" } }
    ],
    "summary": { "matchCount": 1, "executionsSearched": 1,
                 "nodesSearched": 20, "itemsSearched": 142,
                 "truncated": false }
  }
  ```
  `context` appears only with `--context`. `summary.truncated` is `true` when
  `--max-matches` was hit.
- Exit `0` if ≥1 match, `1` if 0 matches, `2` on error.

### `get`

```
n8n-locate get <execution-url-or-id> [--node <name>] [--path <p>]
              [--run <n>] [--output <n>] [--item <n>]
              [--refresh] [--no-cache] [--out <file>]
```

- No flags → execution summary: metadata plus a per-node listing with run and
  item counts.
- `--node <name>` → that node's output items.
- `--path <p>` → value(s) at that JSON path (path syntax matches what `search`
  emits, rooted at `json`, e.g. `json.order.items[0].id`).
- `--run` / `--output` / `--item` → narrow to a specific run / output branch /
  item index.
- `--refresh` / `--no-cache` → control the execution cache (as for `search`).
- `--out <file>` → write JSON to a file (useful for large node dumps).
- JSON (summary form):
  ```json
  {
    "execution": { "id": "351694", "workflowId": "NDiulczinIqHUJJF",
      "status": "success", "mode": "trigger", "finished": true,
      "startedAt": "...", "stoppedAt": "...",
      "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694" },
    "nodes": [
      { "name": "When Executed by Another Workflow", "runs": 1,
        "items": 1, "status": "success" }
    ],
    "summary": { "nodeCount": 20, "lastNodeExecuted": "Edit Fields1" }
  }
  ```
- JSON (`--node` / `--path` form): `{ execution, node, items: [ { runIndex,
  outputIndex, itemIndex, value } ] }`, where `value` is the full item `json`
  when no `--path` is given, or the resolved value at the path otherwise.
- Exit `0`, `2` on error (including a path that resolves to nothing).

## Search Semantics

- Recursive walk over each searchable unit's `json` object (and binary metadata
  fields `fileName`, `mimeType`, `fileExtension` — not base64 `data` blobs).
- Path segments: dot notation for object keys, bracket notation for array
  indices, rooted at `json` (e.g. `json.order.items[2].id`).
- A scalar value (string, number, boolean) matches when its string form
  satisfies the mode against `<value>`:
  - substring (default): `haystack.includes(needle)`
  - `--exact`: `haystack === needle`
  - `--regex`: `new RegExp(value).test(haystack)`
- `--case-sensitive` applies uniformly to all three modes. In regex mode, the
  default (case-insensitive) adds the `i` flag; `--case-sensitive` omits it.
- Object keys are not searched, only values.
- Each match records: execution id, node, run/output/item indices, JSON path,
  value, value type, the execution URL, and (with `--context`) the parent
  object.

## n8n API Mapping

All requests carry header `X-N8N-API-KEY: <key>`; base path `/api/v1`.

| Need | Endpoint |
|------|----------|
| Validate key (`login`) | `GET /workflows?limit=1` |
| Build catalog (`sync`) | `GET /workflows?limit=250&cursor=` (includes `nodes`) |
| List executions | `GET /executions?workflowId=&status=&limit=&cursor=` |
| Get execution + data | `GET /executions/{id}?includeData=true` |

List responses are `{ data: [...], nextCursor: string | null }` with cursor
pagination. The client applies a request timeout and retries `429` responses
with exponential backoff (pattern borrowed from the Raycast extension's API
client).

## Execution Data Structure

(Verified against the live instance — see final section.)

- `execution.data` is an object (older n8n versions may return it as a JSON
  string; the normalizer detects and parses that fallback).
- `data.resultData.runData` is keyed by node name → array of runs.
- Each run: `data.main[<outputIndex>][<itemIndex>]`, plus `executionStatus`,
  `executionTime`, `startTime`, `source`, `metadata` (not searched).
- Each item: `{ index, json, pairedItem, binary? }`. Only `json` and `binary`
  metadata are searched.
- `n8n-data.ts` flattens this into searchable units
  `{ node, runIndex, outputIndex, itemIndex, json, binary }` and produces the
  per-node summary used by `get`.

## Error Handling & Exit Codes

| Exit | Meaning |
|------|---------|
| `0`  | Success (`search`: success with ≥1 match). |
| `1`  | `search` only: success, zero matches. |
| `2`  | Error. |

Stable error `code` values for the JSON envelope:

| Code | Cause |
|------|-------|
| `bad-arguments` | Invalid/missing/conflicting CLI arguments. |
| `bad-url` | Unparseable n8n URL. |
| `no-credentials` | No API key or base URL could be resolved. |
| `unauthorized` | HTTP 401 — invalid API key. |
| `forbidden` | HTTP 403 — key lacks access. |
| `not-found` | HTTP 404 — workflow/execution not found. |
| `no-execution-data` | Execution returned without data (pruned, or too old). |
| `no-catalog` | `workflows` ran with `--no-sync` and no catalog exists. |
| `rate-limited` | HTTP 429 persisted after retries. |
| `network-error` | Connection/timeout failure. |
| `n8n-error` | Any other non-2xx response. |

## Module Layout

```
src/
  cli.ts              commander setup; registers commands; maps errors to
                      exit codes and the JSON error envelope.
  commands/
    login.ts          login command.
    sync.ts           sync command.
    workflows.ts      workflows command (catalog search).
    executions.ts     executions command.
    search.ts         search command (execution + workflow targets).
    get.ts            get command.
  url.ts              parse n8n workflow/execution URLs; build canonical URLs.
  config.ts           load/save config.json; resolve instance, key, base URL,
                      catalog/cache dirs (with env-var override).
  client.ts           n8n API client: getExecution, listExecutions,
                      listWorkflows; timeout + 429 retry.
  catalog.ts          build catalog (atomic JSONL write), stream + filter
                      catalog rows, read/write manifest.
  webhooks.ts         extract webhook entries from a workflow's nodes.
  exec-cache.ts       read/write the on-disk execution payload cache.
  n8n-data.ts         normalize execution data → searchable units + node summary.
  search.ts           recursive JSON search with path tracking + match modes.
  paths.ts            parse/format/resolve JSON paths (powers get --path).
  format.ts           JSON and human rendering; stdout/stderr discipline.
  types.ts            shared types.
tests/
  url.test.ts  config.test.ts  search.test.ts  paths.test.ts
  n8n-data.test.ts  client.test.ts  catalog.test.ts  webhooks.test.ts
  exec-cache.test.ts
package.json  tsconfig.json  README.md
```

**Decoupling for the Raycast wrapper:** `url.ts`, `config.ts`, `client.ts`,
`catalog.ts`, `webhooks.ts`, `exec-cache.ts`, `n8n-data.ts`, `search.ts`, and
`paths.ts` are pure of CLI concerns (no `process.exit`, no console output) —
they take inputs and return values or throw typed errors. Only `cli.ts`,
`commands/*`, and `format.ts` touch the process. A future Raycast extension can
therefore shell out to the binary *or* import these modules directly.

## Testing Strategy

- `url.ts`: workflow URLs, execution URLs, bare IDs, trailing slashes,
  malformed input, canonical-URL construction.
- `config.ts`: resolution order, env-var override, multi-instance lookup,
  missing credentials, `0600` file create/update, catalog/cache path building.
- `catalog.ts`: row projection, atomic `.tmp`→live rename, streaming
  read/filter, manifest round-trip, staleness age.
- `webhooks.ts`: extraction from `webhook`, `formTrigger`, `chatTrigger`, and
  `webhookId`-bearing nodes; missing `path`/`httpMethod` fallbacks.
- `exec-cache.ts`: cache miss/hit, finished-only caching, `--refresh` and
  `--no-cache` behavior.
- `n8n-data.ts`: object-form `data`, stringified-`data` fallback, missing
  `runData`, multiple runs/output branches, empty execution, node summary.
- `search.ts`: substring/exact/regex modes, case sensitivity, nested
  objects/arrays, numeric vs string values, path-string correctness,
  `--node` filter, `--max-matches` truncation.
- `paths.ts`: path parsing, resolution against nested data, missing paths.
- `client.ts`: mocked `fetch` — 200 with/without data, 401, 403, 404,
  429-then-200 retry, timeout, cursor pagination.

## Verified Against Live Instance (2026-05-17)

Probed `n8n.example.com` with a public API key:

- `GET /api/v1/executions/{id}?includeData=true` → HTTP 200; `data` is a JSON
  object; structure is
  `data.resultData.runData[node][run].data.main[output][item]` with items
  `{ index, json, pairedItem }`.
- `GET /api/v1/workflows?limit=N` → HTTP 200, `{ data: [...], nextCursor }`;
  workflow items include `id, name, active, isArchived, tags, triggerCount,
  createdAt, updatedAt, nodes, connections` — so `sync` gets node graphs (and
  thus webhooks) directly from the list response, no per-workflow GET needed.
- `GET /api/v1/executions?workflowId=X&limit=N` → HTTP 200,
  `{ data: [...], nextCursor }`; execution items include `id, status, mode,
  finished, startedAt, stoppedAt, workflowId, retryOf, waitTill`.
- Cursor pagination confirmed (`nextCursor` is an opaque base64 token).
- The example value `500857721` does not occur in execution `351694`; that
  illustrates the invocation, not a guaranteed match (the CLI exits `1`).

## Open Assumptions

- Catalog `<host>` directory names are `encodeURIComponent`-encoded.
- Workflow-wide `search` fetches full execution data for up to `--limit`
  executions (default `20`), one at a time through the disk cache.
- The catalog has no automatic staleness expiry; `workflows` reports age and
  the user refreshes with `--refresh` or `sync`.
