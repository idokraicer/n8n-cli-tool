# n8n-helper Workflow Write Loop — Design

**Date:** 2026-07-05
**Status:** Approved direction; pending plan
**Supersedes:** the on-disk-layout and `pull`/`push` surface of
`2026-05-17-n8n-edit-loop-design.md` (never implemented). Reuses that spec's
`validate` design and reference/graph analysis verbatim; changes the file
resolution from `<host>/<id>.json` to **name-based** and adds edit primitives,
merge/partial push, and `run`.

## Purpose

Turn `n8n-helper` from a read-only discovery tool into a full agent-driven
**match → pull → edit → push → run** loop over a repo of workflow JSON files.

The motivating real-world workflow is the `revo-fitness` repo, where today the
loop is entirely manual (documented in its `AGENTS.md`):

1. *"Open the workflow in n8n, `Cmd+A` / `Cmd+C`, paste it into the local JSON
   file."* → **this is `pull`.**
2. Write new Code-node bodies / prompts in local `.js` / `.md` sidecar files,
   then *"ask the user to copy-paste it into the n8n node."* → **this is
   `edit` + `push`.**
3. *"Import it in n8n: Workflows → ⋯ → Import from File."* → **this is `push`.**

Each step is manual copy-paste today and each per-workflow "build" is a bespoke
script (`build-workflow-prod.js` does `wf.nodes.find(n => n.name === NODE)` then
`node.parameters.jsCode = …`). This spec generalizes that into first-class CLI
commands, with every write to n8n **gated behind a diff + `--yes`** so an agent
can propose and the human approves.

Motivating example (the loop this enables):

```
n8n-helper pull "Apply Agreement"                       # live → workflows/**/apply-agreement.json (diff, --yes)
n8n-helper edit "Apply Agreement" set-code \            # local edit
    --node "Plan Agreement" --code-file apply-agreement.core.js
n8n-helper edit "Sales AI Agent" set-prompt \           # local edit
    --node "AI Agent" --system-file prompts/sales/prompt.dev.md
n8n-helper push "Apply Agreement" --node "Plan Agreement"   # partial push (diff, --yes)
n8n-helper run "Apply Agreement" --data sample.json     # test end-to-end
```

## Scope

Five new commands on the existing binary: `pull`, `edit`, `validate`, `push`,
`run`. `validate` and its reference/graph analysis are taken from the
2026-05-17 spec and are reused internally by `push`.

### Non-Goals

- `activate` / `deactivate` / `create` / `delete` (a later lifecycle spec).
- A per-workflow **build manifest** that re-injects every sidecar in one
  command (generalizing `build-workflow-prod.js`). Documented as a future
  extension; the explicit `edit` subcommands cover the need for now.
