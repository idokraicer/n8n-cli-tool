# n8n-helper Edit Loop — Design

**Date:** 2026-05-17
**Status:** Approved direction; pending plan
**Scope:** Sub-spec 1 of 3 (see Decomposition)

## Purpose

Extend `n8n-helper` from a read-only discovery tool into one that supports a
full **workflow edit loop**: pull a workflow's definition to disk, edit the
JSON (by hand or by an agent), validate the edit, and push it back — over the
n8n public API.

Today `n8n-helper` can locate workflows and search execution data but never
touches a workflow's definition. The sibling tool `make-fixer` already has this
loop for Make.com (`fetch` → edit → `validate` → `push`); this brings the
equivalent capability to n8n, adapted to n8n's data model.

Core motivating example:

```
n8n-helper pull NDiulczinIqHUJJF
# edit workflows/<host>/NDiulczinIqHUJJF.json
n8n-helper validate NDiulczinIqHUJJF
n8n-helper push NDiulczinIqHUJJF
```

## Decomposition

Full parity with `make-fixer` is split into three sequential sub-specs, each
with its own spec → plan → implementation cycle:

1. **Edit loop — `pull`, `validate`, `push`** *(this spec)*
2. **Analyze — `analyze`**: per-node error-handling flags (on/off only) and a
   token-minimal flow graph. No notes/documentation checks.
3. **Lifecycle — `activate`, `deactivate`, `create`, `delete`**.

Sub-specs 2 and 3 reuse the workflow-parsing and graph helpers built here, so
this sub-spec deliberately puts that logic in shared, CLI-pure modules.

## Goals

- **Pull definitions:** save a workflow's full JSON to disk for editing.
- **Validate edits — the core value.** Catch the breakage that hand/agent
  edits introduce, statically where possible:
  - references to **non-existent** nodes (e.g. a node renamed `Agent` →
    `AI Agent` leaves `$('Agent')` dangling);
  - references to nodes that exist but are **not upstream** of the referencing
    node (e.g. a connection path was cut, so `$('X')` can never receive X's
    data);
  - **stale `$json`** — a node whose immediate upstream changed (a node was
    inserted between two nodes, or a predecessor swapped), so its `$json.*`
    expressions now read from a different node;
  - a **diff** against the live workflow.
- **Push edits safely:** validate first, strip API-rejected read-only fields,
  confirm before writing.
- **Preserve agent-first conventions:** stable JSON contract, stdout/stderr
  separation, meaningful exit codes (see existing spec
  `2026-05-17-n8n-locate-cli-design.md`).
- **Build reusable foundations** for sub-specs 2 and 3.

## Non-Goals (this sub-spec)

- Quality analysis / the flow graph — sub-spec 2.
- `activate` / `deactivate` / `create` / `delete` — sub-spec 3.
- Running or testing a workflow.
- Resolving `$json` field names against runtime data. The stale-`$json` check
  is a static *which expressions to review* signal, not a schema check — the
  static JSON does not carry node output schemas.
- An MCP server interface.

## n8n Workflow Data Model

Verified shape of a workflow returned by `GET /api/v1/workflows/{id}`:

```jsonc
{
  "id": "NDiulczinIqHUJJF",          // read-only
  "name": "Sales AI Agent",
  "active": true,                     // read-only on PUT (separate endpoints)
  "nodes": [
    {
      "id": "b1f...-uuid",            // stable per node; survives a rename
      "name": "AI Agent",             // unique within the workflow
      "type": "@n8n/n8n-nodes-langchain.agent",
      "typeVersion": 1.7,
      "position": [640, 300],
      "parameters": { /* may contain expression strings */ },
      "credentials": { /* optional */ }
    }
  ],
  "connections": {
    "Webhook": { "main": [ [ { "node": "AI Agent", "type": "main", "index": 0 } ] ] }
  },
  "settings": { "executionOrder": "v1" },
  "staticData": null,
  "pinData": {},
  "tags": [ /* read-only on PUT */ ],
  "versionId": "...",                 // read-only
  "triggerCount": 1,                  // read-only
  "createdAt": "...",                 // read-only
  "updatedAt": "..."                  // read-only
}
```

Two properties of this model drive the whole design:

1. **`connections` is keyed by node *name*, not id.** Renaming a node without
   updating `connections` (and every `$('Name')` expression) silently breaks
   wiring. Node `id` is stable across a rename — which is what lets the diff
   detect a rename rather than a remove + add.
