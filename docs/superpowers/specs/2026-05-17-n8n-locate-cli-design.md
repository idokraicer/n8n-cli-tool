# n8n-locate CLI — Design

**Date:** 2026-05-17
**Status:** Approved (initial design); expanded per feedback, pending re-review

## Purpose

A command-line tool that helps autonomous agents (and humans, via a future
Raycast wrapper) navigate n8n and locate data inside workflow executions.
Given an n8n instance and a value, it can discover workflows, browse their
executions, search execution data for a value, and extract data at a precise
location — all over the n8n public API.

Core motivating example:

```
n8n-locate search "500857721" "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694"
```

## Goals

- **Locate data precisely:** report which node, run, item, and JSON path a value
  appears at.
- **Agent-first:** stable JSON contract, clean stdout/stderr separation,
  meaningful exit codes, output-size controls.
- **Raycast-ready:** list commands return paginated, presentation-agnostic JSON
  with canonical URLs; core data modules are decoupled from the CLI so a future
  Raycast extension can shell out to the binary *or* import the modules
  directly.
- **Human-friendly:** readable output when run interactively.
- **Consistent with `make-fixer`:** same conventions — `commander`, a `login`
  command writing global config, `--json` everywhere, URL-or-ID arguments.

## Non-Goals (v1)

- Modifying, deleting, or re-running executions or workflows (read-only tool).
- An MCP server interface.
- A persistent daemon or background sync.
- Searching credentials, users, or other non-execution resources.

## Runtime & Tooling

- Language: TypeScript. Runtime: bun. Use `bun`/`bunx`, never `npm`/`npx`.
- CLI framework: `commander` (matches `make-fixer`).
- Argument validation and API-response shape checks: lightweight manual guards;
  no schema library (execution `data` is too dynamic to model usefully).
- Tests: `bun test`.
- Single runtime dependency: `commander`.
- `package.json` `bin`: `{ "n8n-locate": "./src/cli.ts" }`, shebang
  `#!/usr/bin/env bun`.

## Conventions for Agentic & Raycast Use

These conventions are contractual — agents and the Raycast wrapper depend on
them.

1. **stdout/stderr separation.** In JSON mode, stdout carries *only* the single
   final JSON document. All progress messages, warnings, and human-readable
   errors go to stderr. This makes `n8n-locate ... --json | jq` always safe.
   In text mode, stdout carries human output; progress still goes to stderr.
2. **Output mode.** JSON when stdout is not a TTY (piped — how agents and
   Raycast invoke it); human-readable when stdout is a TTY. `--json` / `--text`
   force the mode.
3. **Exit codes.**
   - `0` — success. For `search`: success *and* at least one match.
   - `1` — `search` only: completed successfully with zero matches.
   - `2` — any error (bad arguments, bad URL, missing/invalid credentials, HTTP
     failure, resource not found, no execution data).
4. **JSON error envelope.** On error in JSON mode, stdout receives
   `{ "error": { "code": "<code>", "message": "<text>", "details": {...} } }`
   and the process exits `2`. `code` is a stable machine string (see Error
   Handling).
5. **Canonical URLs.** Every workflow and execution in any JSON output includes
   a `url` field pointing to the n8n UI, so agents and Raycast can link/open
   without reconstructing URLs.
6. **Output-size control.** Execution payloads are large (hundreds of KB).
   `search` and `get` cap and truncate output by default, with flags to widen
   or write full output to a file.
7. **`--quiet`.** Suppresses stderr progress messages (errors still print).

## Configuration

Credentials live in `~/.n8n-locate/config.json` (created with `0600`
permissions), supporting multiple n8n instances keyed by host:

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

The `login` command populates this file. Environment variables override it,
which is the recommended path for agents and CI:

- `N8N_API_KEY` — API key.
- `N8N_BASE_URL` — instance base URL.

bun auto-loads a `.env` file from the working directory, so a project-local
`.env` with `N8N_API_KEY` works without `login`.

**Resolution per invocation:**

1. **Target host:** from a URL argument if the command has one; else the
   `--instance <host>` flag; else `N8N_BASE_URL`; else `defaultInstance` from
   config. If none resolve, exit `2` with code `no-credentials`.
2. **API key:** `N8N_API_KEY` env var if set (wins — supports agent/CI
   injection); else the config entry for the target host.
