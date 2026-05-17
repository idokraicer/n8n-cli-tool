# n8n-locate

A CLI that helps agents and humans locate n8n workflows and find values inside
workflow execution data, over the n8n public API.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun link            # exposes the `n8n-locate` binary
```

## Authenticate

```bash
n8n-locate login --url https://n8n.example.com --key <your-n8n-api-key>
```

Credentials are stored in `~/.n8n-locate/config.json`. Alternatively set
`N8N_API_KEY` and `N8N_BASE_URL` environment variables (a project `.env` works
too) — these override the config file and are the recommended path for agents.

## Commands

| Command | Description |
|---------|-------------|
| `login` | Save an instance's API key. |
| `sync` | Rebuild the local workflow catalog. |
| `workflows [query]` | Search workflows by id, name, webhook, or tag. |
| `executions <workflow>` | List a workflow's executions. |
| `search <value> <target>` | Locate a value in an execution or across a workflow's executions. |
| `get <execution>` | Inspect an execution or drill into a node/path. |

## Examples

```bash
# Find a workflow by partial name or webhook
n8n-locate workflows "sales"
n8n-locate workflows --field webhook "abc-123"

# Locate a value inside one execution
n8n-locate search "500857721" "https://n8n.example.com/workflow/WF/executions/351694"

# Search a whole workflow's recent executions
n8n-locate search "500857721" "https://n8n.example.com/workflow/WF"

# Inspect an execution, then drill into a node
n8n-locate get 351694
n8n-locate get 351694 --node "HTTP Request" --path json.order.id
```

## Output and exit codes

Output is JSON when piped and human-readable in a terminal (`--json` / `--text`
override). In JSON mode, stdout carries only the JSON document; progress goes to
stderr.

- `0` — success (`search`: at least one match).
- `1` — `search` only: no matches.
- `2` — error (a JSON error envelope is printed in JSON mode).