- Token-delta display on prompt edits (revo's `prompt-token-delta.js`); future.
- Resolving `$json` field names against runtime schema (see 2026-05-17 spec).
- An MCP server interface.

## Matching & On-Disk Layout

**Local files.** One file per workflow, in a repo the user owns, organized
however they like (revo nests `workflows/{agents,tools,utilities}/<name>.json`).
The workflows root defaults to `./workflows`, overridable with `--dir` or
`N8N_WORKFLOWS_DIR`.

**Name is the key.** A workflow is referenced on the CLI by its **exact n8n
name** (the user's choice; matches how agents and humans think, and how the
revo files are named). Resolution has two independent sides:

- *Local file resolution:* search `<dir>` recursively for a `*.json` whose
  parsed `name` field equals the given name (exact). Fall back to a filename
  stem match (`<slug>.json`) when no file parses to that name yet. On multiple
  matches → `bad-arguments` error listing the candidate paths.
- *Live resolution:* map the name to a workflow `id` via the existing catalog
  (`searchCatalog` with `field: "name"`, exact filter), else a live
  `listWorkflows` scan. On a name collision (two live workflows share a name)
  → `bad-arguments` error listing the candidate ids/urls; the user
  disambiguates by passing an id instead (every command also accepts a bare id
  or workflow URL, like existing commands).

**New-file destination.** When `pull` targets a workflow with no local file
yet, it writes `<dir>/<slug>.json` where `<slug>` is a filesystem-safe
slug of the name; `--out <path>` overrides. Existing files are overwritten in
place (preserving their location in the tree). The file is raw n8n workflow
JSON, pretty-printed, no added metadata, so it round-trips.

> **Divergence from 2026-05-17.** That spec keyed files by `<host>/<id>.json`
> under the working dir. We drop host-namespacing and id-naming: the user's
> repo is already per-instance and files are named by workflow. `--instance`
> still selects which live instance to talk to.

## CLI Surface

Global options (`--json`, `--text`, `--instance <host>`, `--quiet`) apply
everywhere. A workflow is referenced by **exact name**, bare id, or workflow
URL. Writes to n8n (`pull` overwriting local, `push`) print a diff and require
`--yes` to apply; `edit` mutates only local files and needs no gate (git is the
audit trail).

### `pull`

```
n8n-helper pull <name-or-id-or-url> [--out <path>] [--dir <path>] [--yes]
```

- Live-resolve the name → id, `GET /api/v1/workflows/{id}`.
- Determine the destination file (existing local match, else `<dir>/<slug>.json`
  or `--out`).
- **Diff** the fetched definition against the existing local file (if any) and
  print it. If the local file differs, require `--yes` to overwrite (protects
  in-progress local edits). If there is no local file, or `--yes` is given,
  write immediately. In a non-TTY, overwriting a differing file requires
  `--yes`.
- JSON output: `{ instance, workflow:{id,name,url}, file, wrote:bool,
  summary:{nodeCount,active,triggerNodes[]}, diff? }`.
- Exit `0`; `2` on error. Exit `0` with `wrote:false` when a differing file was
  found and `--yes` was absent (nothing written; diff reported).

### `edit`

```
n8n-helper edit <name-or-id> set-code   --node <name> (--code <str> | --code-file <path>) [--lang js|python]
n8n-helper edit <name-or-id> set-prompt --node <name> [--system <str>|--system-file <path>] [--user <str>|--user-file <path>] [--system-path <jsonpath>] [--user-path <jsonpath>]
n8n-helper edit <name-or-id> replace-node --node <name> --file <node.json>
```

Local-only. Reads the resolved local file, applies the operation, writes it
back pretty-printed, and reports what changed. If no local file exists →
`no-local-file` (suggest `pull`). Nodes are matched by `name`; an unknown node
→ `bad-arguments` listing available node names.

- **`set-code`** — set the target node's `parameters.jsCode` (or
  `parameters.pythonCode` with `--lang python`). Exactly one of `--code` /
  `--code-file` is required; both or neither → `bad-arguments`. Warns (not
  errors) if the target node's `type` is not `n8n-nodes-base.code`.
- **`set-prompt`** — set `parameters.options.systemMessage` from `--system` /
  `--system-file`, and/or `parameters.text` from `--user` / `--user-file`, on
  an `@n8n/n8n-nodes-langchain.agent` node (verified field locations). At least
  one of system/user must be provided. `--system-path` / `--user-path` override
  the default field path (a dot/bracket JSON path into `parameters`) for
  nonstandard nodes. A leading `=` is preserved if present in the source and
  added when the existing value was an expression, so prompts stay n8n
  expressions; a `--literal` flag forces a plain string. Warns if the node type
  is not the agent type.
- **`replace-node`** — replace the whole node object in `nodes[]` matched by
  `--node`. The replacement file is a full node object. `id` and `position` are
  preserved from the existing node unless the replacement specifies them; the
  `name` must match the target (renames are out of scope here — do them with a
  full `--whole` push after editing the file, so `connections` stay coherent).

Reported change summary (per op): `{ file, node, field, action:"set|replaced",
before:{chars}, after:{chars} }` (JSON) / a one-line human summary.

Values are inline **or** from a file everywhere, so long prompts/code live in
sidecars (`*.core.js`, `prompt.dev.md`) exactly as the revo repo already keeps
them, and short values stay inline.

### `validate`

Reused from the 2026-05-17 spec (reference integrity, `not-upstream`,
stale-`$json`, diff, rename hints) with the file resolution changed to
name-based. It is a real command and is also run internally by `push`.

