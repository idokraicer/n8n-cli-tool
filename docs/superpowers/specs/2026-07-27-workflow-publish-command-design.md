# Workflow Publish Command Design

## Goal

Add a standalone `n8n-helper publish <workflow>` command that publishes a
newly created, inactive n8n workflow. Existing workflow updates remain the
responsibility of `push`, which already sends the latest saved definition to
n8n.

## Command Contract

The command accepts the same workflow references as other workflow commands:
an exact name, workflow ID, or full n8n workflow URL.

```bash
n8n-helper publish "New Workflow"
n8n-helper publish "New Workflow" --yes
```

Without `--yes`, the command is a read-only preview. It resolves and fetches
the workflow, reports whether it is already active, and explains that `--yes`
is required to publish an inactive workflow.

With `--yes`, an inactive workflow is published through n8n's public API:

```text
POST /api/v1/workflows/{id}/activate
```

The endpoint uses the existing API-key authentication path. It does not
require a browser session.

If the workflow is already active, the command returns success without
calling the activation endpoint. This makes repeated publish requests safe
and idempotent.

## Components

- `N8nClient.publishWorkflow(id)` wraps the public activation endpoint and
  returns the workflow object supplied by n8n.
- `runPublish(ref, opts)` resolves the instance and workflow reference, fetches
  current state, handles preview and already-active cases, invokes the client
  when approved, and emits structured output.
- `src/cli.ts` registers `publish <workflow>` with the `--yes` gate.
- `README.md` documents the new command and the create-then-publish workflow.
- `skills/n8n-helper/SKILL.md` receives only a compact discoverability entry.

## Output and Errors

JSON output includes the instance, workflow ID/name/URL, prior active state,
and:

- `published: false` plus a preview hint when `--yes` is absent.
- `published: false` and `alreadyPublished: true` for an active workflow.
- `published: true` after n8n confirms activation.

Resolution, authentication, permission, not-found, network, and n8n API errors
flow through the CLI's existing `CliError` and output-mode handling.

## Testing

Tests are added before production code and cover:

1. Previewing an inactive workflow without making an activation request.
2. Publishing an inactive workflow with `--yes`.
3. Treating an already-active workflow as a successful no-op.
4. The client request method, path, API-key header, and response.
5. CLI help/command registration.

Focused publish/client/CLI tests run first, followed by the complete test
suite and TypeScript check.

## Scope

This change does not:

- alter `push`;
- add an automatic `--publish` option to `create`;
- add an unpublish/deactivate command;
- publish a workflow implicitly without `--yes`;
- mutate or commit unrelated existing worktree changes.
