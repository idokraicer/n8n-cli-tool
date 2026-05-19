# Raycast n8n — Folder Browser (file-directory navigation)

**Goal:** Replace the flat "folder focus" filter with a file-directory-style browser: a folder shows its *direct* children (immediate subfolders + workflows directly in it); drilling into a subfolder pushes a new view; "Go Up" navigates to the parent; the last-viewed folder is remembered and restored on launch.

**Repo:** `/Users/idokraicer/Developer/raycast-n8n-workflows` (extends the existing extension).

**Verified internal-API facts** (probed live — do not re-derive):
- `GET /rest/workflows?includeFolders=true&filter={"parentFolderId":"<id|0>","projectId":"<pid>"}&take=100` → `{ count, data: [...] }`. Items have a `resource` field: `"folder"` or `"workflow"`. `"0"` as `parentFolderId` = the project root.
- Folder items: `{ resource:"folder", id, name, parentFolderId, workflowCount, subFolderCount }`.
- Workflow items: `{ resource:"workflow", id, name, parentFolder, updatedAt, ... }` — but NO `active`/`nodes`. Full workflow data (active state, webhooks) must be looked up from the existing public-API catalog (`workflows.jsonl`) by `id`.
- Auth: the existing `N8nInternalClient` already handles login + cookie + `browser-id`.
- `GET /rest/projects` lists projects; the user's workflows are dominated by one personal project. Resolve the project id from the existing catalog (most common `WorkflowRow.projectId`) rather than calling `/rest/projects`.

**Constraints:**
- Surgical: create NEW files; only additive edits to `internal-client.ts`, `catalog/service.ts`, and `search-workflows.tsx`. Do NOT modify `endpoints.ts`, `search-executions.tsx`, `folder-list-item.tsx`, `workflow-list-item.tsx`, or the user's new `use-execution-data.ts` / `execution-search.ts` files — they hold unrelated in-flight work.
- Read every "Modify" file fresh immediately before editing (the repo is being edited concurrently).
- Do NOT commit anything.
- `.js` import extensions; `bun`/`bunx`; `bunx tsc --noEmit` must pass after each task.

---

## Task 1: Internal client — fetch a folder's direct children

**File:** Modify `src/api/internal-client.ts`

Add types and a method to the `N8nInternalClient` class.

- [ ] Add these exported interfaces near the top (after `WorkflowFolderRef`):

```ts
export interface FolderChild {
  id: string;
  name: string;
  parentFolderId: string | null;
  workflowCount: number;
  subFolderCount: number;
}

export interface FolderChildren {
  folders: FolderChild[];
  workflowIds: string[];
}
```

- [ ] Add this method to the `N8nInternalClient` class (uses the existing private `restGet`):

```ts
/** Direct children of a folder. Pass parentFolderId "0" for the project root. */
async fetchFolderChildren(
  projectId: string,
  parentFolderId: string,
): Promise<FolderChildren> {
  const folders: FolderChild[] = [];
  const workflowIds: string[] = [];
  let skip = 0;
  for (;;) {
    const filter = JSON.stringify({ parentFolderId, projectId });
    const page = await this.restGet<{
      count: number;
      data: Array<{
        resource: string;
        id: string;
        name?: string;
        parentFolderId?: string | null;
        workflowCount?: number;
        subFolderCount?: number;
      }>;
    }>(
      `/rest/workflows?includeFolders=true&filter=${encodeURIComponent(filter)}` +
        `&skip=${skip}&take=100&sortBy=updatedAt:desc`,
    );
    for (const item of page.data) {
      if (item.resource === "folder") {
        folders.push({
          id: String(item.id),
          name: String(item.name ?? ""),
          parentFolderId: item.parentFolderId ?? null,
          workflowCount: Number(item.workflowCount ?? 0),
          subFolderCount: Number(item.subFolderCount ?? 0),
        });
      } else {
        workflowIds.push(String(item.id));
      }
    }
    skip += page.data.length;
    if (page.data.length === 0 || skip >= page.count) break;
  }
  return { folders, workflowIds };
}
```

- [ ] Verify: `bunx tsc --noEmit`.

---

## Task 2: Resolve the primary project id from the catalog

**File:** Modify `src/catalog/service.ts`

The folder browser needs a `projectId`. Derive it from the existing workflow catalog (no extra API call).

- [ ] Add to `src/catalog/service.ts`:

```ts
export async function getPrimaryProjectId(): Promise<string | null> {
  const counts = new Map<string, number>();
  for await (const row of streamJsonl<WorkflowRow>(catalogPaths.workflows)) {
    if (row.projectId) counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [projectId, count] of counts) {
    if (count > bestCount) {
      best = projectId;
      bestCount = count;
    }
  }
  return best;
}
```