```
n8n-helper validate <name-or-id> [--local]
```

See the 2026-05-17 spec §`validate` for the full check list, JSON shape, and
exit codes (`0` valid / `1` invalid / `2` operational). Unchanged except file
resolution.

### `push`

```
n8n-helper push <name-or-id> [--whole] [--node <name> ...] [--yes] [--force] [--dir <path>]
```

Two modes:

- **Merge (default).** Fetch the live workflow, and for each **changed node**
  splice that node object into the live `nodes[]` by name, then PUT the merged
  result. "Changed" = the set of nodes explicitly named with `--node`, or, if
  none are named, every node whose object deep-differs between local and live.
  Merge updates matching nodes only; it does **not** add/remove nodes or change
  `connections`/`settings`. If the local file has added/removed nodes or
  connection changes, merge reports them as **excluded** and points to
  `--whole`. This preserves live edits to untouched nodes and supports the
  "push only the system prompt from a file" case:
  `edit … set-prompt --system-file` then `push … --node "AI Agent"`.
- **Whole (`--whole`).** PUT the entire local file. Strips API-rejected
  read-only fields, sending only `name, nodes, connections, settings`
  (`staticData` when present; missing `settings` sent as `{}`).

Both modes:

1. Run `validate` internally on the resulting definition. Hard errors refuse
   the push unless `--force`; warnings never block.
2. Print a node-level **diff** of what will change on the live workflow (added/
   removed/modified nodes, connections/settings changed) plus the validation
   verdict.
3. Require `--yes` to apply (mandatory in a non-TTY; interactive `y/N` prompt in
   a TTY). `PUT /api/v1/workflows/{id}`.

JSON output: `{ instance, workflow:{id,name,url}, mode:"merge|whole", pushed,
nodesUpdated[], nodesExcluded[], strippedFields[], validation:{valid,errorCount,
warningCount}, diff }`.

Exit `0` on push; `0` with `pushed:false` when `--yes` absent (diff shown, safe
no-op); `1` refused on validation hard errors without `--force`; `2`
operational.

### `run`

```
n8n-helper run <name-or-id> [--data <path> | --data-inline <json>] [--node <trigger>] [--poll]
```

Executes the workflow with sample input to test an end-to-end flow. Trigger
selection is automatic, overridable with `--node`:

