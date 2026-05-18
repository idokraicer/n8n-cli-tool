# Raycast n8n Extension — Design

**Date:** 2026-05-18
**Status:** Pending spec review
**Repo:** new standalone repo at `/Users/idokraicer/Developer/raycast-n8n-workflows`

## Purpose

A Raycast extension to search and browse an n8n instance — workflows, their
folders, and executions — directly from Raycast. It is the n8n counterpart of
the existing `raycast-make-scenarios` extension, offering roughly the same
actions mapped onto n8n's entity model.

It is a standalone repo (like `raycast-make-scenarios`), self-contained: it
reimplements the n8n API client rather than depending on `n8n-cli-tool`. Proven
logic from `n8n-cli-tool` (`client.ts`, `catalog.ts`, `webhooks.ts`, `url.ts`)
is ported, not imported.

## Why n8n differs from Make

The Make extension is complex because **one API token discovers many
organizations, teams, and zones**. n8n is the opposite: **one API key = one
instance**. Single instance is sufficient (confirmed with the user). This
collapses Make's org/team/zone facets, multi-phase enrichment, work-directory
promotion, hot-start manifest, and skipped-orgs handling — all dropped as YAGNI.

## Verified API constraints (probed against the live instance)

The n8n public API (`/api/v1`) was probed directly. Findings that shape the
design:

- `GET /workflows` — paginated by `cursor`; filters `active`, `tags`, `name`,
  `projectId`. The workflow object exposes `id, name, active, isArchived, tags,
  triggerCount, nodes, createdAt, updatedAt` and `shared[].projectId` (home
  project). **It carries no folder field.**
- `GET /workflows` **cannot be filtered by folder** — `folderId`,
  `parentFolderId`, and `filter` are all rejected as unknown query parameters.
- `GET /projects` — **403, license-gated** on this instance. Project listing is
  unavailable.
- `GET /projects/{projectId}/folders` — **works**. Returns the full folder set
  for a project (no pagination params): `id, name, parentFolderId, path[]`
  (array of ancestor names), `workflowCount`, `subFolderCount`, `tags`, and
  `homeProject` (`id`, `name`, `type`). Returns `workflowCount` but **not the
  IDs of workflows in the folder.**
- `GET /executions` — paginated by `cursor`; filters `status`, `workflowId`.
  Execution objects expose `id, status, mode, finished, startedAt, stoppedAt,
  workflowId, retryOf, waitTill` — **no workflow name.**

### Consequence for the folder feature

The public API provides **no workflow→folder mapping**. Therefore the workflow
list **cannot be filtered by folder.** "Search using folders" is realized as a
**folder browser**: folders are first-class searchable items (by name and
path), each opening in the n8n UI — analogous to organizations in the Make
extension. Project names are recovered from `homeProject.name` on folder
responses (since `/projects` is blocked); project IDs are collected from
`workflows[].shared[].projectId`.

## Goals