- [ ] Add the needed imports to `service.ts` if missing: `streamJsonl` from `./jsonl.js`, `WorkflowRow` from `./types.js`, `catalogPaths` from `./paths.js` (some are already imported — do not duplicate).

- [ ] Verify: `bunx tsc --noEmit`.

---

## Task 3: Hook — load a folder's children with full workflow data

**File:** Create `src/hooks/use-folder-children.ts`

Fetches a folder's direct children from the internal API and joins workflow ids against the public-API catalog (`getWorkflowMap`) so workflow items have full data (`active`, `webhooks`, `url`, etc).

```ts
import { useCachedPromise } from "@raycast/utils";
import { N8nInternalClient } from "../api/internal-client.js";
import { getInstanceUrl, getInternalCredentials } from "../api/preferences.js";
import { getWorkflowMap } from "../catalog/service.js";
import { FolderChild } from "../api/internal-client.js";
import { WorkflowRow } from "../catalog/types.js";

export interface FolderContents {
  folders: FolderChild[];
  workflows: WorkflowRow[];
}

export function useFolderChildren(args: {
  projectId: string | null;
  folderId: string;
  syncToken: number;
}) {
  return useCachedPromise(
    (projectId: string | null, folderId: string, token: number) => async (): Promise<FolderContents> => {
      void token;
      if (!projectId) return { folders: [], workflows: [] };
      const credentials = getInternalCredentials();
      if (!credentials) {
        throw new Error("Add your n8n login email and password in preferences to browse folders.");
      }
      const client = new N8nInternalClient(getInstanceUrl(), credentials.email, credentials.password);
      const [children, workflowMap] = await Promise.all([
        client.fetchFolderChildren(projectId, folderId),
        getWorkflowMap(),
      ]);
      const workflows = children.workflowIds
        .map((id) => workflowMap.get(id))
        .filter((row): row is WorkflowRow => row !== undefined);
      return { folders: children.folders, workflows };
    },
    [args.projectId, args.folderId, args.syncToken],
    { keepPreviousData: true },
  );
}
```

- [ ] Verify: `bunx tsc --noEmit`.

---

## Task 4: The FolderBrowser pushed view

**File:** Create `src/components/folder-browser.tsx`

A `<List>` showing one folder's direct children. Subfolders push another `FolderBrowser`. "Go Up": when rendered as a pushed view it `pop()`s; at the project root there is no up. Each browser writes its folder id to local storage as the "last folder" so the position is remembered.

```tsx
import { Action, ActionPanel, Color, Icon, List, useNavigation } from "@raycast/api";
import { useLocalStorage } from "@raycast/utils";
import { useEffect } from "react";
import { FolderChild } from "../api/internal-client.js";
import { useFolderChildren } from "../hooks/use-folder-children.js";
import { WorkflowListItem } from "./workflow-list-item.js";

const LAST_FOLDER_KEY = "last-folder-id";

export function FolderBrowser({
  projectId,
  folderId,
  folderName,
  syncToken,
  onRefresh,
  isPushed,
}: {
  projectId: string | null;
  folderId: string;
  folderName: string;
  syncToken: number;
  onRefresh: () => void;
  isPushed: boolean;
}) {
  const { push, pop } = useNavigation();
  const { setValue: setLastFolder } = useLocalStorage<string>(LAST_FOLDER_KEY, "0");
  const contents = useFolderChildren({ projectId, folderId, syncToken });

  useEffect(() => {
    setLastFolder(folderId);
  }, [folderId, setLastFolder]);

  const folders = contents.data?.folders ?? [];
  const workflows = contents.data?.workflows ?? [];

  function openFolder(child: FolderChild) {
    push(
      <FolderBrowser
        projectId={projectId}
        folderId={child.id}
        folderName={child.name}
        syncToken={syncToken}
        onRefresh={onRefresh}
        isPushed
      />,
    );
  }

  const upAction = isPushed ? (
    <Action
      title="Go Up"
      icon={Icon.ArrowUp}
      shortcut={{ modifiers: ["cmd"], key: "[" }}
      onAction={pop}
    />
  ) : null;

  return (
    <List
      isLoading={contents.isLoading}
      navigationTitle={folderName}
      searchBarPlaceholder={`Search in "${folderName}"...`}
    >
      <List.EmptyView
        title={contents.isLoading ? "Loading..." : "Empty folder"}
        description={
          contents.error
            ? String(contents.error.message ?? contents.error)
            : "This folder has no subfolders or workflows."
        }
        icon={Icon.Folder}
        actions={<ActionPanel>{upAction}</ActionPanel>}
      />
      {folders.length > 0 && (
        <List.Section title="Folders" subtitle={String(folders.length)}>
          {folders.map((child) => (
            <List.Item
              key={child.id}
              title={child.name}
              icon={{ source: Icon.Folder, tintColor: Color.Blue }}
              accessories={[
                {
                  text: `${child.workflowCount} workflow${child.workflowCount === 1 ? "" : "s"}`,
                },
                ...(child.subFolderCount > 0
                  ? [{ text: `${child.subFolderCount} folders` }]
                  : []),
              ]}
              actions={
                <ActionPanel>
                  <Action title="Open Folder" icon={Icon.ArrowRight} onAction={() => openFolder(child)} />
                  {upAction}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {workflows.length > 0 && (
        <List.Section title="Workflows" subtitle={String(workflows.length)}>
          {workflows.map((row) => (
            <WorkflowListItem
              key={row.id}
              workflow={row}
              isPinned={false}
              onTogglePin={() => undefined}
              onVisit={() => undefined}
              onRefresh={onRefresh}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}

export { LAST_FOLDER_KEY };
```

