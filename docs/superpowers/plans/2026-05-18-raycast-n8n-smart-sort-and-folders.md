# Raycast n8n Extension — Smart Sort & Folder Pinning Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Run each task's verification before committing.

**Goal:** Add (1) smart frecency-based workflow sorting with the 3 most-recently-opened on top, and (2) folder pinning that scopes the workflow list to a folder and its subfolders.

**Repo:** `/Users/idokraicer/Developer/raycast-n8n-workflows` (already built — this plan extends it).

**Architecture:** The public API can't map workflows to folders, so folder data comes from n8n's **internal `/rest` API** via a stored email/password login. A new internal client logs in (`POST /rest/login`), then pulls `/rest/workflows` (each workflow carries `parentFolder`) to stamp `folderId`/`folderName` onto catalog rows. Smart sorting is a pure frecency score (open history) blended with edit-recency (`updatedAt`); the catalog is small (~225 workflows) so search loads all rows, scores, sorts, and pages in memory.

**Verified internal-API facts** (probed live — do not re-derive):
- `POST /rest/login` — body `{"emailOrLdapLoginId": "<email>", "password": "<pw>"}`, requires a `browser-id` header (any stable UUID the client generates). Returns `Set-Cookie: n8n-auth=<jwt>`.
- Every authenticated `/rest` request needs **both** the `n8n-auth` cookie **and** the matching `browser-id` header. n8n stores a hash of the browser-id in the cookie JWT; a cookie copied from a real browser cannot be replayed (different browser-id) — which is why the extension must log in itself.
- `GET /rest/workflows?includeFolders=false&skip=N&take=100&sortBy=updatedAt:desc` → `{ count, data: [...] }`. `take` is capped at 100; paginate with `skip`. Each workflow object includes `id`, `name`, `updatedAt`, `tags`, `homeProject`, and **`parentFolder`** (`{id, name, parentFolderId}` or `null` for root-level). It does NOT include `nodes` or `active` — so the public-API catalog is still needed for webhooks/active state. The internal API is used ONLY to obtain the workflow→folder map.
- The instance has no MFA on this account (`usedMfa:false`).

**Conventions:** explicit `.js` import extensions; `bun`/`bunx`; commit per task with Conventional Commits; verification must pass before commit.

**Reference:** the existing extension's files under `src/`. Read them before editing.

---

## Task 1: Add internal-API login preferences

**Files:**
- Modify: `package.json` (the `preferences` array)

- [ ] **Step 1: Append two optional preferences after the existing `apiKey` entry**

In `package.json`, the `preferences` array currently ends with the `apiKey` object. Add these two objects after it (inside the array):

```json
    {
      "name": "n8nEmail",
      "title": "n8n Login Email",
      "description": "Optional. The email you log into n8n with. Enables folder filtering via n8n's internal API.",
      "type": "textfield",
      "required": false
    },
    {
      "name": "n8nPassword",
      "title": "n8n Login Password",
      "description": "Optional. Your n8n login password, stored in the macOS Keychain. Enables folder filtering.",
      "type": "password",
      "required": false
    }
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx ray lint`
Expected: no errors (the title-case "n8n" warnings from before are pre-existing and acceptable).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add optional n8n login preferences for folder filtering"
```

---

## Task 2: Frecency scoring utility (TDD)

**Files:**
- Create: `src/utils/frecency.ts`
- Test: `src/utils/frecency.test.ts`

- [ ] **Step 1: Write the failing test `src/utils/frecency.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { editRecencyScore, frecencyScore, smartScore } from "./frecency.js";

const NOW = Date.parse("2026-05-18T12:00:00.000Z");
const hoursAgo = (h: number) => NOW - h * 3600_000;
const daysAgo = (d: number) => NOW - d * 24 * 3600_000;

describe("frecencyScore", () => {
  it("is 0 with no visits", () => {
    expect(frecencyScore([], NOW)).toBe(0);
  });

  it("weights a very recent visit highest", () => {
    expect(frecencyScore([hoursAgo(1)], NOW)).toBe(100);
  });

  it("weights an old visit lowest", () => {
    expect(frecencyScore([daysAgo(90)], NOW)).toBe(10);
  });

  it("sums multiple visits so frequency raises the score", () => {
    const oneRecent = frecencyScore([hoursAgo(1)], NOW);
    const threeRecent = frecencyScore([hoursAgo(1), hoursAgo(2), hoursAgo(3)], NOW);
    expect(threeRecent).toBeGreaterThan(oneRecent);
    expect(threeRecent).toBe(300);
  });
});

describe("editRecencyScore", () => {
  it("returns 0 for an unparseable date", () => {
    expect(editRecencyScore("not-a-date", NOW)).toBe(0);
  });

  it("scores a recently edited workflow highly", () => {
    expect(editRecencyScore(new Date(hoursAgo(2)).toISOString(), NOW)).toBe(100);
  });
});

