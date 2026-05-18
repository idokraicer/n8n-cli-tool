# Raycast n8n Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Raycast extension that searches and browses an n8n instance — workflows, folders, and executions.

**Architecture:** New standalone repo at `/Users/idokraicer/Developer/raycast-n8n-workflows`. A small n8n API client (cursor pagination, 429 retry, timeout) feeds a single-instance disk catalog (`workflows.jsonl` + `folders.jsonl` + `manifest.json`, atomic writes, TTL + lock background sync). Two Raycast `view` commands render the catalog with `useCachedPromise`-based search/pagination. Logic is ported from `n8n-cli-tool` (`client.ts`, `webhooks.ts`, `url.ts`, `catalog.ts`); UI patterns mirror `raycast-make-scenarios`.

**Tech Stack:** TypeScript, React, `@raycast/api`, `@raycast/utils`, `ray` CLI tooling, vitest, bun (install), Node `fs`/`readline`.

**Reference repos (read-only, for porting/patterns):**
- `/Users/idokraicer/Developer/n8n-cli-tool` — n8n API logic to port.
- `/Users/idokraicer/Developer/raycast-make-scenarios` — Raycast extension patterns + working `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `assets/extension-icon.png`.

**Spec:** `/Users/idokraicer/Developer/n8n-cli-tool/docs/superpowers/specs/2026-05-18-raycast-n8n-extension-design.md`

**Verified API facts** (probed against the live instance — do not re-derive):
- `GET /api/v1/workflows?limit=250&excludePinnedData=true&cursor=…` → `{ data: RawWorkflow[], nextCursor: string|null }`. Workflow has `id, name, active, isArchived, triggerCount, tags[], nodes[], updatedAt, shared[]`. `shared[].projectId` is the home project. **No folder field.**
- `GET /api/v1/projects/{projectId}/folders` → `{ count, data: RawFolder[] }`. **Rejects `limit`/`cursor`** — fetch in one call. Folder has `id, name, parentFolderId, workflowCount, homeProject{id,name,type}`. The default response does **not** include `path` — compute it from the `parentFolderId` chain.
- `GET /api/v1/executions?limit=100&cursor=…&status=…&workflowId=…` → `{ data: RawExecution[], nextCursor }`. Execution has `id, status, mode, finished, startedAt, stoppedAt, workflowId`. **No workflow name** — join from the catalog.
- `GET /api/v1/projects` → 403 (license-gated). Never call it; derive project IDs from `workflows[].shared[].projectId`, project names from folder `homeProject.name`.

**Conventions:**
- All local imports use explicit `.js` extensions (Raycast ESM).
- After each task, the listed verification command must pass before committing.
- Commit messages use Conventional Commits.

---

## Task 1: Scaffold repo and tooling

**Files:**
- Create: `/Users/idokraicer/Developer/raycast-n8n-workflows/package.json`
- Create: `/Users/idokraicer/Developer/raycast-n8n-workflows/.gitignore`
- Create: `/Users/idokraicer/Developer/raycast-n8n-workflows/tsconfig.json`
- Create: `/Users/idokraicer/Developer/raycast-n8n-workflows/eslint.config.js` (copied)
- Create: `/Users/idokraicer/Developer/raycast-n8n-workflows/vitest.config.ts`
- Create: `/Users/idokraicer/Developer/raycast-n8n-workflows/assets/extension-icon.png` (copied placeholder)

- [ ] **Step 1: Create the directory and init git**

```bash
mkdir -p /Users/idokraicer/Developer/raycast-n8n-workflows/src /Users/idokraicer/Developer/raycast-n8n-workflows/assets
cd /Users/idokraicer/Developer/raycast-n8n-workflows
git init
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "$schema": "https://www.raycast.com/schemas/extension.json",
  "name": "n8n-workflows",
  "title": "Search n8n Workflows",
  "description": "Search and browse n8n workflows, folders, and executions",
  "icon": "extension-icon.png",
  "author": "ido_kraicer",
  "categories": ["Productivity", "Developer Tools"],
  "license": "MIT",
  "commands": [
    {
      "name": "search-workflows",
      "title": "Search n8n Workflows",
      "description": "Search workflows and folders in your n8n instance",
      "mode": "view"
    },
    {
      "name": "search-executions",
      "title": "Search n8n Executions",
      "description": "Browse recent executions across your n8n instance",
      "mode": "view"
    }
  ],
  "preferences": [
    {
      "name": "instanceUrl",
      "title": "n8n Instance URL",
      "description": "Your n8n instance base URL, e.g. https://n8n.example.com",
      "type": "textfield",
      "required": true
    },
    {
      "name": "apiKey",
      "title": "API Key",
      "description": "Your n8n public API key (Settings > n8n API)",
      "type": "password",
      "required": true
    }
  ],
  "dependencies": {
    "@raycast/api": "^1.93.0",
    "@raycast/utils": "^1.19.0"
  },
  "devDependencies": {
    "@raycast/eslint-config": "^2.1.1",
    "@types/node": "22.13.4",
    "@types/react": "19.0.8",
    "eslint": "^9.18.0",
    "prettier": "^3.4.2",
    "typescript": "^5.7.3",
    "vitest": "^3.2.4"
  },
  "scripts": {
    "build": "ray build",
    "dev": "ray develop",
    "lint": "ray lint",
    "fix-lint": "ray lint --fix",
    "test": "vitest run",
    "check": "ray lint && vitest run && ray build"
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules
raycast-env.d.ts
.raycast
dist
*.log
.eslintcache
```

- [ ] **Step 4: Copy proven config files from the Make extension**

```bash
cd /Users/idokraicer/Developer/raycast-n8n-workflows
cp /Users/idokraicer/Developer/raycast-make-scenarios/tsconfig.json ./tsconfig.json
cp /Users/idokraicer/Developer/raycast-make-scenarios/eslint.config.js ./eslint.config.js
cp /Users/idokraicer/Developer/raycast-make-scenarios/assets/extension-icon.png ./assets/extension-icon.png
```

Note: the icon is a placeholder (Make branding) so `ray build` passes; replace with n8n branding later.

- [ ] **Step 5: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 6: Install dependencies**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bun install`
Expected: dependencies install, `node_modules` created, no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/idokraicer/Developer/raycast-n8n-workflows
git add package.json .gitignore tsconfig.json eslint.config.js vitest.config.ts assets/extension-icon.png
git commit -m "chore: scaffold raycast n8n extension"
```

---

## Task 2: API types

**Files:**
- Create: `src/api/types.ts`

- [ ] **Step 1: Write `src/api/types.ts`**

```ts
export interface N8nPreferences {
  instanceUrl: string;
  apiKey: string;
}

export interface RawNode {
  name?: string;
  type?: string;
  webhookId?: string;
  parameters?: Record<string, unknown>;
}

export interface RawWorkflow {
  id: string;
  name?: string;
  active?: boolean;
  isArchived?: boolean;
  triggerCount?: number;
  createdAt?: string;
  updatedAt?: string;
  tags?: Array<{ id?: string; name?: string } | string>;
  nodes?: RawNode[];
  shared?: Array<{ projectId?: string; role?: string }>;
}

export interface RawFolder {
  id: string;
  name?: string;
  parentFolderId: string | null;
  workflowCount?: number;
  subFolderCount?: number;
  homeProject?: { id: string; name: string; type?: string } | null;
}

export interface RawExecution {
  id: string;
  status: string;
  mode: string;
  finished: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  workflowId: string;
}

export interface ListResponse<T> {
  data: T[];
  nextCursor: string | null;
}

export interface FolderListResponse {
  count: number;
  data: RawFolder[];
}

export class N8nApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "N8nApiError";
    this.status = status;
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit src/api/types.ts`
Expected: no output (success). If `tsc` complains about a missing `raycast-env.d.ts`, ignore — it is generated later by `ray build`.

- [ ] **Step 3: Commit**

```bash
git add src/api/types.ts
git commit -m "feat: add n8n API types"
```

---

## Task 3: URL utilities (TDD)

**Files:**
- Create: `src/utils/url.ts`
- Test: `src/utils/url.test.ts`

- [ ] **Step 1: Write the failing test `src/utils/url.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildExecutionUrl, buildFolderUrl, buildWorkflowUrl, normalizeBaseUrl } from "./url.js";