- Search workflows fast from a local disk catalog (name, id, tag, webhook path).
- Browse and search the folder tree by name and path.
- Browse recent executions instance-wide, with workflow names resolved locally.
- Read-only: open in n8n, copy URLs, pin — no workflow mutation (matches the
  Make extension's posture).
- Memory-bounded: the catalog lives on disk as JSONL, streamed line by line.

## Non-goals

- Filtering workflows by folder (API does not support it).
- Multiple n8n instances (single instance only).
- Workflow mutation (activate/deactivate/archive) — possible future work.
- Project administration (`/projects` is license-gated anyway).

## Commands

Two view commands.

### 1. Search n8n Workflows (`search-workflows`)

Primary command. A `List` with a type dropdown — `All` / `Workflows` /
`Folders` (mirrors the Make extension's unified "Search Make").

**Workflow rows.** Title = workflow name. Subtitle/keywords include tags and
webhook paths so they are searchable. Accessories: an active/archived indicator
icon, tag tags, and the project name when known. Search matches name, id, tag,
and webhook path. A status filter (`All` / `Active` / `Archived`) is available
in the dropdown.

Workflow row actions (mirroring the Make scenario item):
- **Open in n8n** (`Enter`) — opens `{base}/workflow/{id}`.
- **View Executions** (`Tab`, push) — pushes the executions view for this
  workflow.
- **Pin / Unpin** (`Cmd+Shift+P`).
- **Copy Workflow URL** (`Cmd+C`).
- **Copy Webhook URL** (`Cmd+Shift+C`) — when the workflow has a webhook node.
- **Refresh** (`Cmd+R`) — forces a catalog re-sync.

Pinned and recently visited workflows surface in dedicated sections at the top,
as in the Make extension.

**Folder rows.** Title = folder name. Subtitle = full path joined (e.g.
`Revo Fitness / tools`). Accessory = `workflowCount` and project name. Search
matches folder name and every path segment. Action: **Open in n8n** —
`{base}/projects/{projectId}/folders/{folderId}/workflows` (exact UI route to be
confirmed during implementation) — plus **Copy URL** and **Refresh**.

### 2. Search n8n Executions (`search-executions`)

A `List` of recent executions across the whole instance. Workflow names are
joined from the workflow catalog by `workflowId`. Status filter dropdown
(`All` / `Success` / `Error` / `Waiting`). Each row shows status icon, workflow
name, mode, started-at, and duration (`stoppedAt − startedAt`).

Execution row actions:
- **Open Execution in n8n** (`Enter`) —
  `{base}/workflow/{workflowId}/executions/{id}`.
- **Open Workflow in n8n** (`Cmd+O`).
- **Refresh** (`Cmd+R`).

## Architecture

```
raycast-n8n-workflows/
  package.json            Raycast extension manifest (ray tooling)
  tsconfig.json, eslint, etc.
  src/
    api/
      client.ts           n8n HTTP client: X-N8N-API-KEY auth, cursor
                           pagination, 429 retry w/ backoff, timeout/abort
      endpoints.ts         listWorkflows, listFolders(projectId),
                           listExecutions
      types.ts             Workflow, Folder, Execution, Project API types
    catalog/
      db.ts                catalog paths, manifest read/write, JSONL stream
      service.ts           syncCatalog (TTL + lock), searchWorkflows,
                           searchFolders, getWorkflowsById
      types.ts             WorkflowRow, FolderRow, CatalogManifest
    components/
      workflow-list-item.tsx
      folder-list-item.tsx
      executions-view.tsx        pushed view: a workflow's executions
    hooks/
      use-catalog-sync.ts        triggers/observes background sync
      use-catalog-search.ts      paged search over the disk catalog
      use-pinned.ts              LocalStorage-backed pins
      use-recents.ts             LocalStorage-backed recents
    utils/
      url.ts               buildWorkflowUrl, buildExecutionUrl,
                           buildFolderUrl
      webhooks.ts          extractWebhooks from workflow nodes (ported)
      format.ts            duration / timestamp formatting
    search-workflows.tsx   command entry
    search-executions.tsx  command entry
```

### Catalog

A single-instance disk catalog under Raycast's `environment.supportPath`:

- `workflows.jsonl` — one `WorkflowRow` per line: `id, name, active,
  isArchived, tags[], triggerCount, projectId, webhooks[], url, updatedAt`.
- `folders.jsonl` — one `FolderRow` per line: `id, name, projectId,
  projectName, parentFolderId, path[], workflowCount, url`.
- `manifest.json` — `schemaVersion, instanceUrl, syncedAt, workflowCount,
  folderCount`.

**Sync** (`syncCatalog`):
1. Paginate `GET /workflows` (cursor) → project each to a `WorkflowRow`
   (webhooks extracted from nodes). The instance currently has ~199
   workflows — one or two pages.
2. Collect the distinct set of `shared[].projectId` from the workflows.
3. For each project ID, `GET /projects/{projectId}/folders` → project each
   folder to a `FolderRow`, taking `projectName` from `homeProject.name`.
   Tolerate per-project failures (skip that project's folders).
4. Atomic write: write each file to a temp path, then rename into place;
   write the manifest last.

Sync runs in the background with a **TTL** (re-sync if `syncedAt` older than
~15 min) and a **lock file** to prevent concurrent syncs. On command launch,
cached data renders immediately while a background sync refreshes it; `Cmd+R`
forces a sync. This is the Make extension's "show cached, refresh behind"
behavior without its multi-phase enrichment machinery.

**Search** streams the relevant JSONL file line by line, applies filters, and
returns an offset/limit window plus a total count — feeding Raycast's
`pagination` API. Ported from `n8n-cli-tool`'s `searchCatalog`.

### API client

Ported from `n8n-cli-tool/src/client.ts`: `X-N8N-API-KEY` header, base URL
normalization, `/api/v1` prefix, `cursor`-based pagination, exponential-backoff
retry on HTTP 429, per-request timeout via `AbortController`. Errors are
surfaced as typed errors so the UI can show actionable Raycast toasts
(401 → "check your API key", etc.). The API key is read from Raycast
preferences via `getPreferenceValues`.

### Preferences

| Name | Type | Required | Notes |
|---|---|---|---|
| `instanceUrl` | text | yes | e.g. `https://n8n.example.com` (trailing slash trimmed) |
| `apiKey` | password | yes | n8n public API key (`X-N8N-API-KEY`) |

## Error handling

- Missing/invalid preferences → Raycast `List.EmptyView` with guidance.
- `401` → toast "Authentication failed — check your API key".
- `403` on `/projects/{id}/folders` → that project contributes no folders; the
  rest of the catalog still builds.
- Network/timeout → toast; stale cached catalog still renders.
- Empty catalog (first run, sync in progress) → loading state, then results.

## Testing

- **Unit (vitest, mirroring `raycast-make-scenarios`):**
  - `webhooks.ts` — webhook extraction from representative node arrays.
  - `url.ts` — workflow / execution / folder URL construction.
  - `catalog/service.ts` search — filtering, paging, status filter, folder
    path matching, over JSONL fixtures.
  - `format.ts` — duration and timestamp formatting.
- **Manual:** run `ray develop` against the live instance; verify workflow
  search, folder browsing, executions view, pin/recents, and the copy actions.
- API client networking is covered by injecting a fake `fetch`, as in
  `n8n-cli-tool`.

## Open items to confirm during implementation

- Exact n8n UI route for a folder
  (`/projects/{projectId}/folders/{folderId}/workflows` is the working
  assumption).
- Whether `GET /executions` without `workflowId` is acceptably fast on larger
  instances; if not, the executions command may default to a bounded recent
  window.