3. **Base URL:** from the URL argument; else the config entry; else
   `N8N_BASE_URL`.

## CLI Surface

Binary: `n8n-locate`. Five commands. URL-or-ID arguments are accepted wherever
an n8n resource is referenced.

**Global options** (all commands): `--json`, `--text`, `--instance <host>`,
`--quiet`, `-h, --help`, `-V, --version`.

### `login`

```
n8n-locate login --url <base-url> [--key <api-key>] [--default]
```

- Prompts for `--key` with hidden input if omitted (as `make-fixer` does).
- Validates the key with `GET /api/v1/workflows?limit=1` before saving.
- Writes/updates the host entry in `~/.n8n-locate/config.json`.
- The first instance saved becomes `defaultInstance`; `--default` re-points it.
- Exit `0` on success, `2` on validation failure.

### `workflows`

```
n8n-locate workflows [query] [--active] [--limit <n>] [--cursor <c>] [--all]
```

- Lists workflows on the instance. `query` filters by name (case-insensitive
  substring, client-side) *within the fetched page(s)* — pair it with `--all`
  to filter across every workflow rather than just the first page.
- `--active` restricts to active workflows. `--limit` defaults to `20`
  (n8n max `250`). `--cursor` fetches a page; `--all` auto-paginates up to a
  `1000`-item cap.
- JSON:
  ```json
  {
    "instance": "n8n.example.com",
    "workflows": [
      { "id": "NDiulczinIqHUJJF", "name": "Sales AI Agent",
        "active": true, "isArchived": false,
        "tags": ["sales"], "triggerCount": 1,
        "updatedAt": "2026-05-17T09:25:04.000Z",
        "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF" }
    ],
    "nextCursor": "eyJsYXN0SWQ...",
    "summary": { "count": 1 }
  }
  ```
- Exit `0` (even when the list is empty), `2` on error.

### `executions`

```
n8n-locate executions <workflow-url-or-id> [--status <s>] [--limit <n>] [--cursor <c>] [--all]
```

- Lists recent executions for a workflow, newest first.
- `--status` ∈ `success | error | waiting` (n8n API filter). `--limit` defaults
  to `20`. `--cursor` / `--all` as for `workflows`.
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
- `<target>` — an **execution** URL/ID (search that one execution) **or** a
  **workflow** URL/ID (search across its recent executions).
- Options:

  | Flag | Description | Default |
  |------|-------------|---------|
  | `--node <name>` | Restrict to one node by name. | all nodes |
  | `--exact` | Match a whole string value, not a substring. | off |
  | `--regex` | Treat `<value>` as a regular expression. | off |
  | `--case-sensitive` | Case-sensitive matching (see semantics). | off |
  | `--limit <n>` | Workflow target: how many recent executions to search. | `20` |
  | `--status <s>` | Workflow target: only search executions of this status. | any |
  | `--max-matches <n>` | Stop after this many matches. | `100` |
  | `--context` | Include each match's immediate parent object. | off |
  | `--truncate <n>` | Max characters of a matched value to show. | `200` |
  | `--no-truncate` | Show full matched values. | off |
  | `--out <file>` | Write the JSON result to a file instead of stdout. | — |

  `--exact`, `--regex`, and plain substring are mutually exclusive.

- For a workflow target, executions are listed first (cheap), then fetched with
  data and searched with a small concurrency limit (5 in flight).
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
  `context` is present only with `--context`. `summary.truncated` is `true` when
  `--max-matches` was hit.
- Exit `0` if ≥1 match, `1` if 0 matches, `2` on error.

### `get`

```
n8n-locate get <execution-url-or-id> [--node <name>] [--path <p>]
              [--run <n>] [--output <n>] [--item <n>] [--out <file>]
```

- No flags → execution summary: metadata plus a per-node listing with run and
  item counts. This is the agent's "what's in here?" entry point.
- `--node <name>` → that node's output items.
- `--path <p>` → value(s) at that JSON path (path syntax matches what `search`
  emits, rooted at `json`, e.g. `json.order.items[0].id`). Applied per item
  unless narrowed.
- `--run` / `--output` / `--item` → narrow to a specific run / output branch /
  item index.
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
  default (case-insensitive) adds the `i` flag to the compiled regex;
  `--case-sensitive` omits it.
