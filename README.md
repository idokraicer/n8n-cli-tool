# n8n-helper

A CLI that helps agents and humans locate n8n workflows and find values inside
workflow execution data, over the n8n public API.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun link            # exposes the `n8n-helper` binary
```

## Authenticate

```bash
n8n-helper login --url https://n8n.example.com --key <your-n8n-api-key>
```

Credentials are stored in `~/.n8n-helper/config.json`. Alternatively set
`N8N_API_KEY` and `N8N_BASE_URL` environment variables (a project `.env` works
too) — these override the config file and are the recommended path for agents.

The `retry` command uses n8n's internal `/rest` API, which needs a browser
session rather than an API key. Add your n8n login to enable it:

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

## Examples

```bash
# Find a workflow by partial name or webhook
n8n-helper workflows "sales"
n8n-helper workflows --field webhook "abc-123"

# Locate a value inside one execution
n8n-helper search "500857721" "https://n8n.example.com/workflow/WF/executions/351694"

# Search a whole workflow's recent executions
n8n-helper search "500857721" "https://n8n.example.com/workflow/WF"

# Inspect an execution, then drill into a node
n8n-helper get 351694
n8n-helper get 351694 --node "HTTP Request" --path json.order.id

# What triggered this execution? Walks sub-workflow links to the root trigger
n8n-helper get 351694 --trace

# Re-run failed executions from the last day (preview first with --dry-run)
n8n-helper retry WF --status error --started-after 2026-06-09T00:00:00Z --dry-run
n8n-helper retry WF --status error --started-after 2026-06-09T00:00:00Z
```

## Output and exit codes

Output is JSON when piped and human-readable in a terminal (`--json` / `--text`
override). In JSON mode, stdout carries only the JSON document; progress goes to
stderr.

- `0` — success (`search`: at least one match).
- `1` — `search` only: no matches.
- `2` — error (a JSON error envelope is printed in JSON mode).