describe("smartScore", () => {
  it("blends frecency with half-weighted edit recency", () => {
    const score = smartScore(
      { updatedAt: new Date(hoursAgo(2)).toISOString() },
      [hoursAgo(1)],
      NOW,
    );
    expect(score).toBe(100 + 100 * 0.5);
  });

  it("ranks an often-opened workflow above a stale never-opened one", () => {
    const opened = smartScore({ updatedAt: new Date(daysAgo(60)).toISOString() }, [hoursAgo(1), hoursAgo(5)], NOW);
    const stale = smartScore({ updatedAt: new Date(daysAgo(60)).toISOString() }, [], NOW);
    expect(opened).toBeGreaterThan(stale);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/utils/frecency.test.ts`
Expected: FAIL — cannot resolve `./frecency.js`.

- [ ] **Step 3: Write `src/utils/frecency.ts`**

```ts
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

const AGE_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [4 * HOUR_MS, 100],
  [DAY_MS, 80],
  [3 * DAY_MS, 60],
  [7 * DAY_MS, 40],
  [30 * DAY_MS, 20],
];

const OLDEST_WEIGHT = 10;
const EDIT_RECENCY_WEIGHT = 0.5;

function ageWeight(ageMs: number): number {
  if (ageMs < 0) return AGE_BUCKETS[0][1];
  for (const [maxAge, weight] of AGE_BUCKETS) {
    if (ageMs < maxAge) return weight;
  }
  return OLDEST_WEIGHT;
}

export function frecencyScore(visitTimestamps: number[], now: number = Date.now()): number {
  return visitTimestamps.reduce((sum, ts) => sum + ageWeight(now - ts), 0);
}

export function editRecencyScore(updatedAt: string, now: number = Date.now()): number {
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return 0;
  return ageWeight(now - ts);
}

export function smartScore(
  workflow: { updatedAt: string },
  visitTimestamps: number[],
  now: number = Date.now(),
): number {
  return (
    frecencyScore(visitTimestamps, now) +
    editRecencyScore(workflow.updatedAt, now) * EDIT_RECENCY_WEIGHT
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/utils/frecency.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/frecency.ts src/utils/frecency.test.ts
git commit -m "feat: add frecency-based smart scoring"
```

---

## Task 3: Folder-tree descendants utility (TDD)

**Files:**
- Create: `src/catalog/folder-tree.ts`
- Test: `src/catalog/folder-tree.test.ts`

- [ ] **Step 1: Write the failing test `src/catalog/folder-tree.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { folderDescendantIds } from "./folder-tree.js";
import { FolderRow } from "./types.js";

function folder(id: string, parentFolderId: string | null): FolderRow {
  return {
    id,
    name: id,
    projectId: "p1",
    projectName: "Project",
    parentFolderId,
    path: [id],
    workflowCount: 0,
    url: "",
  };
}

// root -> a -> a1, a2 ; root -> b
const folders: FolderRow[] = [
  folder("root", null),
  folder("a", "root"),
  folder("a1", "a"),
  folder("a2", "a"),
  folder("b", "root"),
];

describe("folderDescendantIds", () => {
  it("includes the folder itself and all nested descendants", () => {
    expect([...folderDescendantIds(folders, "root")].sort()).toEqual(
      ["a", "a1", "a2", "b", "root"].sort(),
    );
  });

  it("includes a mid-tree folder and its children only", () => {
    expect([...folderDescendantIds(folders, "a")].sort()).toEqual(["a", "a1", "a2"].sort());
  });

  it("returns just the folder itself for a leaf", () => {
    expect([...folderDescendantIds(folders, "a1")]).toEqual(["a1"]);
  });

  it("returns just the id when the folder is not in the list", () => {
    expect([...folderDescendantIds(folders, "missing")]).toEqual(["missing"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/catalog/folder-tree.test.ts`
Expected: FAIL — cannot resolve `./folder-tree.js`.

- [ ] **Step 3: Write `src/catalog/folder-tree.ts`**

```ts
import { FolderRow } from "./types.js";

export function folderDescendantIds(folders: FolderRow[], rootFolderId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentFolderId) continue;
    const siblings = childrenByParent.get(folder.parentFolderId) ?? [];
    siblings.push(folder.id);
    childrenByParent.set(folder.parentFolderId, siblings);
  }

  const result = new Set<string>([rootFolderId]);
  const queue: string[] = [rootFolderId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenByParent.get(current) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/catalog/folder-tree.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/catalog/folder-tree.ts src/catalog/folder-tree.test.ts
git commit -m "feat: add folder-tree descendant resolution"
```

---

## Task 4: Internal n8n API client

**Files:**
- Create: `src/api/internal-client.ts`

This client is not unit-tested (it does network I/O + `LocalStorage`); it is verified in the Task 14 smoke test. It mirrors how the n8n web UI authenticates.

- [ ] **Step 1: Write `src/api/internal-client.ts`**

```ts
import { LocalStorage } from "@raycast/api";

const BROWSER_ID_STORAGE_KEY = "n8n-internal-browser-id";

interface InternalWorkflow {
  id: string;
  parentFolder: { id: string; name: string } | null;
}

interface InternalWorkflowsResponse {
  count: number;
  data: InternalWorkflow[];
}

export interface WorkflowFolderRef {
  folderId: string;
  folderName: string;
}

const PAGE_SIZE = 100;

export class N8nInternalClient {
  private cookie: string | null = null;
  private browserId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly password: string,
  ) {}

  private async getBrowserId(): Promise<string> {
    if (this.browserId) return this.browserId;
    let id = await LocalStorage.getItem<string>(BROWSER_ID_STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      await LocalStorage.setItem(BROWSER_ID_STORAGE_KEY, id);
    }
    this.browserId = id;
    return id;
  }

  private async login(): Promise<void> {
    const browserId = await this.getBrowserId();
    const response = await fetch(`${this.baseUrl}/rest/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "browser-id": browserId },
      body: JSON.stringify({ emailOrLdapLoginId: this.email, password: this.password }),
    });
    if (!response.ok) {
      throw new Error(
        `n8n login failed (HTTP ${response.status}). Check the n8n login email and password in preferences.`,
      );
    }
    const setCookies = response.headers.getSetCookie?.() ?? [];
    const authCookie = setCookies
      .map((entry) => entry.split(";")[0])
      .find((entry) => entry.startsWith("n8n-auth="));
    if (!authCookie) {
      throw new Error("n8n login succeeded but returned no auth cookie.");
    }
    this.cookie = authCookie;
  }

  private async restGet<T>(path: string): Promise<T> {
    if (!this.cookie) await this.login();
    const browserId = await this.getBrowserId();

    const send = () =>
      fetch(`${this.baseUrl}${path}`, {
        headers: {
          Accept: "application/json",
          "browser-id": browserId,
          Cookie: this.cookie ?? "",
        },
      });

    let response = await send();
    if (response.status === 401) {
      await this.login();
      response = await send();
    }
    if (!response.ok) {
      throw new Error(`n8n internal API error (HTTP ${response.status}) on ${path}`);
    }
    return (await response.json()) as T;
  }

  /** Maps workflow id -> its folder, for every workflow that lives inside a folder. */
  async fetchWorkflowFolderMap(): Promise<Map<string, WorkflowFolderRef>> {
    const map = new Map<string, WorkflowFolderRef>();
    let skip = 0;
    for (;;) {
      const page = await this.restGet<InternalWorkflowsResponse>(
        `/rest/workflows?includeFolders=false&skip=${skip}&take=${PAGE_SIZE}&sortBy=updatedAt:desc`,
      );
      for (const workflow of page.data) {
        if (workflow.parentFolder) {
          map.set(String(workflow.id), {
            folderId: String(workflow.parentFolder.id),
            folderName: String(workflow.parentFolder.name),
          });
        }
      }
      skip += page.data.length;
      if (page.data.length < PAGE_SIZE || skip >= page.count) break;
    }
    return map;
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/api/internal-client.ts
git commit -m "feat: add n8n internal API client for folder data"
```

---

## Task 5: Preferences accessor for internal credentials

**Files:**
- Modify: `src/api/types.ts` (the `N8nPreferences` interface)
- Modify: `src/api/preferences.ts`

- [ ] **Step 1: Extend `N8nPreferences` in `src/api/types.ts`**

Replace the existing `N8nPreferences` interface with:

```ts
export interface N8nPreferences {
  instanceUrl: string;
  apiKey: string;
  n8nEmail?: string;
  n8nPassword?: string;
}
```

- [ ] **Step 2: Add a credentials accessor to `src/api/preferences.ts`**

Append to `src/api/preferences.ts` (keep the existing `getInstanceUrl` and `getClient` exports):

```ts
export interface InternalCredentials {
  email: string;
  password: string;
}

export function getInternalCredentials(): InternalCredentials | null {
  const prefs = getPreferenceValues<N8nPreferences>();
  const email = prefs.n8nEmail?.trim();
  const password = prefs.n8nPassword;
  if (!email || !password) return null;
  return { email, password };
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/api/types.ts src/api/preferences.ts
git commit -m "feat: add internal-credentials preference accessor"
```

---

## Task 6: Add folder fields to the catalog types

**Files:**
- Modify: `src/catalog/types.ts`

- [ ] **Step 1: Add `folderId` and `folderName` to `WorkflowRow`**

In `src/catalog/types.ts`, the `WorkflowRow` interface currently ends with `updatedAt: string;`. Add two fields so it reads:

```ts
export interface WorkflowRow {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  tags: string[];
  triggerCount: number;
  projectId: string | null;
  webhooks: WebhookEntry[];
  url: string;
  updatedAt: string;
  folderId: string | null;
  folderName: string | null;
}
```

- [ ] **Step 2: Add `foldersAvailable` to `CatalogManifest`**

Replace the `CatalogManifest` interface with:

```ts
export interface CatalogManifest {
  schemaVersion: number;
  instanceUrl: string;
  syncedAt: string;
  workflowCount: number;
  folderCount: number;
  foldersAvailable: boolean;
}
```

- [ ] **Step 3: Extend `WorkflowSearchParams`**

Replace the `WorkflowSearchParams` interface with:

```ts
export interface WorkflowSearchParams {
  query?: string;
  status?: WorkflowStatusFilter;
  tag?: string;
  folderIds?: string[];
  visits?: Record<string, number[]>;
  limit?: number;
  offset?: number;
}
```

- [ ] **Step 4: Verify typecheck (errors are expected here)**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: errors in `src/catalog/sync.ts` (projectWorkflow misses the new fields) and possibly `search.ts` — these are fixed in Tasks 7 and 8. Do not commit yet if you want a clean build; instead commit now and let the next tasks restore green. Either is fine since each task re-checks.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/types.ts
git commit -m "feat: add folder fields to catalog types"
```

---

## Task 7: Stamp folder data during catalog sync

**Files:**
- Modify: `src/catalog/sync.ts`

- [ ] **Step 1: Add imports at the top of `src/catalog/sync.ts`**

Add to the existing import block:

```ts
import { getClient, getInstanceUrl, getInternalCredentials } from "../api/preferences.js";
import { N8nInternalClient } from "../api/internal-client.js";
```

(The `getClient, getInstanceUrl` import already exists — replace that line with the one above that also imports `getInternalCredentials`.)

- [ ] **Step 2: Give `projectWorkflow` the new fields**

In `projectWorkflow`, the returned object ends with `updatedAt: String(raw.updatedAt ?? ""),`. Add the two folder fields right after it so the return object includes:

```ts
    updatedAt: String(raw.updatedAt ?? ""),
    folderId: null,
    folderName: null,
```

- [ ] **Step 3: Stamp folder data after building workflow rows**

In `runSync()`, the code currently builds `workflowRows`, then builds `folderRows`, then writes. Insert folder stamping between building `workflowRows` and writing. After the line `const workflowRows = rawWorkflows.map((workflow) => projectWorkflow(workflow, baseUrl));` add:

```ts
    let foldersAvailable = false;
    const credentials = getInternalCredentials();
    if (credentials) {
      try {
        const internal = new N8nInternalClient(baseUrl, credentials.email, credentials.password);
        const folderMap = await internal.fetchWorkflowFolderMap();
        for (const row of workflowRows) {
          const folder = folderMap.get(row.id);
          row.folderId = folder?.folderId ?? null;
          row.folderName = folder?.folderName ?? null;
        }
        foldersAvailable = folderMap.size > 0;
      } catch {
        // Internal API unavailable (bad credentials, n8n upgrade, offline).
        // Folder filtering stays off; all public-API features are unaffected.
      }
    }
```

- [ ] **Step 4: Include `foldersAvailable` in the manifest**

In `runSync()`, the `manifest` object currently sets `folderCount: folderRows.length,`. Add `foldersAvailable,` to that object literal so it includes all six fields:

```ts
    const manifest: CatalogManifest = {
      schemaVersion: SCHEMA_VERSION,
      instanceUrl: baseUrl,
      syncedAt: new Date().toISOString(),
      workflowCount: workflowRows.length,
      folderCount: folderRows.length,
      foldersAvailable,
    };
```

- [ ] **Step 5: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors in `sync.ts`. (`search.ts` is updated next.)

- [ ] **Step 6: Commit**

```bash
git add src/catalog/sync.ts
git commit -m "feat: stamp folder data onto workflows during sync"
```

---

## Task 8: Smart-sort and folder filtering in catalog search

**Files:**
- Modify: `src/catalog/search.ts`
- Modify: `src/catalog/search.test.ts`

- [ ] **Step 1: Rewrite `src/catalog/search.ts`**

Replace the entire file with:

```ts
import { smartScore } from "../utils/frecency.js";
import { streamJsonl } from "./jsonl.js";
import {
  FolderRow,
  FolderSearchParams,
  PagedResult,
  WorkflowRow,
  WorkflowSearchParams,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 50;

function workflowSearchText(row: WorkflowRow): string {
  return [
    row.name,
    row.id,
    row.tags.join(" "),
    row.folderName ?? "",
    row.webhooks.map((w) => w.path).join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

function workflowMatches(
  row: WorkflowRow,
  params: WorkflowSearchParams,
  query: string,
  folderIds: Set<string> | null,
): boolean {
  if (params.status === "active" && (!row.active || row.isArchived)) return false;
  if (params.status === "archived" && !row.isArchived) return false;
  if (params.tag && !row.tags.includes(params.tag)) return false;
  if (folderIds && (!row.folderId || !folderIds.has(row.folderId))) return false;
  if (query && !workflowSearchText(row).includes(query)) return false;
  return true;
}

export async function searchWorkflowRows(
  filePath: string,
  params: WorkflowSearchParams,
): Promise<PagedResult<WorkflowRow>> {
  const query = (params.query ?? "").trim().toLowerCase();
  const folderIds = params.folderIds ? new Set(params.folderIds) : null;
  const visits = params.visits ?? {};
  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_PAGE_SIZE;
  const now = Date.now();

  const matched: WorkflowRow[] = [];
  for await (const row of streamJsonl<WorkflowRow>(filePath)) {
    if (workflowMatches(row, params, query, folderIds)) matched.push(row);
  }

  matched.sort((a, b) => {
    const scoreDelta =
      smartScore(b, visits[b.id] ?? [], now) - smartScore(a, visits[a.id] ?? [], now);
    if (scoreDelta !== 0) return scoreDelta;
    const editDelta = Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "");
    if (Number.isFinite(editDelta) && editDelta !== 0) return editDelta;
    return a.name.localeCompare(b.name);
  });

  return {
    rows: matched.slice(offset, offset + limit),
    hasMore: offset + limit < matched.length,
    totalCount: matched.length,
  };
}

function folderSearchText(row: FolderRow): string {
  return [row.name, row.projectName, row.path.join(" / ")].join(" ").toLowerCase();
}

export async function searchFolderRows(
  filePath: string,
  params: FolderSearchParams,
): Promise<PagedResult<FolderRow>> {
  const query = (params.query ?? "").trim().toLowerCase();
  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_PAGE_SIZE;
  const rows: FolderRow[] = [];
  let matched = 0;
  for await (const row of streamJsonl<FolderRow>(filePath)) {
    if (query && !folderSearchText(row).includes(query)) continue;
    if (matched >= offset && rows.length < limit) rows.push(row);
    matched++;
  }
  return { rows, hasMore: offset + rows.length < matched, totalCount: matched };
}

export async function collectAllFolderRows(filePath: string): Promise<FolderRow[]> {
  const rows: FolderRow[] = [];
  for await (const row of streamJsonl<FolderRow>(filePath)) {
    rows.push(row);
  }
  return rows;
}

export async function collectWorkflowMap(filePath: string): Promise<Map<string, WorkflowRow>> {
  const map = new Map<string, WorkflowRow>();
  for await (const row of streamJsonl<WorkflowRow>(filePath)) {
    map.set(row.id, row);
  }
  return map;
}
```

- [ ] **Step 2: Update `src/catalog/search.test.ts`**

The existing test builds `WorkflowRow` fixtures via a `workflow()` helper. Add the two new fields to that helper's defaults. Find the `workflow()` helper and add `folderId: null,` and `folderName: null,` to its returned object (alongside `projectId: null,`). Also add one new test inside the `describe("searchWorkflowRows", ...)` block:

```ts
  it("filters by folderIds", async () => {
    const result = await searchWorkflowRows(workflowsPath, { folderIds: ["fX"] });
    expect(result.rows.every((r) => r.folderId === "fX")).toBe(true);
  });
```

For that test to be meaningful, change one fixture workflow to have a folder. In the `workflows` fixture array, change the first entry to:

```ts
  workflow({ id: "1", name: "Sales sync", tags: ["prod"], folderId: "fX", folderName: "Folder X" }),
```

(The `workflow()` helper already spreads `partial`, so `folderId`/`folderName` passed in will override the `null` defaults.)

- [ ] **Step 3: Run the search tests**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx vitest run src/catalog/search.test.ts`
Expected: PASS — the existing tests plus the new `filters by folderIds` test. Note: the "returns all rows with no filter" and ordering-sensitive tests now return rows in smart-score order; if any existing test asserts a specific order, update its expectation to match score-sorted order (recently-updated first). Adjust assertions minimally to reflect the new ordering, keeping the test intent.

- [ ] **Step 4: Verify the full suite + typecheck**

Run: `bunx vitest run && bunx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/search.ts src/catalog/search.test.ts
git commit -m "feat: smart-sort workflow search and add folder filtering"
```

---

## Task 9: Visits and pinned-folder hooks

**Files:**
- Create: `src/hooks/use-visits.ts`
- Create: `src/hooks/use-pinned-folder.ts`
- Delete: `src/hooks/use-recents.ts`

`use-visits.ts` replaces `use-recents.ts`: it stores visit timestamps (for frecency), not just a recency-ordered id list.

- [ ] **Step 1: Write `src/hooks/use-visits.ts`**

```ts
import { useLocalStorage } from "@raycast/utils";

const STORAGE_KEY = "workflow-visits";
const MAX_VISITS_PER_WORKFLOW = 10;

export interface VisitsState {
  visits: Record<string, number[]>;
  isLoading: boolean;
  recordVisit: (id: string) => void;
  recentIds: (count: number) => string[];
}

export function useVisits(): VisitsState {
  const { value, setValue, isLoading } = useLocalStorage<Record<string, number[]>>(STORAGE_KEY, {});
  const visits = value ?? {};

  return {
    visits,
    isLoading,
    recordVisit: (id) => {
      const next = { ...visits };
      const timestamps = [Date.now(), ...(next[id] ?? [])].slice(0, MAX_VISITS_PER_WORKFLOW);
      next[id] = timestamps;
      setValue(next);
    },
    recentIds: (count) =>
      Object.entries(visits)
        .map(([id, timestamps]) => ({ id, last: timestamps[0] ?? 0 }))
        .sort((a, b) => b.last - a.last)
        .slice(0, count)
        .map((entry) => entry.id),
  };
}
```

- [ ] **Step 2: Write `src/hooks/use-pinned-folder.ts`**

```ts
import { useLocalStorage } from "@raycast/utils";

const STORAGE_KEY = "pinned-folder-id";

export interface PinnedFolderState {
  pinnedFolderId: string | null;
  isLoading: boolean;
  pinFolder: (id: string) => void;
  unpinFolder: () => void;
}

export function usePinnedFolder(): PinnedFolderState {
  const { value, setValue, isLoading } = useLocalStorage<string>(STORAGE_KEY, "");
  return {
    pinnedFolderId: value ? value : null,
    isLoading,
    pinFolder: (id) => setValue(id),
    unpinFolder: () => setValue(""),
  };
}
```

- [ ] **Step 3: Delete the obsolete recents hook**

```bash
cd /Users/idokraicer/Developer/raycast-n8n-workflows && git rm src/hooks/use-recents.ts
```

(Tasks 12–13 update the importers; a typecheck failure here is expected until then.)

- [ ] **Step 4: Verify the new files typecheck in isolation**

Run: `bunx tsc --noEmit src/hooks/use-visits.ts src/hooks/use-pinned-folder.ts`
Expected: no errors in these two files (ignore errors elsewhere from the deleted `use-recents.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-visits.ts src/hooks/use-pinned-folder.ts
git commit -m "feat: add visit-tracking and pinned-folder hooks"
```

---

## Task 10: Wire folders + visits into the service and search hooks

**Files:**
- Modify: `src/catalog/service.ts`
- Modify: `src/hooks/use-catalog-search.ts`

- [ ] **Step 1: Add `getAllFolders` to `src/catalog/service.ts`**

The file imports from `./search.js` and re-exports search helpers. Update the `./search.js` import to also import `collectAllFolderRows`, and add a `getAllFolders` export. After the change the file is:

```ts
import { catalogPaths } from "./paths.js";
import {
  collectAllFolderRows,
  collectWorkflowMap,
  searchFolderRows,
  searchWorkflowRows,
} from "./search.js";
import {
  FolderRow,
  FolderSearchParams,
  PagedResult,
  WorkflowRow,
  WorkflowSearchParams,
} from "./types.js";

export function searchWorkflows(params: WorkflowSearchParams): Promise<PagedResult<WorkflowRow>> {
  return searchWorkflowRows(catalogPaths.workflows, params);
}

export function searchFolders(params: FolderSearchParams): Promise<PagedResult<FolderRow>> {
  return searchFolderRows(catalogPaths.folders, params);
}

export function getAllFolders(): Promise<FolderRow[]> {
  return collectAllFolderRows(catalogPaths.folders);
}

export function getWorkflowMap(): Promise<Map<string, WorkflowRow>> {
  return collectWorkflowMap(catalogPaths.workflows);
}

export { catalogExists, syncCatalog } from "./sync.js";
```

- [ ] **Step 2: Rewrite `src/hooks/use-catalog-search.ts`**

Replace the whole file with:

```ts
import { useCachedPromise } from "@raycast/utils";
import { getAllFolders, getWorkflowMap, searchFolders, searchWorkflows } from "../catalog/service.js";
import { WorkflowStatusFilter } from "../catalog/types.js";

const PAGE_SIZE = 50;

export function useWorkflowSearch(args: {
  query: string;
  status: WorkflowStatusFilter;
  tag?: string;
  folderIds?: string[];
  visits: Record<string, number[]>;
  syncToken: number;
  enabled: boolean;
}) {
  return useCachedPromise(
    (
        query: string,
        status: WorkflowStatusFilter,
        tag: string | undefined,
        folderIds: string[] | undefined,
        visits: Record<string, number[]>,
        token: number,
      ) =>
      async (options: { page: number }) => {
        void token;
        const result = await searchWorkflows({
          query,
          status,
          tag,
          folderIds,
          visits,
          offset: options.page * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        return { data: result.rows, hasMore: result.hasMore };
      },
    [args.query, args.status, args.tag, args.folderIds, args.visits, args.syncToken],
    { keepPreviousData: true, execute: args.enabled },
  );
}

export function useFolderSearch(args: { query: string; syncToken: number; enabled: boolean }) {
  return useCachedPromise(
    (query: string, token: number) =>
      async (options: { page: number }) => {
        void token;
        const result = await searchFolders({
          query,
          offset: options.page * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        return { data: result.rows, hasMore: result.hasMore };
      },
    [args.query, args.syncToken],
    { keepPreviousData: true, execute: args.enabled },
  );
}

export function useAllFolders(syncToken: number) {
  return useCachedPromise(
    (token: number) => {
      void token;
      return getAllFolders();
    },
    [syncToken],
    { keepPreviousData: true },
  );
}

export function useWorkflowMap(syncToken: number) {
  return useCachedPromise(
    (token: number) => {
      void token;
      return getWorkflowMap();
    },
    [syncToken],
    { keepPreviousData: true },
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: errors only in `src/search-workflows.tsx` and the component files (updated in Tasks 11–13). `service.ts` and `use-catalog-search.ts` themselves must be error-free.

- [ ] **Step 4: Commit**

```bash
git add src/catalog/service.ts src/hooks/use-catalog-search.ts
git commit -m "feat: expose all-folders query and folder/visit-aware search hooks"
```

---

## Task 11: Folder accessory and unfocus action on the workflow item

**Files:**
- Modify: `src/components/workflow-list-item.tsx`

- [ ] **Step 1: Replace the whole file with:**

```tsx
import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Icon,
  Keyboard,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { memo } from "react";
import { WorkflowRow } from "../catalog/types.js";
import { ExecutionsView } from "./executions-view.js";

export const WorkflowListItem = memo(function WorkflowListItem({
  workflow,
  isPinned,
  onTogglePin,
  onVisit,
  onRefresh,
  focusedFolderName,
  onUnfocusFolder,
}: {
  workflow: WorkflowRow;
  isPinned: boolean;
  onTogglePin: () => void;
  onVisit: () => void;
  onRefresh: () => void;
  focusedFolderName?: string;
  onUnfocusFolder?: () => void;
}) {
  const webhook = workflow.webhooks[0];

  const statusIcon = workflow.isArchived
    ? { source: Icon.Tray, tintColor: Color.SecondaryText }
    : workflow.active
      ? { source: Icon.CircleFilled, tintColor: Color.Green }
      : { source: Icon.CircleDisabled, tintColor: Color.SecondaryText };

  const accessories: List.Item.Accessory[] = [];
  if (isPinned) {
    accessories.push({ icon: { source: Icon.Star, tintColor: Color.Yellow } });
  }
  if (workflow.folderName) {
    accessories.push({
      icon: { source: Icon.Folder, tintColor: Color.Blue },
      tooltip: workflow.folderName,
    });
  }
  for (const tag of workflow.tags.slice(0, 3)) {
    accessories.push({ tag });
  }
  if (workflow.isArchived) {
    accessories.push({ tag: { value: "Archived", color: Color.SecondaryText } });
  }

  async function copyWebhookUrl() {
    if (!webhook) {
      await showToast({ style: Toast.Style.Failure, title: "This workflow has no webhook" });
      return;
    }
    await Clipboard.copy(webhook.productionUrl);
    await showToast({ style: Toast.Style.Success, title: "Webhook URL copied" });
  }

  return (
    <List.Item
      title={workflow.name || "(untitled workflow)"}
      subtitle={workflow.folderName ?? workflow.id}
      keywords={webhook ? [webhook.path] : undefined}
      icon={statusIcon}
      accessories={accessories}
      actions={
        <ActionPanel>
          <Action.OpenInBrowser title="Open in n8n" url={workflow.url} onOpen={onVisit} />
          <Action.Push
            title="View Executions"
            icon={Icon.Clock}
            shortcut={{ key: "tab", modifiers: [] }}
            target={<ExecutionsView workflow={workflow} />}
            onPush={onVisit}
          />
          <Action
            title={isPinned ? "Unpin Workflow" : "Pin Workflow"}
            icon={isPinned ? Icon.StarDisabled : Icon.Star}
            shortcut={Keyboard.Shortcut.Common.Pin}
            onAction={onTogglePin}
          />
          {onUnfocusFolder && (
            <Action
              title={`Exit Folder Focus${focusedFolderName ? ` (${focusedFolderName})` : ""}`}
              icon={Icon.XMarkCircle}
              shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
              onAction={onUnfocusFolder}
            />
          )}
          <Action.CopyToClipboard
            title="Copy Workflow URL"
            content={workflow.url}
            shortcut={{ modifiers: ["cmd"], key: "c" }}
          />
          {webhook && (
            <Action
              title="Copy Webhook URL"
              icon={Icon.Link}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
              onAction={copyWebhookUrl}
            />
          )}
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={onRefresh}
          />
        </ActionPanel>
      }
    />
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add src/components/workflow-list-item.tsx
git commit -m "feat: show folder on workflow items and add exit-focus action"
```

---

## Task 12: Focus action on the folder item

**Files:**
- Modify: `src/components/folder-list-item.tsx`

- [ ] **Step 1: Replace the whole file with:**

```tsx
import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { memo } from "react";
import { FolderRow } from "../catalog/types.js";

export const FolderListItem = memo(function FolderListItem({
  folder,
  isFocused,
  onToggleFocus,
  onRefresh,
}: {
  folder: FolderRow;
  isFocused: boolean;
  onToggleFocus: () => void;
  onRefresh: () => void;
}) {
  const accessories: List.Item.Accessory[] = [];
  if (isFocused) {
    accessories.push({ tag: { value: "Focused", color: Color.Green } });
  }
  accessories.push({
    text: `${folder.workflowCount} workflow${folder.workflowCount === 1 ? "" : "s"}`,
  });
  if (folder.projectName) {
    accessories.push({ tag: { value: folder.projectName, color: Color.Purple } });
  }

  return (
    <List.Item
      title={folder.name}
      subtitle={folder.path.length > 1 ? folder.path.join(" / ") : undefined}
      keywords={folder.path}
      icon={{
        source: isFocused ? Icon.Eye : Icon.Folder,
        tintColor: isFocused ? Color.Green : Color.Blue,
      }}
      accessories={accessories}
      actions={
        <ActionPanel>
          <Action
            title={isFocused ? "Exit Folder Focus" : "Focus This Folder"}
            icon={isFocused ? Icon.XMarkCircle : Icon.Eye}
            onAction={onToggleFocus}
          />
          {folder.url && <Action.OpenInBrowser title="Open Folder in n8n" url={folder.url} />}
          {folder.url && (
            <Action.CopyToClipboard
              title="Copy Folder URL"
              content={folder.url}
              shortcut={{ modifiers: ["cmd"], key: "c" }}
            />
          )}
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={onRefresh}
          />
        </ActionPanel>
      }
    />
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add src/components/folder-list-item.tsx
git commit -m "feat: add focus-folder action to folder items"
```

---

## Task 13: Rewrite the Search Workflows command

**Files:**
- Modify: `src/search-workflows.tsx`

- [ ] **Step 1: Replace the whole file with:**

```tsx
import { Icon, List } from "@raycast/api";
import { useMemo, useState } from "react";
import { folderDescendantIds } from "./catalog/folder-tree.js";
import { WorkflowStatusFilter } from "./catalog/types.js";
import { FolderListItem } from "./components/folder-list-item.js";
import { WorkflowListItem } from "./components/workflow-list-item.js";
import { useAllFolders, useFolderSearch, useWorkflowSearch } from "./hooks/use-catalog-search.js";
import { useCatalogSync } from "./hooks/use-catalog-sync.js";
import { usePinned } from "./hooks/use-pinned.js";
import { usePinnedFolder } from "./hooks/use-pinned-folder.js";
import { useVisits } from "./hooks/use-visits.js";

type Filter = "all" | "type:workflows" | "type:folders" | "status:active" | "status:archived";

const RECENT_COUNT = 3;

export default function SearchWorkflows() {
  const [filter, setFilter] = useState<Filter>("all");
  const [searchText, setSearchText] = useState("");
  const sync = useCatalogSync();
  const pinned = usePinned();
  const visits = useVisits();
  const pinnedFolder = usePinnedFolder();
  const allFolders = useAllFolders(sync.syncToken);

  const focusedFolder = useMemo(
    () =>
      pinnedFolder.pinnedFolderId
        ? ((allFolders.data ?? []).find((f) => f.id === pinnedFolder.pinnedFolderId) ?? null)
        : null,
    [allFolders.data, pinnedFolder.pinnedFolderId],
  );

  const folderIds = useMemo(
    () =>
      pinnedFolder.pinnedFolderId
        ? [...folderDescendantIds(allFolders.data ?? [], pinnedFolder.pinnedFolderId)]
        : undefined,
    [allFolders.data, pinnedFolder.pinnedFolderId],
  );

  const showWorkflows = filter !== "type:folders";
  const showFolders = !pinnedFolder.pinnedFolderId && (filter === "all" || filter === "type:folders");
  const status: WorkflowStatusFilter =
    filter === "status:active" ? "active" : filter === "status:archived" ? "archived" : "all";

  const workflows = useWorkflowSearch({
    query: searchText,
    status,
    folderIds,
    visits: visits.visits,
    syncToken: sync.syncToken,
    enabled: showWorkflows,
  });
  const folders = useFolderSearch({
    query: searchText,
    syncToken: sync.syncToken,
    enabled: showFolders,
  });

  const workflowRows = useMemo(() => workflows.data ?? [], [workflows.data]);
  const folderRows = useMemo(() => folders.data ?? [], [folders.data]);

  const pinnedSet = useMemo(() => new Set(pinned.pinnedIds), [pinned.pinnedIds]);
  const recentSet = useMemo(
    () => new Set(visits.recentIds(RECENT_COUNT)),
    [visits],
  );

  const pinnedRows = workflowRows.filter((row) => pinnedSet.has(row.id));
  const recentRows = workflowRows.filter((row) => recentSet.has(row.id) && !pinnedSet.has(row.id));
  const otherRows = workflowRows.filter((row) => !pinnedSet.has(row.id) && !recentSet.has(row.id));

  const isLoading =
    sync.isSyncing ||
    pinned.isLoading ||
    visits.isLoading ||
    pinnedFolder.isLoading ||
    allFolders.isLoading ||
    workflows.isLoading ||
    folders.isLoading;

  const hasResults = workflowRows.length > 0 || folderRows.length > 0;
  const unfocus = pinnedFolder.pinnedFolderId ? () => pinnedFolder.unpinFolder() : undefined;
  const focusName = focusedFolder?.name;

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={
        focusName ? `Search workflows in "${focusName}"...` : "Search workflows and folders..."
      }
      navigationTitle={focusedFolder ? `Focused: ${focusedFolder.path.join(" / ")}` : undefined}
      onSearchTextChange={setSearchText}
      throttle
      pagination={showWorkflows ? workflows.pagination : folders.pagination}
      searchBarAccessory={
        <List.Dropdown tooltip="Filter" onChange={(value) => setFilter(value as Filter)} storeValue>
          <List.Dropdown.Item title="All" value="all" />
          <List.Dropdown.Section title="Type">
            <List.Dropdown.Item title="Workflows" value="type:workflows" />
            <List.Dropdown.Item title="Folders" value="type:folders" />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="Status">
            <List.Dropdown.Item title="Active" value="status:active" />
            <List.Dropdown.Item title="Archived" value="status:archived" />
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      {!isLoading && !hasResults && (
        <List.EmptyView
          title={focusName ? `No workflows in "${focusName}"` : "No results"}
          description={
            focusName
              ? "This folder has no workflows, or folder data is unavailable (add your n8n login in preferences)."
              : "Check your n8n instance URL and API key in extension preferences."
          }
          icon={Icon.MagnifyingGlass}
        />
      )}
      {showWorkflows && pinnedRows.length > 0 && (
        <List.Section title="Pinned" subtitle={String(pinnedRows.length)}>
          {pinnedRows.map((row) => (
            <WorkflowListItem
              key={row.id}
              workflow={row}
              isPinned
              onTogglePin={() => pinned.togglePin(row.id)}
              onVisit={() => visits.recordVisit(row.id)}
              onRefresh={sync.resync}
              focusedFolderName={focusName}
              onUnfocusFolder={unfocus}
            />
          ))}
        </List.Section>
      )}
      {showWorkflows && recentRows.length > 0 && (
        <List.Section title="Recent" subtitle={String(recentRows.length)}>
          {recentRows.map((row) => (
            <WorkflowListItem
              key={row.id}
              workflow={row}
              isPinned={false}
              onTogglePin={() => pinned.togglePin(row.id)}
              onVisit={() => visits.recordVisit(row.id)}
              onRefresh={sync.resync}
              focusedFolderName={focusName}
              onUnfocusFolder={unfocus}
            />
          ))}
        </List.Section>
      )}
      {showWorkflows && (
        <List.Section
          title={focusName ?? "Workflows"}
          subtitle={String(workflowRows.length)}
        >
          {otherRows.map((row) => (
            <WorkflowListItem
              key={row.id}
              workflow={row}
              isPinned={false}
              onTogglePin={() => pinned.togglePin(row.id)}
              onVisit={() => visits.recordVisit(row.id)}
              onRefresh={sync.resync}
              focusedFolderName={focusName}
              onUnfocusFolder={unfocus}
            />
          ))}
        </List.Section>
      )}
      {showFolders && (
        <List.Section title="Folders" subtitle={String(folderRows.length)}>
          {folderRows.map((row) => (
            <FolderListItem
              key={row.id}
              folder={row}
              isFocused={row.id === pinnedFolder.pinnedFolderId}
              onToggleFocus={() =>
                row.id === pinnedFolder.pinnedFolderId
                  ? pinnedFolder.unpinFolder()
                  : pinnedFolder.pinFolder(row.id)
              }
              onRefresh={sync.resync}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
```

- [ ] **Step 2: Verify typecheck and the full test suite**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit && bunx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/search-workflows.tsx
git commit -m "feat: smart-sorted workflows, recent-3 section, and folder focus"
```

---

## Task 14: Update README, build, and verify

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `README.md`**

Replace the **Features** section and the **Known limitations** section with:

```markdown
## Features

- **Smart sorting** — workflows are ranked by a frecency score (how often and how
  recently you open them) blended with edit recency, so what you are actively
  working on rises to the top.
- **Recent & pinned** — the 3 most recently opened workflows sit in a Recent
  section; pin favorites above that.
- **Folder focus** — pin a folder to scope the list to that folder and its
  subfolders for the rest of your session. Requires your n8n login (see Setup).
- **Workflow & folder search** — by name, id, tag, webhook path, or folder path.
- **Executions** — browse executions per workflow or instance-wide, by status.
- **Disk catalog** — cached locally, refreshed in the background.

## Setup

1. Install the extension.
2. Enter your **n8n Instance URL** and a **public API key** (Settings > n8n API).
3. Optional, for folder focus: enter your **n8n Login Email** and **Password**.
   These are stored in the macOS Keychain and used only to read folder
   membership from n8n's internal API (the public API does not expose it).

## Known limitations

- Folder focus relies on n8n's internal API, which is undocumented and may change
  on n8n upgrades. Without login credentials, folders are still browsable but the
  workflow list cannot be scoped to a folder.
- Project listing requires an enterprise license; project names are recovered
  from folder metadata.
```

- [ ] **Step 2: Run the full test suite**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx vitest run`
Expected: PASS — all prior tests plus the new `frecency` (8) and `folder-tree` (4) tests.

- [ ] **Step 3: Lint**

Run: `bunx ray lint`
Expected: no errors (pre-existing "n8n" title-case warnings are acceptable).

- [ ] **Step 4: Build**

Run: `bunx ray build -e dist`
Expected: build succeeds.

- [ ] **Step 5: Final typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document smart sorting and folder focus"
```

- [ ] **Step 7: Manual smoke test (human)**

Run `bunx ray develop`, then in Raycast:
1. Add your n8n login email + password in the extension preferences.
2. Open **Search n8n Workflows**; confirm workflows show a folder icon/tooltip.
3. Open a few workflows, reopen the command — confirm they appear in **Recent** (top 3) and the main list reorders toward what you opened.
4. In the **Folders** section, run **Focus This Folder** on a folder — confirm the list narrows to that folder + subfolders and the search bar shows the folder name.
5. Use **Exit Folder Focus** (`Cmd+Shift+F`) — confirm the full list returns.

---

## Verification Summary

- New unit tests: `frecency` (8), `folder-tree` (4); updated `catalog/search` tests for smart-sort order + folder filtering.
- Typecheck after every code task; lint + build in Task 14.
- Manual: folder focus + smart sort verified against the live instance (Task 14 Step 7).

## Notes for the implementer

- The internal API (`/rest`) is undocumented; `internal-client.ts` isolates it so a future n8n change touches one file.
- If `response.headers.getSetCookie` is unavailable in the runtime, fall back to parsing the raw `set-cookie` header; the optional chaining already prevents a crash, but login would then fail — surface a clear error.
- Smart-sort loads the whole workflow set into memory to sort; fine for hundreds-to-thousands of workflows. If an instance ever has tens of thousands, revisit with a pre-sorted catalog.