describe("normalizeBaseUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeBaseUrl("  https://n8n.example.com/// ")).toBe("https://n8n.example.com");
  });
});

describe("buildWorkflowUrl", () => {
  it("builds a workflow URL", () => {
    expect(buildWorkflowUrl("https://n8n.example.com/", "abc123")).toBe(
      "https://n8n.example.com/workflow/abc123",
    );
  });
});

describe("buildExecutionUrl", () => {
  it("builds an execution URL", () => {
    expect(buildExecutionUrl("https://n8n.example.com", "wf1", "999")).toBe(
      "https://n8n.example.com/workflow/wf1/executions/999",
    );
  });
});

describe("buildFolderUrl", () => {
  it("builds a folder URL", () => {
    expect(buildFolderUrl("https://n8n.example.com", "proj1", "fold1")).toBe(
      "https://n8n.example.com/projects/proj1/folders/fold1/workflows",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx vitest run src/utils/url.test.ts`
Expected: FAIL — `Failed to resolve import "./url.js"`.

- [ ] **Step 3: Write `src/utils/url.ts`**

```ts
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function buildWorkflowUrl(baseUrl: string, workflowId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/workflow/${workflowId}`;
}

export function buildExecutionUrl(baseUrl: string, workflowId: string, executionId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/workflow/${workflowId}/executions/${executionId}`;
}

export function buildFolderUrl(baseUrl: string, projectId: string, folderId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/projects/${projectId}/folders/${folderId}/workflows`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/utils/url.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/url.ts src/utils/url.test.ts
git commit -m "feat: add n8n URL builders"
```

---

## Task 4: Webhook extraction (TDD)

**Files:**
- Create: `src/utils/webhooks.ts`
- Test: `src/utils/webhooks.test.ts`

- [ ] **Step 1: Write the failing test `src/utils/webhooks.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { extractWebhooks } from "./webhooks.js";

describe("extractWebhooks", () => {
  it("returns [] when nodes is undefined", () => {
    expect(extractWebhooks(undefined, "https://n8n.example.com")).toEqual([]);
  });

  it("extracts a webhook node with explicit path and method", () => {
    const nodes = [
      {
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        parameters: { path: "my-hook", httpMethod: "post" },
      },
    ];
    expect(extractWebhooks(nodes, "https://n8n.example.com/")).toEqual([
      {
        node: "Webhook",
        method: "POST",
        path: "my-hook",
        productionUrl: "https://n8n.example.com/webhook/my-hook",
        testUrl: "https://n8n.example.com/webhook-test/my-hook",
      },
    ]);
  });

  it("treats a node with a webhookId as a webhook and defaults method to GET", () => {
    const nodes = [{ name: "Form", type: "n8n-nodes-base.formTrigger", webhookId: "abc-123" }];
    const result = extractWebhooks(nodes, "https://n8n.example.com");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ method: "GET", path: "abc-123" });
  });

  it("ignores non-webhook nodes", () => {
    const nodes = [{ name: "Set", type: "n8n-nodes-base.set" }];
    expect(extractWebhooks(nodes, "https://n8n.example.com")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/utils/webhooks.test.ts`
Expected: FAIL — cannot resolve `./webhooks.js`.

- [ ] **Step 3: Write `src/utils/webhooks.ts`**

```ts
import { RawNode } from "../api/types.js";
import { normalizeBaseUrl } from "./url.js";

export interface WebhookEntry {
  node: string;
  method: string;
  path: string;
  productionUrl: string;
  testUrl: string;
}

const WEBHOOK_NODE_TYPES = new Set([
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.formTrigger",
  "@n8n/n8n-nodes-langchain.chatTrigger",
]);

function isWebhookNode(node: RawNode): boolean {
  return (node.type !== undefined && WEBHOOK_NODE_TYPES.has(node.type)) || typeof node.webhookId === "string";
}

export function extractWebhooks(nodes: RawNode[] | undefined, baseUrl: string): WebhookEntry[] {
  if (!Array.isArray(nodes)) return [];
  const base = normalizeBaseUrl(baseUrl);
  const entries: WebhookEntry[] = [];
  for (const node of nodes) {
    if (!isWebhookNode(node)) continue;
    const params = node.parameters ?? {};
    const path = String(params.path ?? node.webhookId ?? "");
    const method = String(params.httpMethod ?? "GET").toUpperCase();
    entries.push({
      node: String(node.name ?? ""),
      method,
      path,
      productionUrl: `${base}/webhook/${path}`,
      testUrl: `${base}/webhook-test/${path}`,
    });
  }
  return entries;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/utils/webhooks.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/webhooks.ts src/utils/webhooks.test.ts
git commit -m "feat: add webhook extraction from workflow nodes"
```

---

## Task 5: Formatting utilities (TDD)

**Files:**
- Create: `src/utils/format.ts`
- Test: `src/utils/format.test.ts`

- [ ] **Step 1: Write the failing test `src/utils/format.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { formatDuration, formatTimestamp } from "./format.js";

describe("formatDuration", () => {
  it("returns '' when either timestamp is missing", () => {
    expect(formatDuration(null, "2026-05-18T10:00:01Z")).toBe("");
    expect(formatDuration("2026-05-18T10:00:00Z", null)).toBe("");
  });

  it("formats sub-second durations in ms", () => {
    expect(formatDuration("2026-05-18T10:00:00.000Z", "2026-05-18T10:00:00.450Z")).toBe("450ms");
  });

  it("formats seconds", () => {
    expect(formatDuration("2026-05-18T10:00:00.000Z", "2026-05-18T10:00:03.200Z")).toBe("3.2s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration("2026-05-18T10:00:00.000Z", "2026-05-18T10:02:05.000Z")).toBe("2m 5s");
  });
});

describe("formatTimestamp", () => {
  it("returns '' for null", () => {
    expect(formatTimestamp(null)).toBe("");
  });

  it("returns a non-empty string for a valid timestamp", () => {
    expect(formatTimestamp("2026-05-18T10:00:00.000Z").length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/utils/format.test.ts`
Expected: FAIL — cannot resolve `./format.js`.

- [ ] **Step 3: Write `src/utils/format.ts`**

```ts
export function formatDuration(startedAt: string | null, stoppedAt: string | null): string {
  if (!startedAt || !stoppedAt) return "";
  const ms = Date.parse(stoppedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/utils/format.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/format.ts src/utils/format.test.ts
git commit -m "feat: add duration and timestamp formatting"
```

---

## Task 6: n8n API client (TDD)

**Files:**
- Create: `src/api/client.ts`
- Test: `src/api/client.test.ts`

The client is config-injected (no `@raycast/api` import) so it is unit-testable with a fake `fetch`.

- [ ] **Step 1: Write the failing test `src/api/client.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { N8nClient } from "./client.js";
import { N8nApiError } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("N8nClient.request", () => {
  it("sends the API key header and returns parsed JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [], nextCursor: null }));
    const client = new N8nClient({ baseUrl: "https://n8n.example.com/", apiKey: "secret", fetchImpl });

    const result = await client.request<{ data: unknown[] }>("/workflows", { limit: "10" });

    expect(result).toEqual({ data: [], nextCursor: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://n8n.example.com/api/v1/workflows?limit=10");
    expect((init.headers as Record<string, string>)["X-N8N-API-KEY"]).toBe("secret");
  });

  it("retries on HTTP 429 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new N8nClient({
      baseUrl: "https://n8n.example.com",
      apiKey: "k",
      fetchImpl,
      retryBaseMs: 1,
    });

    const result = await client.request<{ ok: boolean }>("/workflows");

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws N8nApiError with status on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "unauthorized" }, 401));
    const client = new N8nClient({ baseUrl: "https://n8n.example.com", apiKey: "k", fetchImpl });

    await expect(client.request("/workflows")).rejects.toMatchObject({
      name: "N8nApiError",
      status: 401,
    });
  });

  it("throws when the base URL is empty", async () => {
    const client = new N8nClient({ baseUrl: "", apiKey: "k", fetchImpl: vi.fn() });
    await expect(client.request("/workflows")).rejects.toBeInstanceOf(N8nApiError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx vitest run src/api/client.test.ts`
Expected: FAIL — cannot resolve `./client.js`.

- [ ] **Step 3: Write `src/api/client.ts`**

```ts
import { N8nApiError } from "./types.js";

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(status: number, path: string): string {
  if (status === 401) return "Authentication failed. Check your n8n API key in extension preferences.";
  if (status === 403) return `Access denied for ${path}. The API key lacks permission or the feature is not licensed.`;
  if (status === 404) return `Not found: ${path}`;
  if (status === 429) return "n8n API rate limit exceeded. Try again shortly.";
  return `n8n API error ${status} on ${path}`;
}

export class N8nClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(config: ClientConfig) {
    this.baseUrl = normalize(config.baseUrl);
    this.apiKey = config.apiKey.trim();
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  }

  async request<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    if (!this.baseUrl) {
      throw new N8nApiError(0, "n8n instance URL is not set. Add it in extension preferences.");
    }
    if (!this.apiKey) {
      throw new N8nApiError(0, "n8n API key is not set. Add it in extension preferences.");
    }

    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          headers: { "X-N8N-API-KEY": this.apiKey, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          throw new N8nApiError(0, `Request to ${path} timed out after ${this.timeoutMs}ms`);
        }
        throw new N8nApiError(0, `Request to ${path} failed: ${(error as Error).message}`);
      }
      clearTimeout(timer);

      if (response.status === 429 && attempt < this.maxRetries) {
        await delay(this.retryBaseMs * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        throw new N8nApiError(response.status, errorMessage(response.status, path));
      }
      return (await response.json()) as T;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/api/client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts src/api/client.test.ts
git commit -m "feat: add n8n API client with retry and timeout"
```

---

## Task 7: Preferences accessor and endpoints

**Files:**
- Create: `src/api/preferences.ts`
- Create: `src/api/endpoints.ts`

- [ ] **Step 1: Write `src/api/preferences.ts`**

```ts
import { getPreferenceValues } from "@raycast/api";
import { N8nClient } from "./client.js";
import { N8nPreferences } from "./types.js";

export function getInstanceUrl(): string {
  return getPreferenceValues<N8nPreferences>().instanceUrl.trim().replace(/\/+$/, "");
}

export function getClient(): N8nClient {
  const prefs = getPreferenceValues<N8nPreferences>();
  return new N8nClient({ baseUrl: prefs.instanceUrl, apiKey: prefs.apiKey });
}
```

- [ ] **Step 2: Write `src/api/endpoints.ts`**

```ts
import { N8nClient } from "./client.js";
import { FolderListResponse, ListResponse, RawExecution, RawFolder, RawWorkflow } from "./types.js";

const WORKFLOW_PAGE_SIZE = 250;
const EXECUTION_PAGE_SIZE = 100;

export async function fetchAllWorkflows(client: N8nClient): Promise<RawWorkflow[]> {
  const all: RawWorkflow[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.request<ListResponse<RawWorkflow>>("/workflows", {
      limit: String(WORKFLOW_PAGE_SIZE),
      excludePinnedData: "true",
      cursor,
    });
    all.push(...(page.data ?? []));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

export async function fetchProjectFolders(client: N8nClient, projectId: string): Promise<RawFolder[]> {
  const response = await client.request<FolderListResponse>(
    `/projects/${encodeURIComponent(projectId)}/folders`,
  );
  return response.data ?? [];
}

export function fetchExecutions(
  client: N8nClient,
  params: { workflowId?: string; status?: string; cursor?: string; limit?: number },
): Promise<ListResponse<RawExecution>> {
  return client.request<ListResponse<RawExecution>>("/executions", {
    limit: String(params.limit ?? EXECUTION_PAGE_SIZE),
    workflowId: params.workflowId,
    status: params.status,
    cursor: params.cursor,
  });
}
```

- [ ] **Step 3: Verify both files typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors from `src/api/preferences.ts` or `src/api/endpoints.ts`. (A missing `raycast-env.d.ts` warning is acceptable at this stage.)

- [ ] **Step 4: Commit**

```bash
git add src/api/preferences.ts src/api/endpoints.ts
git commit -m "feat: add preferences accessor and n8n endpoints"
```

---

## Task 8: Catalog types, JSONL store, and paths

**Files:**
- Create: `src/catalog/types.ts`
- Create: `src/catalog/jsonl.ts`
- Create: `src/catalog/paths.ts`

`jsonl.ts` is pure (no `@raycast/api`) so the search module that imports it stays testable. `paths.ts` owns the only `@raycast/api` dependency in the catalog layer.

- [ ] **Step 1: Write `src/catalog/types.ts`**

```ts
import { WebhookEntry } from "../utils/webhooks.js";

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
}

export interface FolderRow {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  parentFolderId: string | null;
  path: string[];
  workflowCount: number;
  url: string;
}

export interface CatalogManifest {
  schemaVersion: number;
  instanceUrl: string;
  syncedAt: string;
  workflowCount: number;
  folderCount: number;
}

export type WorkflowStatusFilter = "all" | "active" | "archived";

export interface WorkflowSearchParams {
  query?: string;
  status?: WorkflowStatusFilter;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface FolderSearchParams {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface PagedResult<T> {
  rows: T[];
  hasMore: boolean;
  totalCount: number;
}
```

- [ ] **Step 2: Write `src/catalog/jsonl.ts`**

```ts
import { createReadStream, existsSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

export function writeJsonlAtomic<T>(filePath: string, rows: T[]): void {
  const tmp = `${filePath}.tmp`;
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(tmp, rows.length > 0 ? `${body}\n` : "");
  renameSync(tmp, filePath);
}

export async function* streamJsonl<T>(filePath: string): AsyncGenerator<T> {
  if (!existsSync(filePath)) return;
  const rl = createInterface({
    input: createReadStream(filePath, "utf8"),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) yield JSON.parse(trimmed) as T;
    }
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 3: Write `src/catalog/paths.ts`**

```ts
import { environment } from "@raycast/api";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CatalogManifest } from "./types.js";

const CATALOG_DIR = join(environment.supportPath, "catalog");

export const catalogPaths = {
  dir: CATALOG_DIR,
  workflows: join(CATALOG_DIR, "workflows.jsonl"),
  folders: join(CATALOG_DIR, "folders.jsonl"),
  manifest: join(CATALOG_DIR, "manifest.json"),
  lock: join(CATALOG_DIR, "sync.lock"),
};

export function ensureCatalogDir(): void {
  mkdirSync(CATALOG_DIR, { recursive: true });
}

export function readManifest(): CatalogManifest | null {
  if (!existsSync(catalogPaths.manifest)) return null;
  try {
    return JSON.parse(readFileSync(catalogPaths.manifest, "utf8")) as CatalogManifest;
  } catch {
    return null;
  }
}

export function writeManifestAtomic(manifest: CatalogManifest): void {
  const tmp = `${catalogPaths.manifest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, catalogPaths.manifest);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/catalog/types.ts src/catalog/jsonl.ts src/catalog/paths.ts
git commit -m "feat: add catalog types, JSONL store, and paths"
```

---

## Task 9: Catalog search (TDD)

**Files:**
- Create: `src/catalog/search.ts`
- Test: `src/catalog/search.test.ts`

`search.ts` is pure — it takes explicit file paths and imports only `jsonl.ts` + types.

- [ ] **Step 1: Write the failing test `src/catalog/search.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectWorkflowMap, searchFolderRows, searchWorkflowRows } from "./search.js";
import { FolderRow, WorkflowRow } from "./types.js";

const dir = mkdtempSync(join(tmpdir(), "n8n-catalog-"));

function workflow(partial: Partial<WorkflowRow> & { id: string; name: string }): WorkflowRow {
  return {
    active: true,
    isArchived: false,
    tags: [],
    triggerCount: 0,
    projectId: null,
    webhooks: [],
    url: "",
    updatedAt: "",
    ...partial,
  };
}

const workflows: WorkflowRow[] = [
  workflow({ id: "1", name: "Sales sync", tags: ["prod"] }),
  workflow({ id: "2", name: "Lead intake", active: false }),
  workflow({ id: "3", name: "Archived flow", isArchived: true }),
];
const workflowsPath = join(dir, "workflows.jsonl");
writeFileSync(workflowsPath, workflows.map((w) => JSON.stringify(w)).join("\n") + "\n");

const folders: FolderRow[] = [
  { id: "f1", name: "tools", projectId: "p1", projectName: "Revo", parentFolderId: null, path: ["Revo Fitness", "tools"], workflowCount: 17, url: "" },
  { id: "f2", name: "agents", projectId: "p1", projectName: "Revo", parentFolderId: null, path: ["Revo Fitness", "agents"], workflowCount: 4, url: "" },
];
const foldersPath = join(dir, "folders.jsonl");
writeFileSync(foldersPath, folders.map((f) => JSON.stringify(f)).join("\n") + "\n");

afterAll(() => {
  // tmp dir is left for the OS to reclaim
});

describe("searchWorkflowRows", () => {
  it("returns all rows with no filter", async () => {
    const result = await searchWorkflowRows(workflowsPath, {});
    expect(result.totalCount).toBe(3);
    expect(result.rows).toHaveLength(3);
  });

  it("filters by query against name", async () => {
    const result = await searchWorkflowRows(workflowsPath, { query: "lead" });
    expect(result.rows.map((r) => r.id)).toEqual(["2"]);
  });

  it("filters by active status", async () => {
    const result = await searchWorkflowRows(workflowsPath, { status: "active" });
    expect(result.rows.map((r) => r.id)).toEqual(["1"]);
  });

  it("filters by archived status", async () => {
    const result = await searchWorkflowRows(workflowsPath, { status: "archived" });
    expect(result.rows.map((r) => r.id)).toEqual(["3"]);
  });

  it("paginates with offset and limit", async () => {
    const result = await searchWorkflowRows(workflowsPath, { offset: 1, limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.totalCount).toBe(3);
  });

  it("returns an empty result for a missing file", async () => {
    const result = await searchWorkflowRows(join(dir, "missing.jsonl"), {});
    expect(result).toEqual({ rows: [], hasMore: false, totalCount: 0 });
  });
});

describe("searchFolderRows", () => {
  it("matches a folder by a path segment", async () => {
    const result = await searchFolderRows(foldersPath, { query: "revo fitness" });
    expect(result.totalCount).toBe(2);
  });

  it("matches a folder by name", async () => {
    const result = await searchFolderRows(foldersPath, { query: "tools" });
    expect(result.rows.map((r) => r.id)).toEqual(["f1"]);
  });
});

describe("collectWorkflowMap", () => {
  it("maps workflow id to row", async () => {
    const map = await collectWorkflowMap(workflowsPath);
    expect(map.get("2")?.name).toBe("Lead intake");
    expect(map.size).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx vitest run src/catalog/search.test.ts`
Expected: FAIL — cannot resolve `./search.js`.

- [ ] **Step 3: Write `src/catalog/search.ts`**

```ts
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
  return [row.name, row.id, row.tags.join(" "), row.webhooks.map((w) => w.path).join(" ")]
    .join(" ")
    .toLowerCase();
}

function workflowMatches(row: WorkflowRow, params: WorkflowSearchParams, query: string): boolean {
  if (params.status === "active" && (!row.active || row.isArchived)) return false;
  if (params.status === "archived" && !row.isArchived) return false;
  if (params.tag && !row.tags.includes(params.tag)) return false;
  if (query && !workflowSearchText(row).includes(query)) return false;
  return true;
}

export async function searchWorkflowRows(
  filePath: string,
  params: WorkflowSearchParams,
): Promise<PagedResult<WorkflowRow>> {
  const query = (params.query ?? "").trim().toLowerCase();
  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_PAGE_SIZE;
  const rows: WorkflowRow[] = [];
  let matched = 0;
  for await (const row of streamJsonl<WorkflowRow>(filePath)) {
    if (!workflowMatches(row, params, query)) continue;
    if (matched >= offset && rows.length < limit) rows.push(row);
    matched++;
  }
  return { rows, hasMore: offset + rows.length < matched, totalCount: matched };
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

export async function collectWorkflowMap(filePath: string): Promise<Map<string, WorkflowRow>> {
  const map = new Map<string, WorkflowRow>();
  for await (const row of streamJsonl<WorkflowRow>(filePath)) {
    map.set(row.id, row);
  }
  return map;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/catalog/search.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/catalog/search.ts src/catalog/search.test.ts
git commit -m "feat: add catalog search over JSONL"
```

---

## Task 10: Catalog sync and service facade

**Files:**
- Create: `src/catalog/sync.ts`
- Create: `src/catalog/service.ts`

- [ ] **Step 1: Write `src/catalog/sync.ts`**

```ts
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fetchAllWorkflows, fetchProjectFolders } from "../api/endpoints.js";
import { getClient, getInstanceUrl } from "../api/preferences.js";
import { RawFolder, RawWorkflow } from "../api/types.js";
import { buildFolderUrl, buildWorkflowUrl } from "../utils/url.js";
import { extractWebhooks } from "../utils/webhooks.js";
import { writeJsonlAtomic } from "./jsonl.js";
import { catalogPaths, ensureCatalogDir, readManifest, writeManifestAtomic } from "./paths.js";
import { CatalogManifest, FolderRow, WorkflowRow } from "./types.js";

const SCHEMA_VERSION = 1;
const SYNC_TTL_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;

let inFlight: Promise<void> | null = null;

function normalizeTags(raw: RawWorkflow["tags"]): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((tag) => (typeof tag === "string" ? tag : (tag?.name ?? "")))
    .filter((tag): tag is string => Boolean(tag));
}

function projectWorkflow(raw: RawWorkflow, baseUrl: string): WorkflowRow {
  const id = String(raw.id);
  return {
    id,
    name: String(raw.name ?? ""),
    active: Boolean(raw.active),
    isArchived: Boolean(raw.isArchived),
    tags: normalizeTags(raw.tags),
    triggerCount: Number(raw.triggerCount ?? 0),
    projectId: raw.shared?.find((entry) => entry.projectId)?.projectId ?? null,
    webhooks: extractWebhooks(raw.nodes, baseUrl),
    url: buildWorkflowUrl(baseUrl, id),
    updatedAt: String(raw.updatedAt ?? ""),
  };
}

function buildFolderRows(rawFolders: RawFolder[], baseUrl: string): FolderRow[] {
  const byId = new Map(rawFolders.map((folder) => [String(folder.id), folder]));

  function pathOf(folder: RawFolder): string[] {
    const segments: string[] = [];
    const seen = new Set<string>();
    let current: RawFolder | undefined = folder;
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      segments.unshift(String(current.name ?? ""));
      current = current.parentFolderId ? byId.get(String(current.parentFolderId)) : undefined;
    }
    return segments;
  }

  return rawFolders.map((raw) => {
    const projectId = raw.homeProject?.id ?? "";
    return {
      id: String(raw.id),
      name: String(raw.name ?? ""),
      projectId,
      projectName: raw.homeProject?.name ?? "",
      parentFolderId: raw.parentFolderId ?? null,
      path: pathOf(raw),
      workflowCount: Number(raw.workflowCount ?? 0),
      url: projectId ? buildFolderUrl(baseUrl, projectId, String(raw.id)) : "",
    };
  });
}

function distinctProjectIds(workflows: RawWorkflow[]): string[] {
  const ids = new Set<string>();
  for (const workflow of workflows) {
    for (const entry of workflow.shared ?? []) {
      if (entry.projectId) ids.add(entry.projectId);
    }
  }
  return [...ids];
}

function isCatalogFresh(): boolean {
  const manifest = readManifest();
  if (!manifest) return false;
  const age = Date.now() - Date.parse(manifest.syncedAt);
  return Number.isFinite(age) && age >= 0 && age < SYNC_TTL_MS;
}

function acquireLock(): boolean {
  if (existsSync(catalogPaths.lock)) {
    try {
      if (Date.now() - statSync(catalogPaths.lock).mtimeMs < LOCK_STALE_MS) {
        return false;
      }
    } catch {
      // Stat failed; fall through and overwrite the stale lock.
    }
  }
  writeFileSync(catalogPaths.lock, String(Date.now()));
  return true;
}

function releaseLock(): void {
  try {
    rmSync(catalogPaths.lock, { force: true });
  } catch {
    // Ignore lock cleanup failures.
  }
}

async function runSync(): Promise<void> {
  ensureCatalogDir();
  if (!acquireLock()) return;
  try {
    const client = getClient();
    const baseUrl = getInstanceUrl();

    const rawWorkflows = await fetchAllWorkflows(client);
    const workflowRows = rawWorkflows.map((workflow) => projectWorkflow(workflow, baseUrl));

    const folderRows: FolderRow[] = [];
    for (const projectId of distinctProjectIds(rawWorkflows)) {
      try {
        const rawFolders = await fetchProjectFolders(client, projectId);
        folderRows.push(...buildFolderRows(rawFolders, baseUrl));
      } catch {
        // A project's folders may be inaccessible (license/permission); skip it.
      }
    }

    writeJsonlAtomic(catalogPaths.workflows, workflowRows);
    writeJsonlAtomic(catalogPaths.folders, folderRows);

    const manifest: CatalogManifest = {
      schemaVersion: SCHEMA_VERSION,
      instanceUrl: baseUrl,
      syncedAt: new Date().toISOString(),
      workflowCount: workflowRows.length,
      folderCount: folderRows.length,
    };
    writeManifestAtomic(manifest);
  } finally {
    releaseLock();
  }
}

export async function syncCatalog(options: { force?: boolean } = {}): Promise<void> {
  if (!options.force && isCatalogFresh()) return;
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function catalogExists(): boolean {
  return readManifest() !== null;
}
```

- [ ] **Step 2: Write `src/catalog/service.ts`**

```ts
import { catalogPaths } from "./paths.js";
import { collectWorkflowMap, searchFolderRows, searchWorkflowRows } from "./search.js";
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

export function getWorkflowMap(): Promise<Map<string, WorkflowRow>> {
  return collectWorkflowMap(catalogPaths.workflows);
}

export { catalogExists, syncCatalog } from "./sync.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors. (A missing `raycast-env.d.ts` warning is acceptable.)

- [ ] **Step 4: Verify the full test suite still passes**

Run: `bunx vitest run`
Expected: PASS — all tests from Tasks 3–9 green.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/sync.ts src/catalog/service.ts
git commit -m "feat: add catalog sync and service facade"
```

---

## Task 11: Pinned, recents, and catalog-sync hooks

**Files:**
- Create: `src/hooks/use-pinned.ts`
- Create: `src/hooks/use-recents.ts`
- Create: `src/hooks/use-catalog-sync.ts`

- [ ] **Step 1: Write `src/hooks/use-pinned.ts`**

```ts
import { useLocalStorage } from "@raycast/utils";

const STORAGE_KEY = "pinned-workflow-ids";

export interface PinnedState {
  pinnedIds: string[];
  isLoading: boolean;
  isPinned: (id: string) => boolean;
  togglePin: (id: string) => void;
}

export function usePinned(): PinnedState {
  const { value, setValue, isLoading } = useLocalStorage<string[]>(STORAGE_KEY, []);
  const pinnedIds = value ?? [];
  return {
    pinnedIds,
    isLoading,
    isPinned: (id) => pinnedIds.includes(id),
    togglePin: (id) =>
      setValue(pinnedIds.includes(id) ? pinnedIds.filter((entry) => entry !== id) : [id, ...pinnedIds]),
  };
}
```

- [ ] **Step 2: Write `src/hooks/use-recents.ts`**

```ts
import { useLocalStorage } from "@raycast/utils";

const STORAGE_KEY = "recent-workflow-ids";
const MAX_RECENTS = 15;

export interface RecentsState {
  recentIds: string[];
  isLoading: boolean;
  recordVisit: (id: string) => void;
}

export function useRecents(): RecentsState {
  const { value, setValue, isLoading } = useLocalStorage<string[]>(STORAGE_KEY, []);
  const recentIds = value ?? [];
  return {
    recentIds,
    isLoading,
    recordVisit: (id) =>
      setValue([id, ...recentIds.filter((entry) => entry !== id)].slice(0, MAX_RECENTS)),
  };
}
```

- [ ] **Step 3: Write `src/hooks/use-catalog-sync.ts`**

```ts
import { showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { catalogExists, syncCatalog } from "../catalog/service.js";

export interface CatalogSync {
  isSyncing: boolean;
  syncToken: number;
  resync: () => void;
}

export function useCatalogSync(): CatalogSync {
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncToken, setSyncToken] = useState(0);
  const runningRef = useRef(false);

  const run = useCallback(async (force: boolean) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setIsSyncing(true);
    try {
      await syncCatalog({ force });
      setSyncToken(Date.now());
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Catalog sync failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      runningRef.current = false;
      setIsSyncing(false);
    }
  }, []);

  useEffect(() => {
    void run(!catalogExists());
  }, [run]);

  return {
    isSyncing,
    syncToken,
    resync: () => void run(true),
  };
}
```

- [ ] **Step 4: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-pinned.ts src/hooks/use-recents.ts src/hooks/use-catalog-sync.ts
git commit -m "feat: add pinned, recents, and catalog-sync hooks"
```

---

## Task 12: Search and execution-list hooks

**Files:**
- Create: `src/hooks/use-catalog-search.ts`
- Create: `src/hooks/use-execution-list.ts`

- [ ] **Step 1: Write `src/hooks/use-catalog-search.ts`**

```ts
import { useCachedPromise } from "@raycast/utils";
import { getWorkflowMap, searchFolders, searchWorkflows } from "../catalog/service.js";
import { WorkflowStatusFilter } from "../catalog/types.js";

const PAGE_SIZE = 50;

export function useWorkflowSearch(args: {
  query: string;
  status: WorkflowStatusFilter;
  tag?: string;
  syncToken: number;
  enabled: boolean;
}) {
  return useCachedPromise(
    (query: string, status: WorkflowStatusFilter, tag: string | undefined, _token: number) =>
      async (options: { page: number }) => {
        const result = await searchWorkflows({
          query,
          status,
          tag,
          offset: options.page * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        return { data: result.rows, hasMore: result.hasMore };
      },
    [args.query, args.status, args.tag, args.syncToken],
    { keepPreviousData: true, execute: args.enabled },
  );
}

export function useFolderSearch(args: { query: string; syncToken: number; enabled: boolean }) {
  return useCachedPromise(
    (query: string, _token: number) =>
      async (options: { page: number }) => {
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

export function useWorkflowMap(syncToken: number) {
  return useCachedPromise((_token: number) => getWorkflowMap(), [syncToken], {
    keepPreviousData: true,
  });
}
```

- [ ] **Step 2: Write `src/hooks/use-execution-list.ts`**

```ts
import { useCachedPromise } from "@raycast/utils";
import { fetchExecutions } from "../api/endpoints.js";
import { getClient } from "../api/preferences.js";
import { RawExecution } from "../api/types.js";

export function useExecutionList(args: { workflowId?: string; status?: string }) {
  return useCachedPromise(
    (workflowId: string | undefined, status: string | undefined) =>
      async (options: { page: number; cursor?: string }) => {
        const client = getClient();
        const page = await fetchExecutions(client, { workflowId, status, cursor: options.cursor });
        return {
          data: page.data as RawExecution[],
          hasMore: Boolean(page.nextCursor),
          cursor: page.nextCursor ?? undefined,
        };
      },
    [args.workflowId, args.status],
    { keepPreviousData: true },
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/use-catalog-search.ts src/hooks/use-execution-list.ts
git commit -m "feat: add catalog-search and execution-list hooks"
```

---

## Task 13: Workflow and folder list-item components

**Files:**
- Create: `src/components/workflow-list-item.tsx`
- Create: `src/components/folder-list-item.tsx`

`workflow-list-item.tsx` references `ExecutionsView` from Task 14; create the file with the import — typecheck happens at the end of Task 14.

- [ ] **Step 1: Write `src/components/workflow-list-item.tsx`**

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
}: {
  workflow: WorkflowRow;
  isPinned: boolean;
  onTogglePin: () => void;
  onVisit: () => void;
  onRefresh: () => void;
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
      subtitle={workflow.id}
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

- [ ] **Step 2: Write `src/components/folder-list-item.tsx`**

```tsx
import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { memo } from "react";
import { FolderRow } from "../catalog/types.js";

export const FolderListItem = memo(function FolderListItem({
  folder,
  onRefresh,
}: {
  folder: FolderRow;
  onRefresh: () => void;
}) {
  const accessories: List.Item.Accessory[] = [
    { text: `${folder.workflowCount} workflow${folder.workflowCount === 1 ? "" : "s"}` },
  ];
  if (folder.projectName) {
    accessories.push({ tag: { value: folder.projectName, color: Color.Purple } });
  }

  return (
    <List.Item
      title={folder.name}
      subtitle={folder.path.length > 1 ? folder.path.join(" / ") : undefined}
      keywords={folder.path}
      icon={{ source: Icon.Folder, tintColor: Color.Blue }}
      accessories={accessories}
      actions={
        <ActionPanel>
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

- [ ] **Step 3: Commit**

```bash
git add src/components/workflow-list-item.tsx src/components/folder-list-item.tsx
git commit -m "feat: add workflow and folder list-item components"
```

---

## Task 14: Executions view component

**Files:**
- Create: `src/components/executions-view.tsx`

- [ ] **Step 1: Write `src/components/executions-view.tsx`**

```tsx
import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useState } from "react";
import { getInstanceUrl } from "../api/preferences.js";
import { WorkflowRow } from "../catalog/types.js";
import { useExecutionList } from "../hooks/use-execution-list.js";
import { formatDuration, formatTimestamp } from "../utils/format.js";
import { buildExecutionUrl } from "../utils/url.js";

const STATUS_META: Record<string, { icon: Icon; color: Color; label: string }> = {
  success: { icon: Icon.CheckCircle, color: Color.Green, label: "Success" },
  error: { icon: Icon.XMarkCircle, color: Color.Red, label: "Error" },
  waiting: { icon: Icon.Clock, color: Color.Yellow, label: "Waiting" },
  running: { icon: Icon.CircleProgress, color: Color.Blue, label: "Running" },
  canceled: { icon: Icon.MinusCircle, color: Color.SecondaryText, label: "Canceled" },
  crashed: { icon: Icon.Warning, color: Color.Red, label: "Crashed" },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { icon: Icon.Circle, color: Color.SecondaryText, label: status };
}

export function ExecutionsView({ workflow }: { workflow: WorkflowRow }) {
  const [status, setStatus] = useState("all");
  const baseUrl = getInstanceUrl();
  const executions = useExecutionList({
    workflowId: workflow.id,
    status: status === "all" ? undefined : status,
  });

  return (
    <List
      isLoading={executions.isLoading}
      navigationTitle={workflow.name || workflow.id}
      searchBarPlaceholder="Filter executions..."
      pagination={executions.pagination}
      searchBarAccessory={
        <List.Dropdown tooltip="Status" onChange={setStatus} storeValue>
          <List.Dropdown.Item title="All Statuses" value="all" />
          <List.Dropdown.Item title="Success" value="success" />
          <List.Dropdown.Item title="Error" value="error" />
          <List.Dropdown.Item title="Waiting" value="waiting" />
        </List.Dropdown>
      }
    >
      <List.EmptyView
        title={executions.isLoading ? "Loading executions..." : "No executions"}
        description={executions.isLoading ? undefined : "This workflow has no matching executions."}
      />
      {(executions.data ?? []).map((execution) => {
        const meta = statusMeta(execution.status);
        const duration = formatDuration(execution.startedAt, execution.stoppedAt);
        const accessories: List.Item.Accessory[] = [];
        if (duration) accessories.push({ text: duration });
        accessories.push({ tag: { value: meta.label, color: meta.color } });

        return (
          <List.Item
            key={execution.id}
            title={formatTimestamp(execution.startedAt) || `Execution ${execution.id}`}
            subtitle={execution.mode}
            icon={{ source: meta.icon, tintColor: meta.color }}
            accessories={accessories}
            actions={
              <ActionPanel>
                <Action.OpenInBrowser
                  title="Open Execution in n8n"
                  url={buildExecutionUrl(baseUrl, execution.workflowId, execution.id)}
                />
                <Action.OpenInBrowser
                  title="Open Workflow in n8n"
                  url={workflow.url}
                  shortcut={{ modifiers: ["cmd"], key: "o" }}
                />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={executions.revalidate}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
```

- [ ] **Step 2: Verify typecheck (all components together)**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors. If `tsc` reports a missing `raycast-env.d.ts`, ignore it.

- [ ] **Step 3: Commit**

```bash
git add src/components/executions-view.tsx
git commit -m "feat: add executions view component"
```

---

## Task 15: Search Workflows command

**Files:**
- Create: `src/search-workflows.tsx`

This is the entry file for the `search-workflows` command (the filename must match the command `name` in `package.json`).

- [ ] **Step 1: Write `src/search-workflows.tsx`**

```tsx
import { Icon, List } from "@raycast/api";
import { useMemo, useState } from "react";
import { FolderListItem } from "./components/folder-list-item.js";
import { WorkflowListItem } from "./components/workflow-list-item.js";
import { WorkflowStatusFilter } from "./catalog/types.js";
import { useCatalogSync } from "./hooks/use-catalog-sync.js";
import { useFolderSearch, useWorkflowSearch } from "./hooks/use-catalog-search.js";
import { usePinned } from "./hooks/use-pinned.js";
import { useRecents } from "./hooks/use-recents.js";

type Filter = "all" | "type:workflows" | "type:folders" | "status:active" | "status:archived";

export default function SearchWorkflows() {
  const [filter, setFilter] = useState<Filter>("all");
  const [searchText, setSearchText] = useState("");
  const sync = useCatalogSync();
  const pinned = usePinned();
  const recents = useRecents();

  const showWorkflows = filter !== "type:folders";
  const showFolders = filter === "all" || filter === "type:folders";
  const status: WorkflowStatusFilter =
    filter === "status:active" ? "active" : filter === "status:archived" ? "archived" : "all";

  const workflows = useWorkflowSearch({
    query: searchText,
    status,
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
  const recentSet = useMemo(() => new Set(recents.recentIds), [recents.recentIds]);

  const pinnedRows = workflowRows.filter((row) => pinnedSet.has(row.id));
  const recentRows = workflowRows.filter((row) => recentSet.has(row.id) && !pinnedSet.has(row.id));
  const otherRows = workflowRows.filter((row) => !pinnedSet.has(row.id) && !recentSet.has(row.id));

  const isLoading =
    sync.isSyncing ||
    pinned.isLoading ||
    recents.isLoading ||
    workflows.isLoading ||
    folders.isLoading;

  const hasResults = workflowRows.length > 0 || folderRows.length > 0;

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search workflows and folders..."
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
          title="No results"
          description="Check your n8n instance URL and API key in extension preferences."
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
              onVisit={() => recents.recordVisit(row.id)}
              onRefresh={sync.resync}
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
              onVisit={() => recents.recordVisit(row.id)}
              onRefresh={sync.resync}
            />
          ))}
        </List.Section>
      )}
      {showWorkflows && (
        <List.Section title="Workflows" subtitle={String(workflowRows.length)}>
          {otherRows.map((row) => (
            <WorkflowListItem
              key={row.id}
              workflow={row}
              isPinned={false}
              onTogglePin={() => pinned.togglePin(row.id)}
              onVisit={() => recents.recordVisit(row.id)}
              onRefresh={sync.resync}
            />
          ))}
        </List.Section>
      )}
      {showFolders && (
        <List.Section title="Folders" subtitle={String(folderRows.length)}>
          {folderRows.map((row) => (
            <FolderListItem key={row.id} folder={row} onRefresh={sync.resync} />
          ))}
        </List.Section>
      )}
    </List>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/search-workflows.tsx
git commit -m "feat: add Search Workflows command"
```

---

## Task 16: Search Executions command

**Files:**
- Create: `src/search-executions.tsx`

The filename must match the `search-executions` command `name` in `package.json`. This command lists executions instance-wide and resolves workflow names from the catalog via `useWorkflowMap`.

- [ ] **Step 1: Write `src/search-executions.tsx`**

```tsx
import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { useState } from "react";
import { getInstanceUrl } from "./api/preferences.js";
import { useCatalogSync } from "./hooks/use-catalog-sync.js";
import { useWorkflowMap } from "./hooks/use-catalog-search.js";
import { useExecutionList } from "./hooks/use-execution-list.js";
import { formatDuration, formatTimestamp } from "./utils/format.js";
import { buildExecutionUrl, buildWorkflowUrl } from "./utils/url.js";

const STATUS_META: Record<string, { icon: Icon; color: Color; label: string }> = {
  success: { icon: Icon.CheckCircle, color: Color.Green, label: "Success" },
  error: { icon: Icon.XMarkCircle, color: Color.Red, label: "Error" },
  waiting: { icon: Icon.Clock, color: Color.Yellow, label: "Waiting" },
  running: { icon: Icon.CircleProgress, color: Color.Blue, label: "Running" },
  canceled: { icon: Icon.MinusCircle, color: Color.SecondaryText, label: "Canceled" },
  crashed: { icon: Icon.Warning, color: Color.Red, label: "Crashed" },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { icon: Icon.Circle, color: Color.SecondaryText, label: status };
}

export default function SearchExecutions() {
  const [status, setStatus] = useState("all");
  const baseUrl = getInstanceUrl();
  const sync = useCatalogSync();
  const workflowMap = useWorkflowMap(sync.syncToken);
  const executions = useExecutionList({ status: status === "all" ? undefined : status });

  const isLoading = executions.isLoading || workflowMap.isLoading || sync.isSyncing;

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter executions..."
      pagination={executions.pagination}
      searchBarAccessory={
        <List.Dropdown tooltip="Status" onChange={setStatus} storeValue>
          <List.Dropdown.Item title="All Statuses" value="all" />
          <List.Dropdown.Item title="Success" value="success" />
          <List.Dropdown.Item title="Error" value="error" />
          <List.Dropdown.Item title="Waiting" value="waiting" />
        </List.Dropdown>
      }
    >
      <List.EmptyView
        title={isLoading ? "Loading executions..." : "No executions"}
        description={
          isLoading ? undefined : "Check your n8n instance URL and API key in extension preferences."
        }
      />
      {(executions.data ?? []).map((execution) => {
        const meta = statusMeta(execution.status);
        const workflow = workflowMap.data?.get(execution.workflowId);
        const workflowName = workflow?.name || execution.workflowId;
        const duration = formatDuration(execution.startedAt, execution.stoppedAt);
        const accessories: List.Item.Accessory[] = [];
        if (duration) accessories.push({ text: duration });
        accessories.push({ tag: { value: meta.label, color: meta.color } });

        return (
          <List.Item
            key={execution.id}
            title={workflowName}
            subtitle={formatTimestamp(execution.startedAt)}
            icon={{ source: meta.icon, tintColor: meta.color }}
            accessories={accessories}
            actions={
              <ActionPanel>
                <Action.OpenInBrowser
                  title="Open Execution in n8n"
                  url={buildExecutionUrl(baseUrl, execution.workflowId, execution.id)}
                />
                <Action.OpenInBrowser
                  title="Open Workflow in n8n"
                  url={workflow?.url ?? buildWorkflowUrl(baseUrl, execution.workflowId)}
                  shortcut={{ modifiers: ["cmd"], key: "o" }}
                />
                <Action
                  title="Refresh"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={() => {
                    executions.revalidate();
                    sync.resync();
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/search-executions.tsx
git commit -m "feat: add Search Executions command"
```

---

## Task 17: README, build, and final verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# Search n8n Workflows

Search and browse your [n8n](https://n8n.io) instance — workflows, folders, and
executions — directly from Raycast.

## Features

- **Workflow search** — find workflows by name, id, tag, or webhook path.
- **Folder browser** — search the n8n folder tree by name and path.
- **Executions** — browse recent executions per workflow or instance-wide,
  filtered by status.
- **Quick actions** — open in n8n, copy workflow/webhook/folder URLs, pin
  favorites.
- **Disk catalog** — workflows and folders are cached locally and refreshed in
  the background.

## Commands

| Command | Description |
| --- | --- |
| **Search n8n Workflows** | Search workflows and folders with a type/status filter |
| **Search n8n Executions** | Browse recent executions across the instance |

## Setup

1. Install the extension.
2. In n8n, create a public API key (Settings > n8n API).
3. On first launch, enter your **n8n Instance URL** (e.g. `https://n8n.example.com`)
   and **API Key**.

## Known limitations

The n8n public API does not expose which folder a workflow belongs to, so the
workflow list cannot be filtered by folder. Folders are searchable as their own
items instead. Project listing requires an enterprise license; project names
are recovered from folder metadata.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Open in n8n |
| `Tab` | View executions (on a workflow) |
| `Cmd+C` | Copy URL |
| `Cmd+Shift+C` | Copy webhook URL |
| `Cmd+R` | Refresh |
```

- [ ] **Step 2: Run the full test suite**

Run: `cd /Users/idokraicer/Developer/raycast-n8n-workflows && bunx vitest run`
Expected: PASS — all tests from Tasks 3, 4, 5, 6, 9 green (~27 tests).

- [ ] **Step 3: Run lint**

Run: `bunx ray lint`
Expected: no lint errors. If lint reports fixable issues, run `bunx ray lint --fix` and re-run.

- [ ] **Step 4: Build the extension (generates `raycast-env.d.ts`)**

Run: `bunx ray build -e dist`
Expected: build succeeds; `raycast-env.d.ts` is generated. If the build reports a type error, fix it and rebuild before continuing.

- [ ] **Step 5: Final typecheck with the generated env file**

Run: `bunx tsc --noEmit`
Expected: no errors (now that `raycast-env.d.ts` exists).

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

- [ ] **Step 7: Manual smoke test**

Run: `bunx ray develop`
Then in Raycast:
1. Open **Search n8n Workflows** — enter the instance URL and API key when prompted.
2. Confirm workflows load; try the type dropdown (Workflows / Folders) and a search query.
3. On a workflow, press `Tab` to open executions; verify they load and the status filter works.
4. Test pin/unpin and `Cmd+C` / `Cmd+Shift+C` copy actions.
5. Open **Search n8n Executions**; confirm workflow names resolve and the status filter works.

Stop `ray develop` with `Ctrl+C` when done.

---

## Verification Summary

- Unit tests: `url`, `webhooks`, `format`, `client`, `catalog/search` (Tasks 3, 4, 5, 6, 9).
- Typecheck: after every code task, and a final pass with `raycast-env.d.ts` present.
- Lint + build: `ray lint` and `ray build` in Task 17.
- Manual: full smoke test against the live instance in Task 17.

## Notes for the implementer

- The n8n API key used for probing expires; if API calls return 401 during the
  manual smoke test, generate a fresh key in the n8n UI.
- `useCachedPromise` pagination: the paginated function receives `{ page, cursor }`
  and returns `{ data, hasMore, cursor? }`. The hook's returned `pagination`
  object is passed directly to `<List pagination={...}>`. If the installed
  `@raycast/utils` version's pagination signature differs, adjust the hooks in
  Task 12 — the catalog/search layer is unaffected.
- If `ray build` rejects the placeholder icon, export a 512×512 PNG to
  `assets/extension-icon.png` and rebuild.