- **Sub-workflow (`n8n-nodes-base.executeWorkflowTrigger`) — the primary
  case** (revo's agents are all this): run via the internal
  `POST /rest/workflows/{id}/run`, reusing the **session-cookie auth already
  built for `retry`**, with the sample data pinned as the trigger node's
  output. This is what "execute sub workflow using sample data" needs.
- **Webhook trigger (`n8n-nodes-base.webhook`)** present and workflow active:
  `POST` the sample data to the production webhook URL
  (`<baseUrl>/webhook/<path>`) and report the response. (Test-mode URL needs the
  editor listening; out of scope — documented.)

Sample data comes from `--data <file>` (JSON) or `--data-inline <json>`; absent,
an empty item is sent. With `--poll`, fetch the resulting execution and
summarize its status/last-node output (reuses `getExecution` + the existing
execution-data helpers); otherwise just report the execution id/url.

JSON output: `{ instance, workflow:{id,name,url}, mode:"internal|webhook",
execution:{id,url,status?}, pollError?, result? }`. Exit `0` on a started run;
`1` when `--poll` reports a terminal-failure status (`error`/`crashed`/
`canceled`) — a failed test run; `2` operational. A webhook body is never parsed
as an execution envelope (webhook success = HTTP 2xx). A `not-found` poll (the
execution isn't persisted yet, or manual-execution saving is off) is not an
error; any other poll failure surfaces as a `pollError` field without failing
the started run.

> **⚠ Verification gate.** The exact `/rest/workflows/{id}/run` request shape
> (how pinned trigger data / `runData` / `startNodes` are passed for a manual
> sub-workflow execution) is **not assumed correct** — it must be verified
> against the live instance during implementation (capture a real manual-run
> request from the n8n editor's network tab, or probe the endpoint) before the
> internal path is finalized. The webhook path is the low-risk fallback and
> ships first if the internal shape proves unstable. This is the single
> highest-uncertainty area of the spec and is isolated in its own phase.

## n8n API Mapping

All public requests carry `X-N8N-API-KEY`; base path `/api/v1`. The internal
run reuses the `/rest` session auth from `retry`.

| Need | Endpoint | Auth |
|------|----------|------|
| Resolve name → id (`pull`, `push`, `run`) | catalog, else `GET /workflows` | api key |
| Fetch a workflow (`pull`, `validate`, `push`) | `GET /workflows/{id}` | api key |
| Push a workflow (`push`) | `PUT /workflows/{id}` | api key |
| Run a sub-workflow (`run`) | `POST /rest/workflows/{id}/run` | session cookie |
| Run a webhook workflow (`run`) | `POST /webhook/{path}` | none/instance |
| Poll a run (`run --poll`) | `GET /executions/{id}` | api key |

The existing client's GET-only private `request()` is generalized to
`{ query?, method?, body? }`; `getWorkflow(id)` and `updateWorkflow(id, body)`
are added (public API), plus `runWorkflow(id, payload, {cookie})` (internal
`/rest`, mirroring `retryExecution`) and a `postWebhook(url, body)` helper.
Existing timeout and `429`-retry behavior is preserved.

## Verified Field Locations

Confirmed against real `revo-fitness` workflow JSON:

| Edit | Node type | Field |
|------|-----------|-------|
| Code body | `n8n-nodes-base.code` | `parameters.jsCode` (JS), `parameters.pythonCode` (Python) |
| Agent system prompt | `@n8n/n8n-nodes-langchain.agent` | `parameters.options.systemMessage` |
| Agent user prompt | `@n8n/n8n-nodes-langchain.agent` | `parameters.text` (with `parameters.promptType: "define"`) |

Prompt/code values in these fields are commonly n8n expression strings
(leading `=`); `set-prompt`/`set-code` preserve that prefix as described above.

## Module Layout

Extends the module plan from the 2026-05-17 spec.

```
src/
  commands/
    pull.ts        pull command (name-resolve, GET, diff, gated write)
    edit.ts        edit dispatcher: set-code | set-prompt | replace-node
    validate.ts    validate command (from 2026-05-17 spec)
    push.ts        push command (merge | whole, validate, diff, gated PUT)
    run.ts         run command (internal /rest | webhook)
  workflow-store.ts    name-based local file resolution (recursive find by
                       parsed name/stem), --dir/--out, read/write, no-local-file.
  workflow-data.ts     parse; nodes; connection graph (ancestors all-types,
                       main predecessors); expression/reference extraction.
                       (from 2026-05-17 spec)
  workflow-validate.ts reference integrity, diff, stale-$json, rename hints.
                       (from 2026-05-17 spec)
  workflow-edit.ts     pure set-code / set-prompt / replace-node on a parsed
                       workflow; field-path resolution; expression-prefix rules.
  workflow-merge.ts    compute changed nodes (local vs live), splice named/
                       changed nodes into live nodes[], report excluded changes.
  workflow-run.ts      trigger detection; build internal-run payload; build
                       webhook request; summarize result.
  name-resolve.ts      exact-name → id (catalog then live), collision handling.
  client.ts            (changed) generalized request(); getWorkflow,
                       updateWorkflow, runWorkflow, postWebhook.
  types.ts             (changed) WorkflowDefinition, WorkflowNode, edit op
                       types, MergePlan, RunResult, + validate types from prior.
tests/
  commands-pull/edit/validate/push/run.test.ts
  workflow-store/edit/merge/run/validate/data.test.ts  name-resolve.test.ts
```

All non-command modules stay CLI-pure (no `process.exit`, no console) — inputs
in, values or typed `CliError`s out — so a Raycast wrapper and later specs can
import them.

## Testing Strategy (TDD)

Every module and command is built test-first against a **mocked client** and
temp-dir fixtures (following the existing `tests/commands-*.test.ts` pattern).
Representative cases:

- **name-resolve:** exact match from catalog; live fallback; collision →
  candidate list; bare id / URL passthrough.
- **workflow-store:** recursive find by parsed `name`; stem fallback; multiple
  matches → error; new-file slug destination; `--out` / `--dir` override;
  missing file → `no-local-file`; pretty round-trip.
- **workflow-edit:** `set-code` sets `jsCode` / `pythonCode`; inline vs file;
  both/neither → error; wrong-type node warns not errors. `set-prompt` sets
  `options.systemMessage` / `text`; expression-prefix preservation; `--literal`;
  custom `--*-path`. `replace-node` swaps object, preserves `id`/`position`,
  rejects name mismatch, unknown node → error.
- **workflow-merge:** only named/changed nodes spliced; added/removed nodes and
  connection changes reported as excluded; deep-diff detection; whole-file
  path strips read-only fields, `settings` defaulting to `{}`.
- **workflow-run:** trigger auto-detection (executeWorkflowTrigger vs webhook);
  internal payload built from `--data` / `--data-inline` / empty; webhook URL
  construction; `--node` override; result summary shape.
- **workflow-validate / workflow-data:** per the 2026-05-17 spec's test list.
- **commands:** exit codes (`0`/`1`/`2`), JSON envelopes, the `--yes` gate in a
  non-TTY (pull-overwrite and push), `--force` over hard errors, merge vs
  `--whole`, `run` internal vs webhook selection.

## Error Handling & Exit Codes

Inherits the envelope/codes from prior specs. `0` success (incl. safe no-op
when `--yes` absent), `1` normal-negative (`validate` invalid; `push` refused on
hard errors), `2` operational (missing `--yes` in a non-TTY, network, auth,
`no-local-file`, name collision). New/reused stable codes: `no-local-file`
(suggests `pull`), `bad-arguments` (name collision, unknown node, inline+file
conflict).

## Phasing

Sized for TDD and subagent-driven execution; each phase is independently
green-testable and lands behind the diff+`--yes` safety.

1. **Foundations** — client generalization (`getWorkflow`/`updateWorkflow`),
   `name-resolve`, `workflow-store`, `workflow-data`. Pure + mocked-client
   tests. No user-visible command yet.
2. **`pull`** — name-resolve → GET → diff → gated write.
3. **`edit`** — `set-code` / `set-prompt` / `replace-node` on local files.
4. **`validate`** — port the 2026-05-17 checks onto name-based resolution.
5. **`push`** — `workflow-merge`, merge/whole modes, internal `validate`,
   diff + `--yes` gate, `updateWorkflow`.
6. **`run`** — webhook path first (low risk), then the internal `/rest` path
   behind the verification gate above.
7. **Docs** — update the `n8n-helper` SKILL.md with the match→pull→edit→push→run
   loop and its approval discipline (the "agent understands the flow" part), and
   the README command reference.

## Open Assumptions / Verification Gates

- **Internal run payload shape** — VERIFIED (2026-07-05) by capturing the n8n
  editor's real `POST /rest/workflows/:id/run` request against the live
  instance. Confirmed shape: `{ workflowId, startNodes: [], triggerToStartFrom:
  { name, data? } }` where `data` is an `ITaskData` (`{ data: { main:
  [[{ json }]] } }`). n8n runs the SAVED workflow by id (no `workflowData` in the
  body); auth is the session cookie (same as `retry`). The earlier best-effort
  `{ workflowData, runData, startNodes, pinData }` guess was wrong and has been
  replaced. Not yet exercised end-to-end via the CLI against a live sub-workflow.
- **`PUT` accepted field set** — `name, nodes, connections, settings,
  staticData`; confirm against the live instance and adjust the strip list
  during phase 5 (carried from the 2026-05-17 spec).
- **Exact-name uniqueness** — names can collide live; handled by erroring with
  candidates and accepting a bare id. Local files with duplicate parsed names
  error the same way.
- **Agent/Code field locations** — verified against real revo workflows above;
  `--*-path` escape hatch covers nonstandard nodes.
- **`replace-node` renames** are out of scope (would desync `connections`); use
  a `--whole` push after editing the file for structural changes.