2. **`$json` resolves positionally.** `$json` is the input item of a node,
   i.e. the output of whatever node is connected to its **`main` input**.
   Insert a node between A and B and B's `$json` now reads A-through-the-new-
   node, not A. `$('Name')` instead resolves by name and requires `Name` to
   have executed — in static terms, to be an upstream ancestor.

## On-Disk Layout

Pulled workflow files are **project-relative** (you edit them, so they live in
the working directory, like `make-fixer`'s `blueprints/`), host-namespaced to
match how `~/.n8n-helper/` already namespaces `catalog/` and `cache/`:

```
./workflows/<host>/<workflowId>.json     full GET response, pretty-printed
```

`<host>` is `encodeURIComponent`-encoded. `--file <path>` overrides the
location for all three commands. The file is the raw n8n workflow JSON with no
added metadata, so it round-trips cleanly.

`pull` **overwrites** an existing file unconditionally — it is a fetch command
and agents depend on deterministic behavior. Users rely on git to preserve
in-progress edits.

## CLI Surface

Three new commands on the existing `n8n-helper` binary. Global options
(`--json`, `--text`, `--instance <host>`, `--quiet`) apply as for existing
commands. A workflow is referenced by URL or bare id everywhere.

### `pull`

```
n8n-helper pull <workflow-url-or-id> [--file <path>]
```

- `GET /workflows/{id}`, save the full response to
  `workflows/<host>/<id>.json` (or `--file`).
- JSON output:
  ```json
  {
    "instance": "n8n.example.com",
    "workflow": { "id": "NDiulczinIqHUJJF", "name": "Sales AI Agent",
      "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF" },
    "file": "workflows/n8n.example.com/NDiulczinIqHUJJF.json",
    "summary": { "nodeCount": 21, "active": true, "triggerNodes": ["Webhook"] }
  }
  ```
- Exit `0`; `2` on error.

### `validate`

```
n8n-helper validate <workflow-url-or-id> [--file <path>] [--local]
```

Reads the local file and runs the checks below. Without `--local` it also
`GET`s the live workflow for the diff and the remote-dependent checks.

**Local checks (always; the only checks under `--local`):**

1. **Parse** — file is valid JSON; `name` is a string, `nodes` an array,
   `connections` an object. A failure here is a hard error and the only check
   reported (the rest cannot run).
2. **Reference integrity** — for every node-name reference found in any node's
   `parameters` expressions (`$('Name')`, `$node["Name"]`, `$items("Name")`):
   - `Name` is not a node in `nodes[]` → **hard error**, reason
     `non-existent`.
   - `Name` exists but is **not a transitive upstream ancestor** of the
     referencing node in the connection graph → **hard error**, reason
     `not-upstream`.

**Remote checks (default; skipped under `--local`):**

3. **Diff** vs the live workflow — see Diff Semantics.
4. **Stale `$json`** — for each node present in both local and remote, compare
   its immediate `main`-input predecessor set. If it changed, every `$json`
   expression in that node is reported as a **warning** (reason
   `stale-json`) with the old and new predecessor names.
5. **Rename hint** — when a `non-existent` reference error names a node whose
   `id` still exists remotely under a different name, attach the new name as a
   `hint` ("renamed `Agent` → `AI Agent`").

JSON output:

```json
{
  "instance": "n8n.example.com",
  "workflow": { "id": "NDiulczinIqHUJJF",
    "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF" },
  "file": "workflows/n8n.example.com/NDiulczinIqHUJJF.json",
  "valid": false,
  "errors": [
    { "type": "broken-reference", "node": "Send Reply",
      "expression": "$('Agent')", "referencedNode": "Agent",
      "reason": "non-existent",
      "hint": "node was renamed 'Agent' -> 'AI Agent'" },
    { "type": "broken-reference", "node": "Format Output",
      "expression": "$('HTTP Request')", "referencedNode": "HTTP Request",
      "reason": "not-upstream" }
  ],
  "warnings": [
    { "type": "stale-json", "node": "Build Payload",
      "from": "Set", "to": "Normalize",
      "expressions": ["$json.orderId", "$json.email"] }
  ],
  "diff": {
    "nameChanged": false,
    "nodesAdded": ["Normalize"], "nodesRemoved": [],
    "nodesModified": ["AI Agent"],
    "nodesRenamed": [{ "id": "b1f...", "from": "Agent", "to": "AI Agent" }],
    "connectionsChanged": true, "settingsChanged": false
  },
  "summary": { "errorCount": 2, "warningCount": 1 }
}
```

Under `--local`, `diff` is omitted, `warnings` is empty, and `non-existent`
errors carry no `hint`.

- Exit `0` when `valid` (no hard errors); `1` when hard errors exist; `2` on
  an operational error (missing local file, network, auth). Warnings do not
  affect the exit code. *(Exit `1` already means "no result" for `search`;
  here it means "invalid" for `validate` — both are normal, non-envelope
  outcomes reported on stdout.)*

### `push`

```
n8n-helper push <workflow-url-or-id> [--file <path>] [--yes] [--force]
```

- Reads the local file and runs the full `validate` flow internally.
- If validation has **hard errors**, refuses unless `--force`. Warnings never
  block.
- Strips fields the n8n public API rejects on `PUT`, sending only
  `name`, `nodes`, `connections`, `settings` (and `staticData` when present).
  A missing `settings` is sent as `{}` (the API requires the field).
- In a TTY, prints a summary (`name`, node count, validation verdict) and
  prompts for confirmation; `--yes` skips the prompt. When stdout is not a TTY,
  `--yes` is required (an agent must opt in explicitly).
- `PUT /workflows/{id}` with the stripped body.
- JSON output:
  ```json
  {
    "instance": "n8n.example.com",
    "workflow": { "id": "NDiulczinIqHUJJF",
      "url": "https://n8n.example.com/workflow/NDiulczinIqHUJJF" },
    "pushed": true,
    "strippedFields": ["id","active","tags","versionId","triggerCount",
      "createdAt","updatedAt","pinData"],
    "validation": { "valid": true, "errorCount": 0, "warningCount": 1 }
  }
  ```
- Exit `0` on a successful push; `1` when refused due to validation hard
  errors without `--force`; `2` on an operational error — including `--yes`
  missing when stdout is not a TTY (`bad-arguments`).

## Reference & Graph Analysis

All of this lives in CLI-pure modules and is reused by sub-spec 2.

**Expression extraction.** An n8n parameter value is an expression when it is a
string beginning with `=`. Within expressions, node references are matched
with regexes over every string value in a node's `parameters` (walked
recursively):

