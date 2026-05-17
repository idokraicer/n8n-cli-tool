# n8n-locate CLI — Design

**Date:** 2026-05-17
**Status:** Approved (design), pending implementation plan

## Purpose

A command-line tool that helps autonomous agents (and humans) locate a specific
value inside an n8n workflow execution. Given a value and an n8n execution URL,
it fetches the execution data through the n8n public API and reports every
location where the value appears: which node produced it, which run, which item,
and the JSON path within that item.

Concrete motivating example:

```
n8n-locate search "500857721" "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694"
```

## Goals

- Pinpoint where a value occurs in an execution's data, with a precise path.
- Be agent-friendly: structured JSON output and meaningful exit codes.
- Be human-friendly: readable output when run interactively.
- Minimal dependencies, fast startup, runs on bun.

## Non-Goals (v1)

- Searching across multiple executions of a workflow ("which execution contains
  X"). Single-execution search only.
- Modifying or re-running executions.
- An MCP server interface.
- A persistent daemon or caching layer.

## Runtime & Tooling

- Language: TypeScript.
- Runtime: bun (executed via `bun run` / compiled entrypoint). Use `bunx` over
  `npx`, `bun` over `npm`.
- Argument parsing: Node standard library `util.parseArgs` (available in bun).
  No third-party CLI framework.
- Tests: `bun test`.

## CLI Surface

### Command: `search`

```
n8n-locate search <value> <execution-url> [options]
```

- `<value>` — the value to locate (string).
- `<execution-url>` — full n8n execution URL of the form
  `https://{host}/workflow/{workflowId}/executions/{executionId}`.

Options:

| Flag | Description | Default |
|------|-------------|---------|
| `--node <name>` | Restrict search to a single node by name. | all nodes |
| `--exact` | Match only when an entire string value equals the term. | off (substring) |
| `--regex` | Treat `<value>` as a regular expression. | off |
| `--case-sensitive` | Case-sensitive matching. | off (case-insensitive) |
| `--json` | Force JSON output. | auto (see Output) |
| `--text` | Force human-readable output. | auto (see Output) |
| `--help` | Show usage. | — |

`--exact`, `--regex`, and plain substring are mutually exclusive; supplying more
than one is an error (exit code 2).

## Configuration

- API key is read from the `N8N_API_KEY` environment variable.
- The base URL (host + scheme) is derived from the `<execution-url>` argument.
- Optional convenience: a config file at `~/.n8n-locate.json` mapping host →
  API key, so multiple n8n instances can be used without swapping env vars:

  ```json
  { "hosts": { "n8n.example.com": "n8n_api_key_here" } }
  ```

  Resolution order: `N8N_API_KEY` env var, then config file entry for the host.
  If neither yields a key, exit with code 2 and a clear message.

## Data Flow

1. **Parse URL** (`url.ts`): extract `{ scheme, host, workflowId, executionId }`
   from the execution URL. Reject malformed URLs with exit code 2.
2. **Resolve API key** (`config.ts`): env var, then config file, keyed by host.
3. **Fetch execution** (`client.ts`):
   `GET {scheme}://{host}/api/v1/executions/{executionId}?includeData=true`
   with header `X-N8N-API-KEY: {key}`.
4. **Normalize execution data** (`n8n-data.ts`): n8n returns execution data
   under `data.resultData.runData`, keyed by node name. Each node maps to an
   array of runs; each run has `data.main[<output>][<item>]`, where each item is
   `{ index, json: {...}, pairedItem, binary?: {...} }`. Only `json` and
   `binary` are searched; `index` and `pairedItem` are ignored. Some n8n
   versions return the top-level `data` field as a JSON string — detect and
   parse that fallback. Produce a flat list of searchable units:
   `{ node, runIndex, outputIndex, itemIndex, json, binary }`.
5. **Search** (`search.ts`): for each unit, recursively walk the `json` object,
   tracking the JSON path. Also search binary metadata fields (`fileName`,
   `mimeType`, `fileExtension`) but not base64 `data` blobs. Apply the selected
   match mode. Collect matches.
6. **Format & emit** (`format.ts`): print results, set exit code.

## Search Semantics

- Recursive walk over objects and arrays. Path segments use dot notation for
  object keys and bracket notation for array indices, rooted at `json`
  (e.g. `json.order.items[2].id`).
- A scalar value (string, number, boolean) matches when its string form
  satisfies the match mode against `<value>`:
  - substring (default): `haystack.includes(needle)`
  - `--exact`: `haystack === needle`
  - `--regex`: `new RegExp(value).test(haystack)`
  - `--case-sensitive` applies uniformly to all three modes. In regex mode,
    the default (case-insensitive) adds the `i` flag to the compiled regex;
    `--case-sensitive` omits it.
- Object keys are not searched, only values.
- Each match records: node name, run index, item index, JSON path, and the
  matched value.

## Output

Output mode is auto-detected: **JSON when stdout is not a TTY** (piped — how
agents invoke it), **human-readable when stdout is a TTY**. `--json` / `--text`
override.

### JSON output

```json
{
  "execution": {
    "id": "351694",
    "workflowId": "NDiulczinIqHUJJF",
    "status": "success",
    "host": "n8n.example.com"
  },
  "query": { "value": "500857721", "mode": "substring", "caseSensitive": false },
  "matches": [
    {
      "node": "HTTP Request",
      "runIndex": 0,
      "itemIndex": 2,
      "path": "json.order.id",
      "value": "500857721"
    }
  ],
  "summary": { "matchCount": 1, "nodesSearched": 8, "itemsSearched": 142 }
}
```

### Human-readable output

A short summary line followed by one line per match:

```
Execution 351694 (workflow NDiulczinIqHUJJF) — status: success
1 match for "500857721":

  HTTP Request  run 0  item 2  →  json.order.id
    500857721

Searched 8 nodes, 142 items.
```

## Error Handling & Exit Codes

| Exit | Meaning |
|------|---------|
| `0`  | Completed; at least one match found. |
| `1`  | Completed; no matches found. |
| `2`  | Error — invalid arguments/URL, missing API key, HTTP failure, execution not found, execution has no data. |

Specific error conditions surfaced with clear messages:

- Malformed execution URL.
- Missing/empty API key.
- HTTP 401 → invalid or unauthorized API key.
- HTTP 404 → execution not found.
- Execution returned without data (data pruned by n8n retention, or
  `includeData` not honored) → distinct message advising the execution may be
  too old.
- Network/timeout errors.

In JSON mode, errors are emitted as `{ "error": { "code": "...", "message": "..." } }`
to stdout (still exit code 2), so agents can parse the failure.

## Module Layout

```
src/
  cli.ts        Entry point: arg parsing, command dispatch, exit codes.
  url.ts        Parse n8n execution URL → { scheme, host, workflowId, executionId }.
  config.ts     Resolve API key (env var → ~/.n8n-locate.json).
  client.ts     n8n public API client: fetch execution by id.
  n8n-data.ts   Normalize execution data → flat list of searchable units.
  search.ts     Recursive JSON search with path tracking + match modes.
  format.ts     JSON and human-readable rendering.
  types.ts      Shared types (Match, SearchUnit, ExecutionInfo, etc.).
tests/
  url.test.ts
  search.test.ts
  n8n-data.test.ts
  config.test.ts
package.json
tsconfig.json
README.md
```

Each module has one purpose and a small interface. `client.ts` is the only
module performing I/O against n8n; `n8n-data.ts` and `search.ts` are pure
functions over data, making them straightforward to unit test without network
access.

## Testing Strategy

- `url.ts`: valid URLs, trailing slashes, missing segments, non-n8n URLs.
- `n8n-data.ts`: object-form `data`, stringified-`data` fallback, missing
  `runData`, multiple runs per node, multiple output branches, empty execution.
- `search.ts`: substring/exact/regex modes, case sensitivity, nested objects and
  arrays, numeric vs string values, path-string correctness, `--node` filter.
- `config.ts`: env var precedence, config-file lookup by host, missing key.
- `client.ts`: integration-style tests against a mocked fetch (401, 404, ok with
  data, ok without data).

## Verified Against Live Instance (2026-05-17)

Probed `n8n.example.com` execution `351694` with a public API key:

- `GET /api/v1/executions/{id}?includeData=true` with header `X-N8N-API-KEY`
  returns HTTP 200 with the full execution object.
- Top-level fields include `id`, `workflowId`, `status`, `mode`, `finished`,
  `startedAt`, `stoppedAt`, `data`, `workflowData`.
- `data` is returned as a JSON object on this instance (not stringified); the
  stringified fallback is still handled defensively for older n8n versions.
- `data.resultData.runData` is keyed by node name; each value is an array of
  runs; each run has `data.main[<output>][<item>]`; each item is
  `{ index, json, pairedItem }` (plus `binary` when binary data is present).
- Run objects also carry `metadata`, `source`, `executionStatus`,
  `executionTime`, `startTime` — not searched.

## Open Assumptions

- v1 searches a single execution; workflow-wide search is deferred.
- The `~/.n8n-locate.json` config file is a convenience and will be included
  only if it does not meaningfully expand scope; `N8N_API_KEY` is the baseline.