Note: if `WorkflowListItem`'s required props differ from this call (it is concurrently edited), read the current file and pass exactly the props it requires; keep `onTogglePin`/`onVisit` as no-ops here unless pin/visit wiring is trivial.

- [ ] Verify: `bunx tsc --noEmit`.

---

## Task 5: Entry point + restore last folder

**File:** Modify `src/search-workflows.tsx` (read fresh first — concurrently edited)

Two minimal, additive changes:

- [ ] Add an action **"Browse Folders"** to the top-level command that pushes the root `FolderBrowser`. Put it on the `List.EmptyView` action panel and, if straightforward, also reachable when results exist (e.g. as an item action). It needs `projectId` from `getPrimaryProjectId()` — load it via `useCachedPromise(getPrimaryProjectId, [sync.syncToken])`.

- [ ] On command mount, if local storage `last-folder-id` is set and not `"0"`, auto-push the `FolderBrowser` for it once, so the user resumes where they were. Use `useNavigation().push` inside a `useEffect` guarded by a `useRef` so it fires exactly once. The pushed browser for the restored folder gets `isPushed` so its "Go Up" / Esc returns to the command.

Concrete shape:

```tsx
const projectIdQuery = useCachedPromise(getPrimaryProjectId, [sync.syncToken]);
const { value: lastFolderId, isLoading: lastFolderLoading } =
  useLocalStorage<string>("last-folder-id", "0");
const { push } = useNavigation();
const restoredRef = useRef(false);

useEffect(() => {
  if (restoredRef.current) return;
  if (lastFolderLoading || projectIdQuery.isLoading) return;
  if (lastFolderId && lastFolderId !== "0" && projectIdQuery.data) {
    restoredRef.current = true;
    push(
      <FolderBrowser
        projectId={projectIdQuery.data}
        folderId={lastFolderId}
        folderName="Folder"
        syncToken={sync.syncToken}
        onRefresh={sync.resync}
        isPushed
      />,
    );
  }
}, [lastFolderId, lastFolderLoading, projectIdQuery.data, projectIdQuery.isLoading, push, sync.syncToken, sync.resync]);
```

The "Browse Folders" root action:

```tsx
<Action
  title="Browse Folders"
  icon={Icon.Folder}
  shortcut={{ modifiers: ["cmd"], key: "b" }}
  onAction={() =>
    push(
      <FolderBrowser
        projectId={projectIdQuery.data ?? null}
        folderId="0"
        folderName="All Folders"
        syncToken={sync.syncToken}
        onRefresh={sync.resync}
        isPushed
      />,
    )
  }
/>
```

Imports to add: `useEffect`, `useRef` from `react`; `useNavigation` from `@raycast/api`; `useLocalStorage` from `@raycast/utils`; `FolderBrowser` from `./components/folder-browser.js`; `getPrimaryProjectId` from `./catalog/service.js`; `useCachedPromise` from `@raycast/utils`.

- [ ] Leave the existing pinned-folder / `folderIds` filter code in place for now (do not rip it out — the user may still rely on it; the new browser is additive).

- [ ] Verify: `bunx tsc --noEmit && bunx ray build -e dist`.

---

## Task 6: Verify

- [ ] `bunx tsc --noEmit` — clean.
- [ ] `bunx vitest run` — existing tests still pass.
- [ ] `bunx ray build -e dist` — builds.
- [ ] Do NOT commit. Report what changed and that the user should smoke-test via `ray develop`: open the command → "Browse Folders" (⌘B) → drill into "Revo Fitness" (should show 4 subfolders + 1 workflow) → open a subfolder → "Go Up" / Esc → reopen the command to confirm it restores the last folder.

## Notes

- Workflow items inside the browser come from the public-API catalog; if the catalog is stale a workflow id may be missing — it is simply omitted (filtered out). Acceptable for v1.
- "Go Up" via `pop()` works because every level except the restored entry is reached by `push`. The restored-folder entry's "Go Up" also `pop()`s back to the root command — acceptable (the root command is the workflow list).