- `$( '<name>' )` / `$( "<name>" )` — modern reference by name.
- `$node[ '<name>' ]` / `$node[ "<name>" ]` — legacy reference.
- `$items( '<name>' )` — legacy reference.
- `$json` (word-boundary match) — positional current-input reference.

The dot form `$node.NodeName` is a known gap (it cannot express names with
spaces and is rare); it is not matched. Recorded as an Open Assumption.

**Connection graph.** `connections[source][type][outputIndex]` is a list of
`{ node: target, type, index }`. Edges are `source → target`.

- *Ancestors* (for reference integrity): transitive predecessors of a node,
  computed by reverse traversal over **all** connection types — `main` plus AI
  types (`ai_languageModel`, `ai_tool`, `ai_memory`, `ai_outputParser`, …).
  Walking all types is deliberately conservative: an AI sub-node connects into
  its agent, so it correctly counts as an ancestor and references between them
  are not falsely flagged.
- *Immediate `main` predecessors* (for the stale-`$json` check): direct
  predecessors over the `main` connection type only, since `$json` is the
  main-input item.

**Reachability test.** A `$('Name')` reference in node B is valid iff `Name`
exists and `Name ∈ ancestors(B)`. If `Name` exists but is not an ancestor, the
referenced node is on a disconnected or sibling branch and its data cannot
reach B — reason `not-upstream`.

## Diff Semantics

Local file vs the live `GET /workflows/{id}`. Nodes are matched by stable
`id`:

- in remote only → **removed**; in local only → **added**;
- in both, name differs → **renamed** (also listed under modified);
- in both, any of `type` / `typeVersion` / `parameters` / `position` differs →
  **modified**.

Plus top-level flags: `nameChanged`, `connectionsChanged` (deep-equal of the
`connections` object), `settingsChanged`. The diff is reported for review and
feeds the stale-`$json` and rename-hint checks; it does not by itself produce
errors.

## n8n API Mapping

All requests carry `X-N8N-API-KEY: <key>`; base path `/api/v1`.

| Need | Endpoint |
|------|----------|
| Pull a workflow (`pull`, `validate`, `push`) | `GET /workflows/{id}` |
| Push a workflow (`push`) | `PUT /workflows/{id}` |

