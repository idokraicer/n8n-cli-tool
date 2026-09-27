# n8n-helper

A CLI that helps agents and humans locate n8n workflows and find values inside
workflow execution data, over the n8n public API.

## Install

Requires [Bun](https://bun.sh) — the CLI runs TypeScript directly, so there is
no build step.

```bash
# 1. Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# 2. Clone and install dependencies
git clone https://github.com/idokraicer/n8n-cli-tool.git
cd n8n-cli-tool
bun install

# 3. Expose the global `n8n-helper` binary
bun link
bun link n8n-helper
```

Verify it works:

```bash
n8n-helper --version
```

If the command is not found, make sure `~/.bun/bin` is on your `PATH`
(the Bun installer adds it to your shell profile; open a new terminal or
`source` it).

### Automatic updates

On startup, `n8n-helper` checks its Git upstream for new commits at most once
every six hours. When the linked checkout is clean and can fast-forward, it
pulls the update and restarts the same command once with the new code. Offline,
dirty, detached, and diverged checkouts keep running the requested command
without updating. Failed checks also start a six-hour window, so an offline
machine does not pause on every command.

Skip the current check and start a fresh six-hour window with:

```bash
n8n-helper --no-update workflows
```

Disable automatic updates permanently in your shell configuration with:

```bash
export N8N_HELPER_AUTO_UPDATE=0
```

Remove that environment variable to enable checks again. Update state lives in
`~/.n8n-helper/update-check.json`. To remove the linked CLI, run `bun unlink`
in the clone.

## Authenticate

Create an API key in your n8n instance under **Settings → n8n API**, then:

```bash
n8n-helper login --url https://n8n.example.com --key <your-n8n-api-key>
```

(omit `--key` to be prompted instead of leaving the key in shell history)

Credentials are stored in `~/.n8n-helper/config.json`. Alternatively set
`N8N_API_KEY` and `N8N_BASE_URL` environment variables (a project `.env` works
too) — these override the config file and are the recommended path for agents.

The `retry` command uses n8n's internal `/rest` API, which needs a browser
session rather than an API key. Add your n8n login to enable it. `stop` uses
the public API and the normal API key:

```bash
n8n-helper login --url https://n8n.example.com --email you@example.com
```

The session cookie is persisted and refreshed automatically on expiry. The
password is stored in the config file (mode 0600); to avoid that, pass
`--cookie` / set `N8N_SESSION_COOKIE` per invocation instead.

## Commands

| Command | Description |
|---------|-------------|
| `login` | Save an instance's API key (and optionally an email/password session). |
| `sync` | Rebuild the local workflow catalog. |
| `workflows [query]` | Search workflows by id, name, webhook, or tag. |
| `executions <workflow>` | List a workflow's executions. |
| `search <value> <target>` | Locate a value in an execution or across a workflow's executions. |
| `get <execution>` | Inspect an execution, drill into a node/path, or `--trace` its trigger chain. |
| `retry <workflow>` | Re-run a workflow's failed executions (filters, concurrency, dry-run). |
| `stop <execution...>` | Stop current/queued executions (preview by default; apply with `--yes`). |
| `pull <workflow>` | Fetch a workflow's full definition to a local file (diff-gated). |
| `edit <workflow> <op>` | Edit a workflow (`set-code`, `set-prompt`, `replace-node`) — local file, or live with `--remote`; content options accept `-` for stdin. |
| `validate <workflow>` | Check node references, diff vs live, and stale `$json`. |
| `push <workflow>` | Push local changes back: merge changed nodes (default) or `--whole`. |
| `create <file>` | Create a NEW workflow from a local JSON file (created inactive; `--yes`-gated). |
| `publish <workflow>` | Publish an inactive workflow (preview by default; apply with `--yes`). |
| `run <workflow>` | Test-run with sample data (Webhook, public Chat Trigger, or internal `/rest` for sub-workflows). |
| `table` | Manage n8n data tables: metadata, rows, and columns (API-key auth; previews by default). |

## Examples

```bash
# Find a workflow by partial name or webhook
n8n-helper workflows "sales"
n8n-helper workflows --field webhook "abc-123"

# Locate a value inside one execution
n8n-helper search "500857721" "https://n8n.example.com/workflow/WF/executions/351694"

# Search a whole workflow's recent executions
n8n-helper search "500857721" "https://n8n.example.com/workflow/WF"

# List or search executions in a precise time window (requires session login)
n8n-helper executions WF --from "2026-07-14 09:00" --to "2026-07-14 10:30"
n8n-helper search "message text" WF --since 2h

# Inspect an execution, then drill into a node
n8n-helper get 351694
n8n-helper get 351694 --node "HTTP Request" --path json.order.id

# What triggered this execution? Walks sub-workflow links to the root trigger
n8n-helper get 351694 --trace

# Re-run failed executions from the last day (preview first with --dry-run)
n8n-helper retry WF --status error --started-after 2026-06-09T00:00:00Z --dry-run
n8n-helper retry WF --status error --started-after 2026-06-09T00:00:00Z

# Stop explicit current/queued executions (preview first, then apply)
n8n-helper stop 723605 723606
n8n-helper stop 723605 723606 --yes

# Fileless edit (fastest): fetch live, apply, preview; --yes to push. '-' reads stdin.
n8n-helper edit "Apply Agreement" set-code --node "Plan" --remote --code - <<'EOF'
return [{ json: { approved: $input.first().json.approved } }];
EOF
n8n-helper edit "Apply Agreement" set-code --node "Plan" --remote --yes --code - < plan.js

# Local edit loop: pull → edit locally → validate → push (every write is --yes-gated)
n8n-helper pull "Apply Agreement"                              # live -> workflows/**/apply-agreement.json
n8n-helper edit "Apply Agreement" set-code --node "Plan" --code-file plan.js
n8n-helper edit "Sales AI Agent" set-prompt --node "AI Agent" --system-file prompt.md
n8n-helper validate "Apply Agreement"
n8n-helper push "Apply Agreement"                              # diff-only preview
n8n-helper push "Apply Agreement" --node "AI Agent" --yes      # push just one node
n8n-helper push "Apply Agreement" --whole --yes               # replace whole workflow

# Create a brand-new workflow from a local file (preview first, then --yes)
n8n-helper create workflows/tools/my-new-tool.json             # preview no-op
n8n-helper create workflows/tools/my-new-tool.json --yes       # create (inactive)

# Publish the newly created inactive workflow (preview, then apply)
n8n-helper publish "New Tool"
n8n-helper publish "New Tool" --yes

# Test-run end-to-end with sample data
n8n-helper run "Apply Agreement" --data sample.json --poll

# Send a message to a published, public Chat Trigger
n8n-helper run "Chat Agent" --data-inline '{"chatInput":"Hello","sessionId":"cli-test-1"}'
```

### Execution time filters

`executions` and workflow-wide `search` accept `--from`, `--to`, and
`--since`. Relative `--since` values support `m`, `h`, `d`, and `w`, such as
`30m`, `2h`, or `3d`. Date/time values without an explicit timezone use the
machine's local timezone; JSON output includes the normalized UTC
`timeWindow`.

n8n's public API does not support execution start-time filters, so these flags
use the authenticated internal execution-list endpoint. Save a browser session
first:

```bash
n8n-helper login --url https://n8n.example.com --email you@example.com
```

Ordinary execution listing without time filters continues to use the API key
and does not require session authentication.

## Data tables

The `table` command manages n8n data tables through the public API. It needs
only an API key; no browser session is required. Persisted writes preview by
default and require `--yes`. Server-side `--dry-run` sends a non-persisting API
request without `--yes`.

```bash
# Metadata: list, inspect, create, rename, delete
n8n-helper table list --limit 50                  # --all auto-paginates (cap 1000)
n8n-helper table list --name "Orders"
n8n-helper table list --sort createdAt:desc --limit 20
n8n-helper table get <tableId>
n8n-helper table create "Orders" --columns-file columns.json
n8n-helper table create "Orders" --columns-json '[{"name":"id","type":"string"}]' --yes
n8n-helper table rename <tableId> "Orders 2026" --yes
n8n-helper table delete <tableId> --yes

# Rows: query, insert, update, upsert, delete, clear
n8n-helper table rows list <tableId> --limit 20
n8n-helper table rows list <tableId> --filter-json '{"type":"and","filters":[{"columnName":"status","condition":"eq","value":"new"}]}' --sort "status:asc"
n8n-helper table rows list <tableId> --search "acme" --all
n8n-helper table rows insert <tableId> --data-file rows.json --return id --yes
n8n-helper table rows update <tableId> --data-json '{"status":"done"}' --filter-json '{"type":"and","filters":[{"columnName":"id","condition":"eq","value":"1"}]}' --dry-run
n8n-helper table rows update <tableId> --data-file patch.json --filter-file filter.json --yes
n8n-helper table rows upsert <tableId> --data-json '{"id":"1","status":"new"}' --filter-json '{"type":"and","filters":[{"columnName":"id","condition":"eq","value":"1"}]}' --yes
n8n-helper table rows delete <tableId> --filter-json '{"type":"and","filters":[{"columnName":"status","condition":"eq","value":"stale"}]}' --dry-run
n8n-helper table rows delete <tableId> --filter-file stale-filter.json --yes
n8n-helper table rows clear <tableId> --yes

# Columns: list, add, update, delete
n8n-helper table columns list <tableId>
n8n-helper table columns add <tableId> "notes" string --index 2 --yes
n8n-helper table columns update <tableId> <columnId> --name "notes_v2" --index 1 --yes
n8n-helper table columns delete <tableId> <columnId> --yes
```

`rows update`, `rows upsert`, and `rows delete` also support server-side
`--dry-run`. This sends a public API request with `dryRun: true` and does not
persist the change. It cannot be combined with `--yes`.

JSON inputs accept either a file or inline value, never both:
`--data-file`/`--data-json`, `--filter-file`/`--filter-json`, and
`--columns-file`/`--columns-json`. Supported column types are `string`,
`number`, `boolean`, and `date`.

`--all` follows cursors up to 1,000 records per run and returns the next cursor
when more data remains. Atomic `rows upsert` is exactly one public API request;
it has no client-side list/insert/update fallback.

## Output and exit codes

Output is JSON when piped and human-readable in a terminal (`--json` / `--text`
override). In JSON mode, stdout carries only the JSON document; progress goes to
stderr.

- `0` — success (`search`: at least one match; `pull`/`push` without `--yes`: a
  safe diff-only no-op still exits `0`).
- `1` — normal negative: `search` found nothing; `validate` found hard errors;
  `push` refused on validation failure (override with `--force`).
- `2` — error (a JSON error envelope is printed in JSON mode).
