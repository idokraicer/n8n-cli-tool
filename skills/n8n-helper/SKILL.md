---
name: n8n-helper
description: Use when working with a user's n8n instance (the workflow-automation tool) over its API — locating workflows by name/webhook/tag, listing or inspecting executions, finding where a value appears inside execution data, tracing what triggered a sub-workflow execution, re-running failed executions, or editing workflows end-to-end (pull a definition to a local file, inject code / prompts / whole nodes, validate, push back, and test-run with sample data). Use the n8n-helper CLI instead of hand-rolling curl against the n8n public API.
user-invocable: true
---

# n8n-helper

Locate n8n workflows and find values inside execution data over the n8n API, using the `n8n-helper` CLI.

**Core rule:** For anything involving a user's n8n workflows or executions, use `n8n-helper` — do NOT hand-roll `curl`/`jq` against `/api/v1/...`. The CLI already wraps the API with workflow search (including webhook lookup, which the public API can't do), execution caching, pagination, trigger-chain tracing, and contextual value search.

## Installation

Check first: `n8n-helper --version`. If not found, install (requires [Bun](https://bun.sh)):

```bash
git clone https://github.com/idokraicer/n8n-cli-tool.git ~/.n8n-helper-cli
cd ~/.n8n-helper-cli && bun install && bun link && bun link n8n-helper
```

If `~/.bun/bin` isn't on `PATH`, the binary won't resolve — open a new shell or source the profile. To update later: `git pull` in the clone (the linked binary runs current source).

## Authentication

Two separate credentials, depending on the command:

- **API key** (most commands): set `N8N_API_KEY` and `N8N_BASE_URL` env vars (a project `.env` works) — this is the **recommended path for agents** and overrides the config file. Or persist to `~/.n8n-helper/config.json` with:
  ```bash
  n8n-helper login --url https://n8n.example.com --key <api-key>
  ```
  (Create the key in n8n under **Settings → n8n API**.)
- **Browser session** (only `retry`): the `/rest` API needs a login session, not an API key. Enable with `n8n-helper login --url https://n8n.example.com --email you@example.com` (prompts for password; stored mode 0600). Or pass `--cookie` / set `N8N_SESSION_COOKIE` per invocation.

If a command errors about missing credentials, ask the user for their instance URL + API key and run `login` (or set the env vars).

## Targets: URL or bare id

Most commands accept either a full n8n URL or a bare id. **Prefer a full URL when the user gives one** — the instance host and ids are auto-detected, no `--instance` needed. Otherwise the default instance from config/env is used.

- Workflow target: `https://n8n.example.com/workflow/<WF>` or bare `<WF>`
- Execution target: `https://n8n.example.com/workflow/<WF>/executions/<EXEC>` or bare `<EXEC>`

`executions`/`get` reject the wrong kind (e.g. a workflow URL passed to `get`).

## Commands

| Command | Use it to |
|---------|-----------|
| `login` | Save API key (and optionally email/password session for `retry`). |
| `sync` | Rebuild the local workflow catalog for the instance. |
| `workflows [query]` | Find workflows by id, name, webhook, or tag. |
| `executions <workflow>` | List a workflow's executions (filter by status, paginate). |
| `search <value> <target>` | Locate a value inside one execution, or across a workflow's executions. |
| `get <execution>` | Inspect an execution, drill into a node/path, or `--trace` its trigger chain. |
| `retry <workflow>` | Re-run failed executions (needs session auth; preview with `--dry-run`). |
| `pull <workflow>` | Fetch a workflow's full definition to a local file (diff-gated). |
| `edit <workflow> <op>` | Edit the local file: `set-code`, `set-prompt`, `replace-node`. |
| `validate <workflow>` | Check node references, diff vs live, and stale `$json`. |
| `push <workflow>` | Push local changes back: merge changed nodes (default) or `--whole`. |
| `run <workflow>` | Test-run with sample data (webhook, or internal `/rest` for sub-workflows). |

Run `n8n-helper <command> --help` for the full flag list — only the high-value flags are below.

## Task playbook

**Find a workflow** (the catalog auto-syncs on first use; `--refresh` to force):
```bash
n8n-helper workflows "sales"                 # substring across id/name/webhook/tag
n8n-helper workflows --field webhook "abc-123"   # webhook lookup — the public API can't do this
n8n-helper workflows --active                 # only active workflows
```
Returns `workflows[]` with `id`, `name`, `active`, `tags`, `webhooks[]`, `url`.

**List executions:**
```bash
n8n-helper executions <WF> --status error --limit 20
n8n-helper executions <WF> --all              # auto-paginate up to 1000
```

**Find where a value appears** (this is the headline feature):
```bash
n8n-helper search "500857721" <EXEC>          # one execution
n8n-helper search "500857721" <WF>            # across the workflow's recent executions
n8n-helper search "500857721" <EXEC> --context --no-truncate   # show each match's parent object, full values
```
Useful flags: `--node <name>`, `--exact`, `--regex`, `--case-sensitive`, `--status`, `--limit` (workflow target). Each match reports `node`, `path`, `value`, and `url`.

**Inspect an execution / drill in:**
```bash
n8n-helper get <EXEC>                          # node summaries + status + lastNodeExecuted
n8n-helper get <EXEC> --node "HTTP Request"    # one node's items
n8n-helper get <EXEC> --node "HTTP Request" --path json.order.id   # resolve a JSON path
```
Narrow with `--run`, `--output`, `--item` when a node has multiple runs/branches/items.

**Trace what triggered an execution** (walks parent sub-workflow links to the root trigger):
```bash
n8n-helper get <EXEC> --trace
```
Returns `trace[]` in trigger order plus `summary.root` (the originating workflow/execution).

**Re-run failed executions** (needs session auth — see Authentication). **Always `--dry-run` first** and show the user the matched list before retrying:
```bash
n8n-helper retry <WF> --status error --started-after 2026-06-09T00:00:00Z --dry-run
n8n-helper retry <WF> --status error --started-after 2026-06-09T00:00:00Z
```
Other flags: `--ids <list>` (overrides filters), `--exclude <list>`, `--concurrency <n>`, `--load-workflow`.

## Workflow write loop (edit a workflow end-to-end)

The loop is **match → pull → edit → validate → push → run**, over a repo of
one-file-per-workflow JSON (default `./workflows`, override with `--dir` or
`N8N_WORKFLOWS_DIR`). Workflows are referenced by their **exact n8n name** (or a
bare id / URL). Files are found recursively by the `name` field inside them.

**Approval discipline (do not skip):** every write is diff-gated. `pull`
(overwriting a differing local file) and `push` do **nothing** without `--yes`
— they print a diff and stop. Show the user that diff and get their explicit
approval *before* re-running with `--yes`. Never pass `--yes` on the user's
behalf.

```bash
# 1. Pull the live definition to a local file (shows a diff if the file drifted).
n8n-helper pull "Apply Agreement"                 # writes workflows/**/apply-agreement.json
#    If it reports wrote:false with a diff, that means the local file differs —
#    show the diff, then re-run with --yes once the user approves overwriting.

# 2. Edit locally. Long values come from files (code/prompts), short ones inline.
n8n-helper edit "Apply Agreement" set-code   --node "Plan Agreement" --code-file plan.js
n8n-helper edit "Sales AI Agent"  set-prompt --node "AI Agent" --system-file prompts/sales/prompt.dev.md
n8n-helper edit "Sales AI Agent"  set-prompt --node "AI Agent" --user "={{ $json.message }}"
n8n-helper edit "Apply Agreement" replace-node --node "Return Tool Result" --file node.json

# 3. Validate — catches references to renamed/deleted/not-upstream nodes.
n8n-helper validate "Apply Agreement"             # add --local to skip the live fetch/diff

# 4. Push back — merge (default) sends only changed nodes and preserves live
#    edits to untouched ones; --whole replaces the entire workflow.
n8n-helper push "Apply Agreement"                 # diff-only preview (no --yes)
n8n-helper push "Apply Agreement" --node "AI Agent"   # push just one node (e.g. a prompt tweak)
n8n-helper push "Apply Agreement" --yes           # apply, after the user approves the diff
n8n-helper push "Apply Agreement" --whole --yes   # replace whole workflow

# 5. Test-run end-to-end with sample data.
n8n-helper run "Apply Agreement" --data sample.json          # sub-workflow via internal /rest
n8n-helper run "Sales AI Agent"  --data-inline '{"message":"hi"}' --poll
```

Field targets `edit` writes: `set-code` → a Code node's `parameters.jsCode`
(`--lang python` → `pythonCode`, and also flips `parameters.language` so n8n runs
the body you just wrote); `set-prompt` → an AI Agent node's
`parameters.options.systemMessage` (system) and `parameters.text` (user);
`replace-node` swaps a whole node object by name (preserving its `id`/position).
Prompt/code values that were n8n expressions keep their leading `=` unless you
pass `--literal`.

**Gotchas:**
- **Prefer `push --node <name>` for precise pushes.** Plain `push` (merge, no
  `--node`) sends *every* node whose object differs from live — which includes
  nodes that changed **live** since your `pull`, not just the ones you edited.
  Read the printed diff before `--yes`; use `--node` (or `--whole`) to be exact.
- **`edit` takes the exact workflow name** (it operates on the local file by
  name), not an id or URL. Run `pull` first if you don't have the file.
- **`run` on a webhook workflow requires it to be active** (it calls the
  production `/webhook/<path>` using the Webhook node's own `httpMethod` —
  defaulting to GET, with sample data sent as a body for POST/PUT/PATCH/DELETE or
  as query params for GET/HEAD). For sub-workflows (Execute-Workflow-Trigger),
  `run` uses n8n's internal `/rest` API with your session login (like `retry`)
  and sends the `browser-id` the session was created with. `run --poll` exits
  non-zero if the polled execution ended in `error`/`crashed`.
- **`set-code`/`set-prompt` warn** (in the JSON `warning` field) when the target
  node isn't a Code / AI-Agent node — a signal the edit may be inert.

## Output and exit codes

Output is **JSON when piped/non-TTY** and human-readable in a terminal. Force with `--json` / `--text`. In JSON mode, stdout carries only the JSON document; progress goes to stderr. When invoking from an agent, parse stdout as JSON.

- `0` — success (`search`: at least one match; `push`/`pull` without `--yes`: a safe diff-only no-op still exits `0`).
- `1` — a normal negative result: `search` found no matches; `validate` found hard errors (invalid); `push` refused because validation failed (override with `--force`).
- `2` — operational error; a JSON error envelope `{ "error": { "code", "message", "details", "hint"? } }` is printed in JSON mode.

**Reading results as an agent — don't rely on the exit code alone.** A command
can exit `0` and still have done nothing on purpose (a diff-only preview). Key
off the structured fields:

- **`wrote` / `pushed` booleans** — `pull` and `push` return `false` here when
  they only previewed a diff (no `--yes`). Exit `0` ≠ "applied".
- **`hint`** — present on every safe no-op and every refusal (and in the error
  envelope). It is the machine-readable next step, e.g. *"Preview only — re-run
  with --yes to apply it"* or *"Refused: validation found N errors… or --force"*.
  When you see a `hint`, that is your instruction for the next call.
- **`validation.valid` / `validation.errorCount`** on `push`/`validate` — fix
  the reported `errors[]` before pushing, or pass `--force`.
- **`nodesExcluded`** on `push` merge — nodes the merge did not send (added/
  removed/connection changes); use `--whole` if you need them.
- **error `code`** — a stable slug to branch on (`no-local-file`,
  `no-credentials`, `bad-arguments`, `unauthorized`, `not-found`, `rate-limited`,
  `network-error`, …). Each blocking error carries a `hint` with the fix.

Global flags: `--instance <host>` (target a non-default saved instance), `--quiet` (suppress stderr progress), `--out <file>` (on `search`/`get`, write JSON to a file).

## Common mistakes

- **Hand-rolling `curl`/`jq` against `/api/v1`.** Don't. Use `n8n-helper`. The public API has no webhook search, no trace, and no contextual value search — the CLI adds all three.
- **Using an API key for `retry`.** `retry` hits the internal `/rest` API and needs a browser session (email/password or `--cookie`), not the API key.
- **Retrying without a preview.** Run `--dry-run` first and confirm the matched executions with the user before the real run.
- **Passing the wrong target kind.** `get`/`search`-on-execution want an execution id/URL; `executions`/`retry`/`search`-on-workflow want a workflow id/URL.
- **Forgetting it returns JSON when piped.** Read structured fields from stdout; don't scrape human text.