`PUT` body is `{ name, nodes, connections, settings, staticData? }` with
`Content-Type: application/json`. The existing client's private `request()` is
GET-only; it is generalized to accept `{ query?, method?, body? }`, and
`getWorkflow(id)` / `updateWorkflow(id, body)` are added. The timeout and
`429`-retry behavior already in the client is preserved.

## Error Handling & Exit Codes

| Exit | Meaning |
|------|---------|
| `0` | Success (`validate`: valid; `push`: pushed). |
| `1` | `validate`: invalid (hard errors). `push`: refused — validation hard errors without `--force`. Normal stdout result, not an error envelope. |
| `2` | Operational error (error envelope in JSON mode), including `--yes` missing when stdout is not a TTY. |

New stable error `code` values for the JSON error envelope:

| Code | Cause |
|------|-------|
| `no-local-file` | The local workflow file does not exist; suggests `pull`. |

Existing codes (`bad-arguments`, `bad-url`, `no-credentials`, `unauthorized`,
`forbidden`, `not-found`, `rate-limited`, `network-error`, `n8n-error`) are
reused. A local file that is not valid JSON or has the wrong top-level shape is
**not** an envelope error — it is a normal `validate` result with
`valid: false` and a `parse` error (exit `1`); `push` treats it as a refusal.

## Module Layout

New and changed modules (following the existing `commands/*` + helper-module
pattern):

```
src/
  commands/
    pull.ts             pull command.
    validate.ts         validate command.
    push.ts             push command.
  workflow-store.ts     local workflow file I/O; workflows/<host>/<id>.json
                        path resolution and --file override.
  workflow-data.ts      parse a workflow; list nodes; build the connection
                        graph (ancestors over all types, main predecessors);
                        extract expressions and node references.
  workflow-validate.ts  reference integrity, diff, stale-$json, rename hints;
                        assemble the ValidationResult.
  client.ts             (changed) generalized request(); getWorkflow,
                        updateWorkflow.
  types.ts              (changed) WorkflowDefinition, WorkflowNode,
                        ValidationResult, ValidationError, ValidationWarning,
                        WorkflowDiff, NodeReference.
tests/
  commands-pull.test.ts  commands-validate.test.ts  commands-push.test.ts
  workflow-store.test.ts  workflow-data.test.ts  workflow-validate.test.ts
```

`workflow-store.ts`, `workflow-data.ts`, `workflow-validate.ts`, and the
client stay CLI-pure (no `process.exit`, no console output) — they take inputs
and return values or throw typed `CliError`s — so a future Raycast wrapper and
sub-specs 2/3 can import them directly.

## Testing Strategy

- `workflow-store.ts`: path resolution with/without `--file`, host
  namespacing, read of a missing file (`no-local-file`), pretty-printed write,
  round-trip.
- `workflow-data.ts`: expression extraction across `$('..')`, `$node["..']`,
  `$items('..')`, `$json`, nested `parameters`, non-expression strings;
  ancestor computation over `main` and AI connection types; immediate `main`
  predecessor sets; cycles handled without infinite loops.
- `workflow-validate.ts`: `non-existent` reference; `not-upstream` reference
  (disconnected branch); a valid upstream reference passes; stale-`$json` when
  a node is inserted between two nodes; rename hint via stable `id`; diff
  add/remove/modify/rename; parse failure on malformed JSON and wrong-shape
  JSON; `--local` omits remote-dependent output.
- `client.ts`: mocked `fetch` — `getWorkflow` 200/404, `updateWorkflow` PUT
  body and headers, `429`-then-200 retry on both.
- `commands-pull/validate/push.test.ts`: exit codes (`0`/`1`/`2`), JSON
  envelopes, field stripping on push, `--force` override, `--yes` requirement
  in a non-TTY, refusal on hard errors.

## Open Assumptions

- The exact field set `PUT /workflows/{id}` accepts is taken to be
  `name, nodes, connections, settings, staticData`; `push` strips everything
  else. To be confirmed against the live `n8n.example.com` instance during
  implementation — if the API also rejects or requires another field, the
  strip list is adjusted there.
- `pull` overwrites an existing local file without prompting.
- The `$node.NodeName` dot reference form is not extracted (legacy, cannot
  carry names with spaces).
- The stale-`$json` check flags *all* `$json` expressions in an
  upstream-changed node; it does not attempt to confirm which fields actually
  broke (runtime schema is unavailable statically).
- Ancestor reachability over all connection types is a conservative
  approximation of n8n's runtime execution order; it favors avoiding false
  `not-upstream` errors over catching every unreachable case.