- Object keys are not searched, only values.
- Each match records: execution id, node, run/output/item indices, JSON path,
  value, value type, the execution URL, and (with `--context`) the parent
  object.

## n8n API Mapping

All requests carry header `X-N8N-API-KEY: <key>`; base path `/api/v1`.

| Need | Endpoint |
|------|----------|
| Validate key (`login`) | `GET /workflows?limit=1` |
| List workflows | `GET /workflows?limit=&cursor=&active=` |
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
  `{ node, runIndex, outputIndex, itemIndex, json, binary }` and also produces
  the per-node summary used by `get`.

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
| `no-execution-data` | Execution returned without data (pruned by retention, or too old). |
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
    workflows.ts      workflows command.
    executions.ts     executions command.
    search.ts         search command (execution + workflow targets).
    get.ts            get command.
  url.ts              parse n8n workflow and execution URLs; build canonical URLs.
  config.ts           load/save ~/.n8n-locate/config.json; resolve instance,
                      key, base URL (with env-var override).
  client.ts           n8n API client: getExecution, listExecutions,
                      listWorkflows, getWorkflow; timeout + 429 retry.
  n8n-data.ts         normalize execution data → searchable units + node summary.
  search.ts           recursive JSON search with path tracking + match modes.
  paths.ts            parse/format/resolve JSON paths (powers get --path).
  format.ts           JSON and human rendering; stdout/stderr discipline.
  types.ts            shared types.
tests/
  url.test.ts  config.test.ts  search.test.ts  paths.test.ts
  n8n-data.test.ts  client.test.ts
package.json  tsconfig.json  README.md
```

**Decoupling for the Raycast wrapper:** `url.ts`, `config.ts`, `client.ts`,
`n8n-data.ts`, `search.ts`, and `paths.ts` are pure of CLI concerns (no
`process.exit`, no console output) — they take inputs and return values or
throw typed errors. Only `cli.ts`, `commands/*`, and `format.ts` touch the
process. A future Raycast extension can therefore either shell out to the
`n8n-locate` binary and parse its JSON, or import these modules directly.

## Testing Strategy

- `url.ts`: workflow URLs, execution URLs, bare IDs, trailing slashes,
  malformed input, canonical-URL construction.
- `config.ts`: resolution order, env-var override, multi-instance lookup,
  missing credentials, file create/update with `0600`.
- `n8n-data.ts`: object-form `data`, stringified-`data` fallback, missing
  `runData`, multiple runs, multiple output branches, empty execution, node
  summary counts.
- `search.ts`: substring/exact/regex modes, case sensitivity, nested
  objects/arrays, numeric vs string values, path-string correctness,
  `--node` filter, `--max-matches` truncation.
- `paths.ts`: path parsing, resolution against nested data, missing paths.
- `client.ts`: mocked `fetch` — 200 with data, 200 without data, 401, 403,
  404, 429-then-200 retry, timeout, cursor pagination.

## Verified Against Live Instance (2026-05-17)

Probed `n8n.example.com` with a public API key:

- `GET /api/v1/executions/{id}?includeData=true` → HTTP 200 with the full
  execution object; `data` is a JSON object; structure is
  `data.resultData.runData[node][run].data.main[output][item]` with items
  `{ index, json, pairedItem }`.
- `GET /api/v1/workflows?limit=N` → HTTP 200, `{ data: [...], nextCursor }`;
  workflow items include `id, name, active, isArchived, tags, triggerCount,
  createdAt, updatedAt, nodes, connections`.
- `GET /api/v1/executions?workflowId=X&limit=N` → HTTP 200,
  `{ data: [...], nextCursor }`; execution items include `id, status, mode,
  finished, startedAt, stoppedAt, workflowId, retryOf, waitTill`.
- Cursor pagination confirmed (`nextCursor` is an opaque base64 token).
- The example value `500857721` does not occur in execution `351694`; that
  illustrates the invocation, not a guaranteed match (the CLI would exit `1`).

## Open Assumptions

- The `~/.n8n-locate/config.json` instance host key is the URL host (no port
  handling specified; ports, if present, are kept as part of the host string).
- Workflow-wide `search` fetches full execution data for up to `--limit`
  executions; the default of `20` balances coverage against payload volume.
