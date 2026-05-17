# n8n-locate CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `n8n-locate`, a TypeScript/bun CLI that helps agents find n8n workflows (by id/name/webhook/tag) and locate values inside execution data, over the n8n public API.

**Architecture:** Pure data modules (URL parsing, JSON search, path resolution, data normalization, webhook extraction) have no I/O. An I/O layer (config, HTTP client, disk-backed workflow catalog, execution cache) sits on top. Six `commander` commands (`login`, `sync`, `workflows`, `executions`, `search`, `get`) compose those modules. Large data lives on disk: the workflow catalog is JSONL streamed line-by-line; execution payloads are cached as files.

**Tech Stack:** TypeScript, bun runtime, `bun test`, `commander`. Single runtime dependency: `commander`.

**Spec:** `docs/superpowers/specs/2026-05-17-n8n-locate-cli-design.md`

---

## File Structure

```
src/
  cli.ts              commander setup; registers commands; error → exit code.
  commands/
    login.ts          login command.
    sync.ts           sync command.
    workflows.ts      workflows command (catalog search).
    executions.ts     executions command.
    search.ts         search command.
    get.ts            get command.
  url.ts              parse/build n8n URLs; classify bare IDs.
  paths.ts            format/parse/resolve JSON paths.
  search.ts           recursive JSON search with path tracking.
  n8n-data.ts         normalize execution data → search units + node summary.
  webhooks.ts         extract webhook entries from workflow nodes.
  config.ts           load/save config.json; resolve instance; disk paths.
  client.ts           n8n API client (timeout + 429 retry).
  catalog.ts          build/stream/search the disk workflow catalog.
  exec-cache.ts       on-disk execution payload cache.
  format.ts           output-mode resolution, JSON emit, error envelope.
  types.ts            shared types and CliError.
tests/                one *.test.ts per src module.
package.json  tsconfig.json  .gitignore (exists)  README.md
```

**Conventions for every task:** imports use no file extension (bun resolves
them). Test files import from `bun:test`. Run tests with `bun test`. Commit
after each task with the message shown.

---

## Phase 1 — Scaffold

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "n8n-locate",
  "description": "CLI to locate n8n workflows and execution data via the n8n public API",
  "type": "module",
  "bin": { "n8n-locate": "./src/cli.ts" },
  "scripts": {
    "start": "bun src/cli.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "@types/bun": "^1.3.9" },
  "peerDependencies": { "typescript": "^5" },
  "dependencies": { "commander": "^14.0.3" }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Write a smoke test** in `tests/smoke.test.ts`

```ts
import { test, expect } from "bun:test";

test("bun test runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Install dependencies and run the test**

Run: `bun install && bun test`
Expected: `commander` installs; the smoke test passes (`1 pass`).

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json bun.lock tests/smoke.test.ts
git commit -m "chore: scaffold n8n-locate bun project"
```

---

## Phase 2 — Pure modules (no I/O)

### Task 2: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export interface InstanceConfig {
  baseUrl: string;
  apiKey: string;
}

export interface Config {
  defaultInstance?: string;
  instances: Record<string, InstanceConfig>;
}

export interface ResolvedInstance {
  host: string;
  baseUrl: string;
  apiKey: string;
}

export interface ParsedN8nUrl {
  kind: "workflow" | "execution";
  host: string;
  baseUrl: string;
  workflowId: string;
  executionId?: string;
}

export interface WebhookEntry {
  node: string;
  method: string;
  path: string;
  productionUrl: string;
  testUrl: string;
}

export interface WorkflowRow {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  tags: string[];
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
  webhooks: WebhookEntry[];
  url: string;
}

export interface CatalogManifest {
  schemaVersion: number;
  instance: string;
  baseUrl: string;
  syncedAt: string;
  workflowCount: number;
}

export interface ExecutionListItem {
  id: string;
  status: string;
  mode: string;
  finished: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  url: string;
}

export interface ExecutionInfo {
  id: string;
  workflowId: string;
  status: string;
  mode: string;
  finished: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  url: string;
}

export interface SearchUnit {
  node: string;
  runIndex: number;
  outputIndex: number;
  itemIndex: number;
  json: unknown;
  binary: Record<string, unknown> | undefined;
}

export interface NodeSummary {
  name: string;
  runs: number;
  items: number;
  status: string;
}

export type MatchMode = "substring" | "exact" | "regex";

export interface Match {
  executionId: string;
  node: string;
  runIndex: number;
  outputIndex: number;
  itemIndex: number;
  path: string;
  value: string;
  valueType: string;
  url: string;
  context?: unknown;
}

export class CliError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared types and CliError"
```

### Task 3: URL parsing (`url.ts`)

**Files:**
- Create: `src/url.ts`
- Test: `tests/url.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/url.test.ts`

```ts
import { test, expect } from "bun:test";
import {
  parseN8nUrl,
  classifyBareId,
  buildWorkflowUrl,
  buildExecutionUrl,
} from "../src/url";

test("parses an execution URL", () => {
  const r = parseN8nUrl(
    "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694",
  );
  expect(r).toEqual({
    kind: "execution",
    host: "n8n.example.com",
    baseUrl: "https://n8n.example.com",
    workflowId: "NDiulczinIqHUJJF",
    executionId: "351694",
  });
});

test("parses a workflow URL with a trailing slash", () => {
  const r = parseN8nUrl("https://n8n.example.com/workflow/NDiulczinIqHUJJF/");
  expect(r).toEqual({
    kind: "workflow",
    host: "n8n.example.com",
    baseUrl: "https://n8n.example.com",
    workflowId: "NDiulczinIqHUJJF",
  });
});

test("returns null for a non-n8n URL", () => {
  expect(parseN8nUrl("https://example.com/foo")).toBeNull();
});

test("returns null for a bare id", () => {
  expect(parseN8nUrl("351694")).toBeNull();
});

test("classifies an all-digit id as an execution", () => {
  expect(classifyBareId("351694")).toBe("execution");
});

test("classifies an alphanumeric id as a workflow", () => {
  expect(classifyBareId("NDiulczinIqHUJJF")).toBe("workflow");
});

test("builds canonical URLs", () => {
  expect(buildWorkflowUrl("https://h.co", "WF")).toBe(
    "https://h.co/workflow/WF",
  );
  expect(buildExecutionUrl("https://h.co", "WF", "99")).toBe(
    "https://h.co/workflow/WF/executions/99",
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/url.test.ts`
Expected: FAIL — cannot resolve `../src/url`.

- [ ] **Step 3: Write `src/url.ts`**

```ts
import type { ParsedN8nUrl } from "./types";

const N8N_URL_RE =
  /^(https?:\/\/([^/]+))\/workflow\/([^/?#]+)(?:\/executions\/([^/?#]+))?\/?(?:[?#].*)?$/;

export function parseN8nUrl(input: string): ParsedN8nUrl | null {
  const match = input.trim().match(N8N_URL_RE);
  if (!match) return null;
  const [, baseUrl, host, workflowId, executionId] = match;
  if (executionId) {
    return { kind: "execution", host, baseUrl, workflowId, executionId };
  }
  return { kind: "workflow", host, baseUrl, workflowId };
}

export function classifyBareId(id: string): "execution" | "workflow" {
  return /^\d+$/.test(id.trim()) ? "execution" : "workflow";
}

export function buildWorkflowUrl(baseUrl: string, workflowId: string): string {
  return `${baseUrl}/workflow/${workflowId}`;
}

export function buildExecutionUrl(
  baseUrl: string,
  workflowId: string,
  executionId: string,
): string {
  return `${baseUrl}/workflow/${workflowId}/executions/${executionId}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/url.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/url.ts tests/url.test.ts
git commit -m "feat: add n8n URL parsing and building"
```

### Task 4: JSON paths (`paths.ts`)

**Files:**
- Create: `src/paths.ts`
- Test: `tests/paths.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/paths.test.ts`

```ts
import { test, expect } from "bun:test";
import { formatPath, parsePath, resolvePath } from "../src/paths";

test("formats segments rooted at json", () => {
  expect(formatPath(["order", "items", 2, "id"])).toBe(
    "json.order.items[2].id",
  );
});

test("formats non-identifier keys with bracket-quote notation", () => {
  expect(formatPath(["weird key"])).toBe('json["weird key"]');
});

test("formats an empty segment list as the root", () => {
  expect(formatPath([])).toBe("json");
});

test("parses a path back into segments", () => {
  expect(parsePath("json.order.items[2].id")).toEqual([
    "order",
    "items",
    2,
    "id",
  ]);
});

test("parses bracket-quote keys", () => {
  expect(parsePath('json["weird key"]')).toEqual(["weird key"]);
});

test("resolves a path against nested data", () => {
  const data = { order: { items: [{ id: "A" }, { id: "B" }] } };
  expect(resolvePath(data, ["order", "items", 1, "id"])).toEqual({
    found: true,
    value: "B",
  });
});

test("reports a missing path as not found", () => {
  expect(resolvePath({ a: 1 }, ["a", "b"])).toEqual({
    found: false,
    value: undefined,
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/paths.test.ts`
Expected: FAIL — cannot resolve `../src/paths`.

- [ ] **Step 3: Write `src/paths.ts`**

```ts
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function formatPath(segments: Array<string | number>): string {
  let out = "json";
  for (const seg of segments) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else if (IDENTIFIER_RE.test(seg)) {
      out += `.${seg}`;
    } else {
      out += `[${JSON.stringify(seg)}]`;
    }
  }
  return out;
}

export function parsePath(path: string): Array<string | number> {
  let rest = path.trim();
  if (rest !== "json" && !rest.startsWith("json.") && !rest.startsWith("json["))
    throw new Error(`Path must be rooted at "json": ${path}`);
  rest = rest.slice("json".length);
  const segments: Array<string | number> = [];
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const m = rest.match(/^\.([A-Za-z_$][\w$]*)/);
      if (!m) throw new Error(`Invalid path segment near: ${rest}`);
      segments.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end === -1) throw new Error(`Unclosed bracket in path: ${path}`);
      const inner = rest.slice(1, end);
      if (/^\d+$/.test(inner)) {
        segments.push(Number(inner));
      } else {
        segments.push(JSON.parse(inner) as string);
      }
      rest = rest.slice(end + 1);
    } else {
      throw new Error(`Invalid path near: ${rest}`);
    }
  }
  return segments;
}

export function resolvePath(
  root: unknown,
  segments: Array<string | number>,
): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (typeof seg === "number") {
      if (!Array.isArray(current) || seg >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[seg];
    } else {
      if (!(seg in (current as Record<string, unknown>))) {
        return { found: false, value: undefined };
      }
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return { found: true, value: current };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/paths.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat: add JSON path format/parse/resolve"
```

### Task 5: Recursive search (`search.ts`)

**Files:**
- Create: `src/search.ts`
- Test: `tests/search.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/search.test.ts`

```ts
import { test, expect } from "bun:test";
import { searchUnits, type SearchOptions } from "../src/search";
import type { SearchUnit } from "../src/types";

const ctx = { executionId: "1", url: "https://h.co/x" };

function units(json: unknown): SearchUnit[] {
  return [{ node: "N", runIndex: 0, outputIndex: 0, itemIndex: 0, json, binary: undefined }];
}

const base: SearchOptions = {
  mode: "substring",
  caseSensitive: false,
  maxMatches: 100,
  context: false,
  truncate: 200,
};

test("finds a substring match and records its path", () => {
  const r = searchUnits(units({ order: { id: "500857721" } }), "5008", base, ctx);
  expect(r.matches.length).toBe(1);
  expect(r.matches[0].path).toBe("json.order.id");
  expect(r.matches[0].value).toBe("500857721");
  expect(r.matches[0].valueType).toBe("string");
});

test("matches numeric values by string form", () => {
  const r = searchUnits(units({ n: 42 }), "42", base, ctx);
  expect(r.matches.length).toBe(1);
  expect(r.matches[0].valueType).toBe("number");
});

test("exact mode rejects a substring", () => {
  const r = searchUnits(units({ a: "hello world" }), "hello", { ...base, mode: "exact" }, ctx);
  expect(r.matches.length).toBe(0);
});

test("regex mode matches a pattern", () => {
  const r = searchUnits(units({ a: "abc123" }), "[0-9]+", { ...base, mode: "regex" }, ctx);
  expect(r.matches.length).toBe(1);
});

test("case-sensitive mode respects case", () => {
  const r = searchUnits(units({ a: "HELLO" }), "hello", { ...base, caseSensitive: true }, ctx);
  expect(r.matches.length).toBe(0);
});

test("the node filter excludes other nodes", () => {
  const us: SearchUnit[] = [
    { node: "A", runIndex: 0, outputIndex: 0, itemIndex: 0, json: { v: "x" }, binary: undefined },
    { node: "B", runIndex: 0, outputIndex: 0, itemIndex: 0, json: { v: "x" }, binary: undefined },
  ];
  const r = searchUnits(us, "x", { ...base, node: "B" }, ctx);
  expect(r.matches.length).toBe(1);
  expect(r.matches[0].node).toBe("B");
});

test("max-matches caps results and flags truncation", () => {
  const r = searchUnits(units({ a: "x", b: "x", c: "x" }), "x", { ...base, maxMatches: 2 }, ctx);
  expect(r.matches.length).toBe(2);
  expect(r.truncated).toBe(true);
});

test("truncate shortens long values", () => {
  const long = "y".repeat(50);
  const r = searchUnits(units({ a: long }), "y", { ...base, truncate: 10 }, ctx);
  expect(r.matches[0].value).toBe("yyyyyyyyyy…");
});

test("context captures the parent container", () => {
  const r = searchUnits(units({ order: { id: "A", status: "paid" } }), "A", { ...base, context: true }, ctx);
  expect(r.matches[0].context).toEqual({ id: "A", status: "paid" });
});

test("searches binary metadata fields", () => {
  const us: SearchUnit[] = [{
    node: "N", runIndex: 0, outputIndex: 0, itemIndex: 0,
    json: {}, binary: { data0: { fileName: "invoice.pdf", mimeType: "application/pdf" } },
  }];
  const r = searchUnits(us, "invoice", base, ctx);
  expect(r.matches.length).toBe(1);
  expect(r.matches[0].path).toBe("binary.data0.fileName");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/search.test.ts`
Expected: FAIL — cannot resolve `../src/search`.

- [ ] **Step 3: Write `src/search.ts`**

```ts
import type { Match, MatchMode, SearchUnit } from "./types";
import { formatPath } from "./paths";

export interface SearchOptions {
  mode: MatchMode;
  caseSensitive: boolean;
  node?: string;
  maxMatches: number;
  context: boolean;
  truncate: number | null;
}

export interface SearchResult {
  matches: Match[];
  truncated: boolean;
  itemsSearched: number;
}

const BINARY_META_FIELDS = ["fileName", "mimeType", "fileExtension"];

function makeMatcher(
  value: string,
  mode: MatchMode,
  caseSensitive: boolean,
): (haystack: string) => boolean {
  if (mode === "regex") {
    const re = new RegExp(value, caseSensitive ? "" : "i");
    return (h) => re.test(h);
  }
  const needle = caseSensitive ? value : value.toLowerCase();
  return (raw) => {
    const h = caseSensitive ? raw : raw.toLowerCase();
    return mode === "exact" ? h === needle : h.includes(needle);
  };
}

function truncateValue(text: string, limit: number | null): string {
  if (limit === null || text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

export function searchUnits(
  units: SearchUnit[],
  value: string,
  options: SearchOptions,
  ctx: { executionId: string; url: string },
): SearchResult {
  const matches: Match[] = [];
  const matcher = makeMatcher(value, options.mode, options.caseSensitive);
  let itemsSearched = 0;
  let truncated = false;

  const scalar = (node: unknown): node is string | number | boolean =>
    node === null ||
    ["string", "number", "boolean"].includes(typeof node);

  for (const unit of units) {
    if (options.node && unit.node !== options.node) continue;
    if (matches.length >= options.maxMatches) {
      truncated = true;
      break;
    }
    itemsSearched++;

    const record = (
      path: string,
      raw: unknown,
      parent: unknown,
    ): boolean => {
      if (raw === null || raw === undefined) return false;
      const text = String(raw);
      if (!matcher(text)) return false;
      matches.push({
        executionId: ctx.executionId,
        node: unit.node,
        runIndex: unit.runIndex,
        outputIndex: unit.outputIndex,
        itemIndex: unit.itemIndex,
        path,
        value: truncateValue(text, options.truncate),
        valueType: typeof raw,
        url: ctx.url,
        ...(options.context ? { context: parent } : {}),
      });
      if (matches.length >= options.maxMatches) {
        truncated = true;
        return true;
      }
      return false;
    };

    const walk = (
      node: unknown,
      segments: Array<string | number>,
      parent: unknown,
    ): boolean => {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (walk(node[i], [...segments, i], node)) return true;
        }
        return false;
      }
      if (node !== null && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          if (walk(child, [...segments, key], node)) return true;
        }
        return false;
      }
      if (scalar(node)) {
        return record(formatPath(segments), node, parent);
      }
      return false;
    };

    if (walk(unit.json, [], unit.json)) break;

    if (unit.binary) {
      let stop = false;
      for (const [key, meta] of Object.entries(unit.binary)) {
        if (meta === null || typeof meta !== "object") continue;
        for (const field of BINARY_META_FIELDS) {
          const raw = (meta as Record<string, unknown>)[field];
          if (raw === undefined) continue;
          if (record(`binary.${key}.${field}`, raw, meta)) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
      if (stop) break;
    }
  }

  return { matches, truncated, itemsSearched };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/search.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/search.ts tests/search.test.ts
git commit -m "feat: add recursive JSON search with path tracking"
```

### Task 6: Execution data normalization (`n8n-data.ts`)

**Files:**
- Create: `src/n8n-data.ts`
- Test: `tests/n8n-data.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/n8n-data.test.ts`

```ts
import { test, expect } from "bun:test";
import {
  normalizeExecutionData,
  extractSearchUnits,
  extractNodeSummaries,
  extractExecutionInfo,
} from "../src/n8n-data";
import { CliError } from "../src/types";

function exec(dataField: unknown) {
  return {
    id: 7,
    workflowId: "WF",
    status: "success",
    mode: "trigger",
    finished: true,
    startedAt: "S",
    stoppedAt: "T",
    data: dataField,
  };
}

const runData = {
  resultData: {
    lastNodeExecuted: "B",
    runData: {
      A: [
        {
          executionStatus: "success",
          data: { main: [[{ json: { v: "alpha" } }, { json: { v: "beta" } }]] },
        },
      ],
      B: [{ executionStatus: "success", data: { main: [[{ json: { v: "gamma" } }]] } }],
    },
  },
};

test("normalizes object-form data", () => {
  expect(normalizeExecutionData(exec(runData))).toEqual(runData);
});

test("normalizes stringified data", () => {
  expect(normalizeExecutionData(exec(JSON.stringify(runData)))).toEqual(runData);
});

test("throws no-execution-data when data is missing", () => {
  try {
    normalizeExecutionData(exec(undefined));
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe("no-execution-data");
  }
});

test("extracts search units across nodes", () => {
  const units = extractSearchUnits(runData);
  expect(units.length).toBe(3);
  expect(units[0]).toEqual({
    node: "A",
    runIndex: 0,
    outputIndex: 0,
    itemIndex: 0,
    json: { v: "alpha" },
    binary: undefined,
  });
});

test("filters search units by node", () => {
  const units = extractSearchUnits(runData, "B");
  expect(units.length).toBe(1);
  expect(units[0].node).toBe("B");
});

test("summarizes nodes with run and item counts", () => {
  const summaries = extractNodeSummaries(runData);
  expect(summaries).toContainEqual({ name: "A", runs: 1, items: 2, status: "success" });
  expect(summaries).toContainEqual({ name: "B", runs: 1, items: 1, status: "success" });
});

test("extracts execution info with a canonical URL", () => {
  const info = extractExecutionInfo(exec(runData), "https://h.co");
  expect(info.id).toBe("7");
  expect(info.workflowId).toBe("WF");
  expect(info.url).toBe("https://h.co/workflow/WF/executions/7");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/n8n-data.test.ts`
Expected: FAIL — cannot resolve `../src/n8n-data`.

- [ ] **Step 3: Write `src/n8n-data.ts`**

```ts
import {
  CliError,
  type ExecutionInfo,
  type NodeSummary,
  type SearchUnit,
} from "./types";
import { buildExecutionUrl } from "./url";

export function normalizeExecutionData(execution: unknown): any {
  const exec = execution as Record<string, unknown>;
  const data = exec?.data;
  if (data === undefined || data === null) {
    throw new CliError(
      "no-execution-data",
      "Execution returned no data. It may have been pruned by retention, or it is too old.",
    );
  }
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      throw new CliError(
        "no-execution-data",
        "Execution data could not be parsed.",
      );
    }
  }
  return data;
}

function runDataOf(data: any): Record<string, any[]> {
  return data?.resultData?.runData ?? {};
}

export function extractSearchUnits(data: any, nodeFilter?: string): SearchUnit[] {
  const runData = runDataOf(data);
  const units: SearchUnit[] = [];
  for (const [node, runs] of Object.entries(runData)) {
    if (nodeFilter && node !== nodeFilter) continue;
    (runs ?? []).forEach((run: any, runIndex: number) => {
      const main: any[] = run?.data?.main ?? [];
      main.forEach((output: any[], outputIndex: number) => {
        (output ?? []).forEach((item: any, itemIndex: number) => {
          units.push({
            node,
            runIndex,
            outputIndex,
            itemIndex,
            json: item?.json ?? {},
            binary: item?.binary,
          });
        });
      });
    });
  }
  return units;
}

export function extractNodeSummaries(data: any): NodeSummary[] {
  const runData = runDataOf(data);
  const summaries: NodeSummary[] = [];
  for (const [name, runs] of Object.entries(runData)) {
    const runList = runs ?? [];
    let items = 0;
    for (const run of runList) {
      const main: any[] = run?.data?.main ?? [];
      for (const output of main) items += (output ?? []).length;
    }
    const last = runList[runList.length - 1];
    summaries.push({
      name,
      runs: runList.length,
      items,
      status: last?.executionStatus ?? "unknown",
    });
  }
  return summaries;
}

export function extractExecutionInfo(
  execution: any,
  baseUrl: string,
): ExecutionInfo {
  const id = String(execution.id);
  const workflowId = String(execution.workflowId);
  return {
    id,
    workflowId,
    status: execution.status ?? "unknown",
    mode: execution.mode ?? "unknown",
    finished: Boolean(execution.finished),
    startedAt: execution.startedAt ?? null,
    stoppedAt: execution.stoppedAt ?? null,
    url: buildExecutionUrl(baseUrl, workflowId, id),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/n8n-data.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/n8n-data.ts tests/n8n-data.test.ts
git commit -m "feat: add execution data normalization and extraction"
```

### Task 7: Webhook extraction (`webhooks.ts`)

**Files:**
- Create: `src/webhooks.ts`
- Test: `tests/webhooks.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/webhooks.test.ts`

```ts
import { test, expect } from "bun:test";
import { extractWebhooks } from "../src/webhooks";

test("extracts a webhook node with path and method", () => {
  const nodes = [
    {
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      parameters: { path: "abc-123", httpMethod: "POST" },
    },
  ];
  expect(extractWebhooks(nodes, "https://h.co")).toEqual([
    {
      node: "Webhook",
      method: "POST",
      path: "abc-123",
      productionUrl: "https://h.co/webhook/abc-123",
      testUrl: "https://h.co/webhook-test/abc-123",
    },
  ]);
});

test("falls back to webhookId and GET when parameters are absent", () => {
  const nodes = [
    { name: "Hook", type: "n8n-nodes-base.webhook", webhookId: "wid-9" },
  ];
  const [w] = extractWebhooks(nodes, "https://h.co");
  expect(w.path).toBe("wid-9");
  expect(w.method).toBe("GET");
});

test("treats any node carrying a webhookId as a webhook", () => {
  const nodes = [
    { name: "Form", type: "n8n-nodes-base.formTrigger", webhookId: "f1", parameters: {} },
  ];
  expect(extractWebhooks(nodes, "https://h.co").length).toBe(1);
});

test("ignores non-webhook nodes", () => {
  const nodes = [{ name: "Set", type: "n8n-nodes-base.set", parameters: {} }];
  expect(extractWebhooks(nodes, "https://h.co")).toEqual([]);
});

test("handles a missing or empty nodes array", () => {
  expect(extractWebhooks(undefined as any, "https://h.co")).toEqual([]);
  expect(extractWebhooks([], "https://h.co")).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/webhooks.test.ts`
Expected: FAIL — cannot resolve `../src/webhooks`.

- [ ] **Step 3: Write `src/webhooks.ts`**

```ts
import type { WebhookEntry } from "./types";

const WEBHOOK_NODE_TYPES = new Set([
  "n8n-nodes-base.webhook",
  "n8n-nodes-base.formTrigger",
  "@n8n/n8n-nodes-langchain.chatTrigger",
]);

function isWebhookNode(node: any): boolean {
  return WEBHOOK_NODE_TYPES.has(node?.type) || typeof node?.webhookId === "string";
}

export function extractWebhooks(
  nodes: any[] | undefined,
  baseUrl: string,
): WebhookEntry[] {
  if (!Array.isArray(nodes)) return [];
  const entries: WebhookEntry[] = [];
  for (const node of nodes) {
    if (!isWebhookNode(node)) continue;
    const path = String(node?.parameters?.path ?? node?.webhookId ?? "");
    const method = String(node?.parameters?.httpMethod ?? "GET").toUpperCase();
    entries.push({
      node: String(node?.name ?? ""),
      method,
      path,
      productionUrl: `${baseUrl}/webhook/${path}`,
      testUrl: `${baseUrl}/webhook-test/${path}`,
    });
  }
  return entries;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/webhooks.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/webhooks.ts tests/webhooks.test.ts
git commit -m "feat: add webhook extraction from workflow nodes"
```

---

## Phase 3 — I/O modules

### Task 8: Config and disk paths (`config.ts`)

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

`config.ts` resolves its root directory from `N8N_LOCATE_HOME` if set, else
`~/.n8n-locate`. Tests set `N8N_LOCATE_HOME` to a temp directory.

- [ ] **Step 1: Write the failing tests** in `tests/config.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  upsertInstance,
  resolveInstance,
  catalogPaths,
  execCachePath,
} from "../src/config";
import { CliError } from "../src/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-"));
  process.env.N8N_LOCATE_HOME = home;
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_BASE_URL;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
});

test("loadConfig returns an empty config when no file exists", () => {
  expect(loadConfig()).toEqual({ instances: {} });
});

test("upsertInstance writes and the first instance becomes default", () => {
  upsertInstance("h.co", { baseUrl: "https://h.co", apiKey: "K" }, false);
  const cfg = loadConfig();
  expect(cfg.defaultInstance).toBe("h.co");
  expect(cfg.instances["h.co"].apiKey).toBe("K");
});

test("saveConfig writes the file with 0600 permissions", () => {
  saveConfig({ instances: {} });
  const mode = statSync(join(home, "config.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("resolveInstance reads the host entry from config", () => {
  upsertInstance("h.co", { baseUrl: "https://h.co", apiKey: "K" }, true);
  expect(resolveInstance({ host: "h.co" })).toEqual({
    host: "h.co",
    baseUrl: "https://h.co",
    apiKey: "K",
  });
});

test("resolveInstance lets N8N_API_KEY override the stored key", () => {
  upsertInstance("h.co", { baseUrl: "https://h.co", apiKey: "OLD" }, true);
  process.env.N8N_API_KEY = "ENVKEY";
  expect(resolveInstance({ host: "h.co" }).apiKey).toBe("ENVKEY");
});

test("resolveInstance throws no-credentials when nothing resolves", () => {
  try {
    resolveInstance({});
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("no-credentials");
  }
});

test("catalogPaths and execCachePath are under the home dir", () => {
  expect(catalogPaths("h.co").workflowsPath).toBe(
    join(home, "catalog", "h.co", "workflows.jsonl"),
  );
  expect(execCachePath("h.co", "99")).toBe(
    join(home, "cache", "h.co", "executions", "99.json"),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CliError,
  type Config,
  type InstanceConfig,
  type ResolvedInstance,
} from "./types";

export function getHome(): string {
  return process.env.N8N_LOCATE_HOME ?? join(homedir(), ".n8n-locate");
}

function configPath(): string {
  return join(getHome(), "config.json");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return { instances: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    return { defaultInstance: raw.defaultInstance, instances: raw.instances ?? {} };
  } catch {
    return { instances: {} };
  }
}

export function saveConfig(config: Config): void {
  const home = getHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function upsertInstance(
  host: string,
  instance: InstanceConfig,
  makeDefault: boolean,
): void {
  const config = loadConfig();
  config.instances[host] = instance;
  if (makeDefault || !config.defaultInstance) {
    config.defaultInstance = host;
  }
  saveConfig(config);
}

export function resolveInstance(input: {
  host?: string;
  baseUrl?: string;
}): ResolvedInstance {
  const config = loadConfig();
  const envBaseUrl = process.env.N8N_BASE_URL;
  let envHost: string | undefined;
  if (envBaseUrl) {
    try {
      envHost = new URL(envBaseUrl).host;
    } catch {
      envHost = undefined;
    }
  }
  const host = input.host ?? envHost ?? config.defaultInstance;
  if (!host) {
    throw new CliError(
      "no-credentials",
      "No n8n instance specified. Run `n8n-locate login` or pass a workflow/execution URL.",
    );
  }
  const stored = config.instances[host];
  const apiKey = process.env.N8N_API_KEY ?? stored?.apiKey;
  if (!apiKey) {
    throw new CliError(
      "no-credentials",
      `No API key for ${host}. Run \`n8n-locate login --url https://${host}\` or set N8N_API_KEY.`,
    );
  }
  const baseUrl = input.baseUrl ?? stored?.baseUrl ?? envBaseUrl;
  if (!baseUrl) {
    throw new CliError(
      "no-credentials",
      `No base URL for ${host}. Run \`n8n-locate login --url https://${host}\`.`,
    );
  }
  return { host, baseUrl, apiKey };
}

export function catalogPaths(host: string): {
  dir: string;
  manifestPath: string;
  workflowsPath: string;
} {
  const dir = join(getHome(), "catalog", encodeURIComponent(host));
  return {
    dir,
    manifestPath: join(dir, "manifest.json"),
    workflowsPath: join(dir, "workflows.jsonl"),
  };
}

export function execCachePath(host: string, executionId: string): string {
  return join(
    getHome(),
    "cache",
    encodeURIComponent(host),
    "executions",
    `${executionId}.json`,
  );
}
```

Note: `encodeURIComponent("h.co")` is `"h.co"` (unreserved characters), so the
test paths match exactly.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/config.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config load/save, instance resolution, disk paths"
```

### Task 9: n8n API client (`client.ts`)

**Files:**
- Create: `src/client.ts`
- Test: `tests/client.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/client.test.ts`

```ts
import { test, expect } from "bun:test";
import { N8nClient } from "../src/client";
import { CliError } from "../src/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: typeof fetch): N8nClient {
  return new N8nClient({
    baseUrl: "https://h.co",
    apiKey: "K",
    fetchImpl,
  });
}

test("getExecution requests the right URL with the API key header", async () => {
  let seenUrl = "";
  let seenKey = "";
  const client = clientWith(async (url, init) => {
    seenUrl = String(url);
    seenKey = (init?.headers as Record<string, string>)["X-N8N-API-KEY"];
    return jsonResponse({ id: 5 });
  });
  const result = await client.getExecution("5");
  expect(seenUrl).toBe("https://h.co/api/v1/executions/5?includeData=true");
  expect(seenKey).toBe("K");
  expect(result).toEqual({ id: 5 });
});

test("listWorkflows returns data and nextCursor", async () => {
  const client = clientWith(async () =>
    jsonResponse({ data: [{ id: "A" }], nextCursor: "C" }),
  );
  expect(await client.listWorkflows({ limit: 10 })).toEqual({
    data: [{ id: "A" }],
    nextCursor: "C",
  });
});

test("a 401 maps to a CliError with code unauthorized", async () => {
  const client = clientWith(async () => jsonResponse({}, 401));
  try {
    await client.getExecution("5");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("unauthorized");
  }
});

test("a 404 maps to code not-found", async () => {
  const client = clientWith(async () => jsonResponse({}, 404));
  try {
    await client.getExecution("5");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("not-found");
  }
});

test("a 429 is retried then succeeds", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls++;
    return calls < 2 ? jsonResponse({}, 429) : jsonResponse({ id: 5 });
  });
  const result = await client.getExecution("5");
  expect(calls).toBe(2);
  expect(result).toEqual({ id: 5 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/client.test.ts`
Expected: FAIL — cannot resolve `../src/client`.

- [ ] **Step 3: Write `src/client.ts`**

```ts
import { CliError } from "./types";

interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseMs?: number;
}

interface ListResponse {
  data: any[];
  nextCursor: string | null;
}

function statusToCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "n8n-error";
}

export class N8nClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
  }

  private async request<T>(
    path: string,
    query: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          headers: {
            "X-N8N-API-KEY": this.apiKey,
            Accept: "application/json",
          },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        throw new CliError(
          "network-error",
          `Request to ${url.pathname} failed: ${(err as Error).message}`,
        );
      }
      clearTimeout(timer);

      if (response.status === 429 && attempt < this.maxRetries) {
        await new Promise((r) =>
          setTimeout(r, this.retryBaseMs * 2 ** attempt),
        );
        continue;
      }

      if (!response.ok) {
        throw new CliError(
          statusToCode(response.status),
          `n8n API error ${response.status} on ${url.pathname}`,
        );
      }

      return (await response.json()) as T;
    }
  }

  getExecution(id: string): Promise<any> {
    return this.request<any>(`/executions/${encodeURIComponent(id)}`, {
      includeData: "true",
    });
  }

  listExecutions(params: {
    workflowId?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListResponse> {
    return this.request<ListResponse>("/executions", {
      workflowId: params.workflowId,
      status: params.status,
      limit: params.limit ? String(params.limit) : undefined,
      cursor: params.cursor,
    });
  }

  listWorkflows(params: {
    limit?: number;
    cursor?: string;
    active?: boolean;
  }): Promise<ListResponse> {
    return this.request<ListResponse>("/workflows", {
      limit: params.limit ? String(params.limit) : undefined,
      cursor: params.cursor,
      active: params.active === undefined ? undefined : String(params.active),
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat: add n8n API client with timeout and 429 retry"
```

### Task 10: Workflow catalog (`catalog.ts`)

**Files:**
- Create: `src/catalog.ts`
- Test: `tests/catalog.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/catalog.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectWorkflow,
  buildCatalog,
  readManifest,
  catalogExists,
  searchCatalog,
} from "../src/catalog";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-cat-"));
  process.env.N8N_LOCATE_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
});

test("projectWorkflow keeps searchable fields and drops the node graph", () => {
  const row = projectWorkflow(
    {
      id: "WF",
      name: "Sales",
      active: true,
      isArchived: false,
      tags: [{ name: "sales" }],
      triggerCount: 1,
      createdAt: "C",
      updatedAt: "U",
      nodes: [
        { name: "Webhook", type: "n8n-nodes-base.webhook", parameters: { path: "p1" } },
      ],
    },
    "https://h.co",
  );
  expect(row.id).toBe("WF");
  expect(row.tags).toEqual(["sales"]);
  expect(row.webhooks[0].path).toBe("p1");
  expect(row.url).toBe("https://h.co/workflow/WF");
  expect((row as any).nodes).toBeUndefined();
});

const fakeClient = {
  listWorkflows: async (params: { cursor?: string }) => {
    if (!params.cursor) {
      return {
        data: [
          { id: "WF1", name: "Alpha", active: true, isArchived: false, tags: [], triggerCount: 0, createdAt: "C", updatedAt: "U", nodes: [] },
        ],
        nextCursor: "next",
      };
    }
    return {
      data: [
        { id: "WF2", name: "Beta", active: false, isArchived: false, tags: [], triggerCount: 0, createdAt: "C", updatedAt: "U", nodes: [] },
      ],
      nextCursor: null,
    };
  },
};

test("buildCatalog pages through all workflows and writes a manifest", async () => {
  const manifest = await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  expect(manifest.workflowCount).toBe(2);
  expect(catalogExists("h.co")).toBe(true);
  expect(readManifest("h.co")?.workflowCount).toBe(2);
});

test("searchCatalog matches by name substring", async () => {
  await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  const r = await searchCatalog("h.co", { query: "alph", limit: 50, offset: 0 });
  expect(r.totalMatches).toBe(1);
  expect(r.rows[0].id).toBe("WF1");
});

test("searchCatalog filters by active", async () => {
  await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  const r = await searchCatalog("h.co", { active: true, limit: 50, offset: 0 });
  expect(r.rows.every((row) => row.active)).toBe(true);
});

test("searchCatalog applies offset and limit", async () => {
  await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  const r = await searchCatalog("h.co", { limit: 1, offset: 1 });
  expect(r.totalMatches).toBe(2);
  expect(r.rows.length).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/catalog.test.ts`
Expected: FAIL — cannot resolve `../src/catalog`.

- [ ] **Step 3: Write `src/catalog.ts`**

```ts
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import type { CatalogManifest, WorkflowRow } from "./types";
import type { N8nClient } from "./client";
import { catalogPaths } from "./config";
import { extractWebhooks } from "./webhooks";
import { buildWorkflowUrl } from "./url";

const SCHEMA_VERSION = 1;

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: any) => (typeof t === "string" ? t : String(t?.name ?? ""))).filter(Boolean);
}

export function projectWorkflow(raw: any, baseUrl: string): WorkflowRow {
  const id = String(raw.id);
  return {
    id,
    name: String(raw.name ?? ""),
    active: Boolean(raw.active),
    isArchived: Boolean(raw.isArchived),
    tags: normalizeTags(raw.tags),
    triggerCount: Number(raw.triggerCount ?? 0),
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
    webhooks: extractWebhooks(raw.nodes, baseUrl),
    url: buildWorkflowUrl(baseUrl, id),
  };
}

export async function buildCatalog(
  client: N8nClient,
  host: string,
  baseUrl: string,
  onProgress?: (count: number) => void,
): Promise<CatalogManifest> {
  const paths = catalogPaths(host);
  mkdirSync(paths.dir, { recursive: true });
  const tmpWorkflows = `${paths.workflowsPath}.tmp`;
  const tmpManifest = `${paths.manifestPath}.tmp`;
  writeFileSync(tmpWorkflows, "");

  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await client.listWorkflows({ limit: 250, cursor });
    const lines = page.data
      .map((raw) => JSON.stringify(projectWorkflow(raw, baseUrl)))
      .join("\n");
    if (lines.length > 0) appendFileSync(tmpWorkflows, lines + "\n");
    count += page.data.length;
    onProgress?.(count);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const manifest: CatalogManifest = {
    schemaVersion: SCHEMA_VERSION,
    instance: host,
    baseUrl,
    syncedAt: new Date().toISOString(),
    workflowCount: count,
  };
  writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmpWorkflows, paths.workflowsPath);
  renameSync(tmpManifest, paths.manifestPath);
  return manifest;
}

export function catalogExists(host: string): boolean {
  const paths = catalogPaths(host);
  return existsSync(paths.manifestPath) && existsSync(paths.workflowsPath);
}

export function readManifest(host: string): CatalogManifest | null {
  const paths = catalogPaths(host);
  if (!existsSync(paths.manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(paths.manifestPath, "utf8")) as CatalogManifest;
  } catch {
    return null;
  }
}

export async function* streamCatalog(host: string): AsyncGenerator<WorkflowRow> {
  const paths = catalogPaths(host);
  if (!existsSync(paths.workflowsPath)) return;
  const rl = createInterface({
    input: createReadStream(paths.workflowsPath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    yield JSON.parse(trimmed) as WorkflowRow;
  }
}

export interface CatalogQuery {
  query?: string;
  field?: "id" | "name" | "webhook" | "tag";
  active?: boolean;
  limit: number;
  offset: number;
}

function rowMatches(row: WorkflowRow, query: string, field?: string): boolean {
  const q = query.toLowerCase();
  const inId = () => row.id.toLowerCase().includes(q);
  const inName = () => row.name.toLowerCase().includes(q);
  const inTag = () => row.tags.some((t) => t.toLowerCase().includes(q));
  const inWebhook = () =>
    row.webhooks.some(
      (w) =>
        w.path.toLowerCase().includes(q) ||
        w.productionUrl.toLowerCase().includes(q) ||
        w.testUrl.toLowerCase().includes(q),
    );
  if (field === "id") return inId();
  if (field === "name") return inName();
  if (field === "tag") return inTag();
  if (field === "webhook") return inWebhook();
  return inId() || inName() || inTag() || inWebhook();
}

export async function searchCatalog(
  host: string,
  q: CatalogQuery,
): Promise<{ rows: WorkflowRow[]; totalMatches: number }> {
  const matched: WorkflowRow[] = [];
  for await (const row of streamCatalog(host)) {
    if (q.active !== undefined && row.active !== q.active) continue;
    if (q.query && !rowMatches(row, q.query, q.field)) continue;
    matched.push(row);
  }
  return {
    rows: matched.slice(q.offset, q.offset + q.limit),
    totalMatches: matched.length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/catalog.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts tests/catalog.test.ts
git commit -m "feat: add disk-backed JSONL workflow catalog"
```

### Task 11: Execution cache (`exec-cache.ts`)

**Files:**
- Create: `src/exec-cache.ts`
- Test: `tests/exec-cache.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/exec-cache.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionCached } from "../src/exec-cache";
import { execCachePath } from "../src/config";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-ec-"));
  process.env.N8N_LOCATE_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
});

function clientReturning(execution: any) {
  let calls = 0;
  return {
    getExecution: async () => {
      calls++;
      return execution;
    },
    callCount: () => calls,
  };
}

test("a finished execution is cached and reused on the next call", async () => {
  const client = clientReturning({ id: 9, finished: true, data: {} });
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: false });
  expect(existsSync(execCachePath("h.co", "9"))).toBe(true);
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: false });
  expect(client.callCount()).toBe(1);
});

test("an unfinished execution is not cached", async () => {
  const client = clientReturning({ id: 9, finished: false, data: {} });
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: false });
  expect(existsSync(execCachePath("h.co", "9"))).toBe(false);
});

test("refresh bypasses the cache and re-fetches", async () => {
  const client = clientReturning({ id: 9, finished: true, data: {} });
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: false });
  await getExecutionCached(client as any, "h.co", "9", { refresh: true, noCache: false });
  expect(client.callCount()).toBe(2);
});

test("noCache neither reads nor writes the cache", async () => {
  const client = clientReturning({ id: 9, finished: true, data: {} });
  await getExecutionCached(client as any, "h.co", "9", { refresh: false, noCache: true });
  expect(existsSync(execCachePath("h.co", "9"))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/exec-cache.test.ts`
Expected: FAIL — cannot resolve `../src/exec-cache`.

- [ ] **Step 3: Write `src/exec-cache.ts`**

```ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { N8nClient } from "./client";
import { execCachePath } from "./config";

export async function getExecutionCached(
  client: N8nClient,
  host: string,
  executionId: string,
  opts: { refresh: boolean; noCache: boolean },
): Promise<any> {
  const path = execCachePath(host, executionId);

  if (!opts.refresh && !opts.noCache && existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt cache entry — fall through to a fresh fetch.
    }
  }

  const execution = await client.getExecution(executionId);

  if (!opts.noCache && execution?.finished === true) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(execution));
  }

  return execution;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/exec-cache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exec-cache.ts tests/exec-cache.test.ts
git commit -m "feat: add on-disk execution payload cache"
```

### Task 12: Output formatting (`format.ts`)

**Files:**
- Create: `src/format.ts`
- Test: `tests/format.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/format.test.ts`

```ts
import { test, expect } from "bun:test";
import { resolveOutputMode, toCliError } from "../src/format";
import { CliError } from "../src/types";

test("--json forces json mode", () => {
  expect(resolveOutputMode({ json: true })).toBe("json");
});

test("--text forces text mode", () => {
  expect(resolveOutputMode({ text: true })).toBe("text");
});

test("toCliError passes a CliError through unchanged", () => {
  const err = new CliError("not-found", "missing");
  expect(toCliError(err)).toBe(err);
});

test("toCliError wraps an unknown error with code n8n-error", () => {
  const wrapped = toCliError(new Error("boom"));
  expect(wrapped).toBeInstanceOf(CliError);
  expect(wrapped.code).toBe("n8n-error");
  expect(wrapped.message).toBe("boom");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/format.test.ts`
Expected: FAIL — cannot resolve `../src/format`.

- [ ] **Step 3: Write `src/format.ts`**

```ts
import { CliError } from "./types";

export type OutputMode = "json" | "text";

export function resolveOutputMode(opts: {
  json?: boolean;
  text?: boolean;
}): OutputMode {
  if (opts.json) return "json";
  if (opts.text) return "text";
  return process.stdout.isTTY ? "text" : "json";
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("n8n-error", message);
}

export function emitJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

export function progress(message: string, quiet: boolean): void {
  if (!quiet) process.stderr.write(message + "\n");
}

export function emitError(error: CliError, mode: OutputMode): void {
  if (mode === "json") {
    process.stdout.write(
      JSON.stringify(
        { error: { code: error.code, message: error.message, details: error.details } },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stderr.write(`Error (${error.code}): ${error.message}\n`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/format.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/format.ts tests/format.test.ts
git commit -m "feat: add output-mode resolution and JSON/error emission"
```

---

## Phase 4 — Commands

Each command file exports an async `run*` function that takes positional
arguments plus a merged options object and returns a numeric exit code. It uses
`progress()` for stderr status and `emitJson`/`emitText` for stdout. Errors are
thrown as `CliError`; `cli.ts` (Task 19) catches them.

The shared options object passed to every command:

```ts
interface CommonOpts {
  json?: boolean;
  text?: boolean;
  instance?: string;
  quiet?: boolean;
}
```

### Task 13: `login` command

**Files:**
- Create: `src/commands/login.ts`
- Test: `tests/commands-login.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/commands-login.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "../src/commands/login";
import { loadConfig } from "../src/config";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-login-"));
  process.env.N8N_LOCATE_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
});

test("runLogin validates the key and stores the instance", async () => {
  const validate = async (_baseUrl: string, _key: string) => true;
  const code = await runLogin(
    { url: "https://n8n.h.co", key: "K", json: true, quiet: true },
    validate,
  );
  expect(code).toBe(0);
  const cfg = loadConfig();
  expect(cfg.instances["n8n.h.co"].apiKey).toBe("K");
  expect(cfg.defaultInstance).toBe("n8n.h.co");
});

test("runLogin throws when validation fails", async () => {
  const validate = async () => false;
  await expect(
    runLogin({ url: "https://n8n.h.co", key: "BAD", json: true, quiet: true }, validate),
  ).rejects.toMatchObject({ code: "unauthorized" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/commands-login.test.ts`
Expected: FAIL — cannot resolve `../src/commands/login`.

- [ ] **Step 3: Write `src/commands/login.ts`**

```ts
import { CliError } from "../types";
import { upsertInstance } from "../config";
import { N8nClient } from "../client";
import { emitJson, progress } from "../format";

export interface LoginOpts {
  url: string;
  key?: string;
  default?: boolean;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

async function defaultValidate(baseUrl: string, key: string): Promise<boolean> {
  const client = new N8nClient({ baseUrl, apiKey: key });
  try {
    await client.listWorkflows({ limit: 1 });
    return true;
  } catch (err) {
    if (err instanceof CliError && err.code === "unauthorized") return false;
    throw err;
  }
}

async function promptForKey(promptText: string): Promise<string> {
  process.stderr.write(promptText);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

export async function runLogin(
  opts: LoginOpts,
  validate: (baseUrl: string, key: string) => Promise<boolean> = defaultValidate,
): Promise<number> {
  let host: string;
  try {
    host = new URL(opts.url).host;
  } catch {
    throw new CliError("bad-url", `Invalid instance URL: ${opts.url}`);
  }
  const baseUrl = opts.url.replace(/\/+$/, "");

  const key = opts.key ?? (await promptForKey("Enter your n8n API key: "));
  if (!key) throw new CliError("bad-arguments", "No API key provided.");

  progress(`Validating key against ${host}...`, opts.quiet ?? false);
  const ok = await validate(baseUrl, key);
  if (!ok) {
    throw new CliError("unauthorized", `The API key was rejected by ${host}.`);
  }

  upsertInstance(host, { baseUrl, apiKey: key }, opts.default ?? false);
  progress(`Saved credentials for ${host}.`, opts.quiet ?? false);
  emitJson({ instance: host, baseUrl, saved: true });
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/commands-login.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/login.ts tests/commands-login.test.ts
git commit -m "feat: add login command"
```

### Task 14: `sync` command

**Files:**
- Create: `src/commands/sync.ts`
- Test: `tests/commands-sync.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/commands-sync.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../src/commands/sync";
import { catalogExists } from "../src/catalog";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-sync-"));
  process.env.N8N_LOCATE_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runSync builds a catalog for the resolved instance", async () => {
  const fakeClient = {
    listWorkflows: async () => ({
      data: [
        { id: "WF1", name: "Alpha", active: true, isArchived: false, tags: [], triggerCount: 0, createdAt: "C", updatedAt: "U", nodes: [] },
      ],
      nextCursor: null,
    }),
  };
  const code = await runSync({ json: true, quiet: true }, () => fakeClient as any);
  expect(code).toBe(0);
  expect(catalogExists("h.co")).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/commands-sync.test.ts`
Expected: FAIL — cannot resolve `../src/commands/sync`.

- [ ] **Step 3: Write `src/commands/sync.ts`**

```ts
import type { ResolvedInstance } from "../types";
import { resolveInstance, catalogPaths } from "../config";
import { N8nClient } from "../client";
import { buildCatalog } from "../catalog";
import { emitJson, progress } from "../format";

export interface SyncOpts {
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export async function runSync(
  opts: SyncOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const instance = resolveInstance({ host: opts.instance });
  const client = clientFactory(instance);

  progress(`Syncing workflows from ${instance.host}...`, opts.quiet ?? false);
  const manifest = await buildCatalog(
    client,
    instance.host,
    instance.baseUrl,
    (count) => progress(`  fetched ${count} workflows`, opts.quiet ?? false),
  );

  emitJson({
    instance: instance.host,
    baseUrl: instance.baseUrl,
    workflowCount: manifest.workflowCount,
    syncedAt: manifest.syncedAt,
    catalogPath: catalogPaths(instance.host).workflowsPath,
  });
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/commands-sync.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/commands/sync.ts tests/commands-sync.test.ts
git commit -m "feat: add sync command"
```

### Task 15: `workflows` command

**Files:**
- Create: `src/commands/workflows.ts`
- Test: `tests/commands-workflows.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/commands-workflows.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflows } from "../src/commands/workflows";
import { buildCatalog } from "../src/catalog";
import { CliError } from "../src/types";

let home: string;
const fakeClient = {
  listWorkflows: async () => ({
    data: [
      { id: "WF1", name: "Alpha", active: true, isArchived: false, tags: [], triggerCount: 0, createdAt: "C", updatedAt: "U", nodes: [] },
    ],
    nextCursor: null,
  }),
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-wf-"));
  process.env.N8N_LOCATE_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runWorkflows searches an existing catalog", async () => {
  await buildCatalog(fakeClient as any, "h.co", "https://h.co");
  const code = await runWorkflows("alph", { json: true, quiet: true, limit: "50", offset: "0" }, () => fakeClient as any);
  expect(code).toBe(0);
});

test("runWorkflows errors when --no-sync is set and no catalog exists", async () => {
  await expect(
    runWorkflows(undefined, { json: true, quiet: true, sync: false, limit: "50", offset: "0" }, () => fakeClient as any),
  ).rejects.toBeInstanceOf(CliError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/commands-workflows.test.ts`
Expected: FAIL — cannot resolve `../src/commands/workflows`.

- [ ] **Step 3: Write `src/commands/workflows.ts`**

```ts
import { CliError, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import {
  buildCatalog,
  catalogExists,
  readManifest,
  searchCatalog,
} from "../catalog";
import { emitJson, progress } from "../format";

export interface WorkflowsOpts {
  field?: "id" | "name" | "webhook" | "tag";
  active?: boolean;
  limit?: string;
  offset?: string;
  refresh?: boolean;
  sync?: boolean;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export async function runWorkflows(
  query: string | undefined,
  opts: WorkflowsOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const instance = resolveInstance({ host: opts.instance });
  const quiet = opts.quiet ?? false;

  const needsSync = opts.refresh || !catalogExists(instance.host);
  if (needsSync) {
    if (opts.sync === false) {
      throw new CliError(
        "no-catalog",
        `No workflow catalog for ${instance.host}. Run \`n8n-locate sync\` first.`,
      );
    }
    progress(`Syncing workflow catalog for ${instance.host}...`, quiet);
    await buildCatalog(clientFactory(instance), instance.host, instance.baseUrl);
  }

  const manifest = readManifest(instance.host);
  if (manifest) {
    const ageSeconds = Math.round(
      (Date.now() - new Date(manifest.syncedAt).getTime()) / 1000,
    );
    progress(
      `Catalog: ${manifest.workflowCount} workflows, synced ${ageSeconds}s ago.`,
      quiet,
    );
  }

  const limit = Number(opts.limit ?? "50");
  const offset = Number(opts.offset ?? "0");
  const result = await searchCatalog(instance.host, {
    query,
    field: opts.field,
    active: opts.active,
    limit,
    offset,
  });

  emitJson({
    instance: instance.host,
    catalog: manifest
      ? {
          syncedAt: manifest.syncedAt,
          workflowCount: manifest.workflowCount,
          ageSeconds: Math.round(
            (Date.now() - new Date(manifest.syncedAt).getTime()) / 1000,
          ),
        }
      : null,
    workflows: result.rows,
    summary: {
      totalMatches: result.totalMatches,
      returned: result.rows.length,
      offset,
    },
  });
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/commands-workflows.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/workflows.ts tests/commands-workflows.test.ts
git commit -m "feat: add workflows command with catalog search"
```

### Task 16: `executions` command

**Files:**
- Create: `src/commands/executions.ts`
- Test: `tests/commands-executions.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/commands-executions.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { runExecutions } from "../src/commands/executions";

beforeEach(() => {
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runExecutions lists executions for a bare workflow id", async () => {
  const fakeClient = {
    listExecutions: async () => ({
      data: [
        { id: 5, status: "success", mode: "manual", finished: true, startedAt: "S", stoppedAt: "T", workflowId: "WF" },
      ],
      nextCursor: null,
    }),
  };
  const code = await runExecutions("WF", { json: true, quiet: true, limit: "20" }, () => fakeClient as any);
  expect(code).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/commands-executions.test.ts`
Expected: FAIL — cannot resolve `../src/commands/executions`.

- [ ] **Step 3: Write `src/commands/executions.ts`**

```ts
import { CliError, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { parseN8nUrl, buildWorkflowUrl, buildExecutionUrl } from "../url";
import { emitJson, progress } from "../format";

export interface ExecutionsOpts {
  status?: "success" | "error" | "waiting";
  limit?: string;
  cursor?: string;
  all?: boolean;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

const ALL_CAP = 1000;

export async function runExecutions(
  target: string,
  opts: ExecutionsOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const parsed = parseN8nUrl(target);
  if (parsed && parsed.kind === "execution") {
    throw new CliError(
      "bad-arguments",
      "Pass a workflow URL or id, not an execution URL.",
    );
  }
  const workflowId = parsed ? parsed.workflowId : target;
  const instance = resolveInstance({
    host: parsed?.host,
    baseUrl: parsed?.baseUrl,
  });
  const client = clientFactory(instance);
  const quiet = opts.quiet ?? false;
  const limit = Number(opts.limit ?? "20");

  progress(`Listing executions for workflow ${workflowId}...`, quiet);

  const rows: any[] = [];
  let cursor = opts.cursor;
  let nextCursor: string | null = null;
  do {
    const page = await client.listExecutions({
      workflowId,
      status: opts.status,
      limit,
      cursor,
    });
    rows.push(...page.data);
    nextCursor = page.nextCursor;
    cursor = page.nextCursor ?? undefined;
  } while (opts.all && cursor && rows.length < ALL_CAP);

  emitJson({
    instance: instance.host,
    workflow: {
      id: workflowId,
      url: buildWorkflowUrl(instance.baseUrl, workflowId),
    },
    executions: rows.map((e) => ({
      id: String(e.id),
      status: e.status ?? "unknown",
      mode: e.mode ?? "unknown",
      finished: Boolean(e.finished),
      startedAt: e.startedAt ?? null,
      stoppedAt: e.stoppedAt ?? null,
      url: buildExecutionUrl(instance.baseUrl, workflowId, String(e.id)),
    })),
    nextCursor: opts.all ? null : nextCursor,
    summary: { count: rows.length },
  });
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/commands-executions.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/commands/executions.ts tests/commands-executions.test.ts
git commit -m "feat: add executions command"
```

### Task 17: `search` command

**Files:**
- Create: `src/commands/search.ts`
- Test: `tests/commands-search.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/commands-search.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSearch } from "../src/commands/search";
import { CliError } from "../src/types";

let home: string;

const execution = {
  id: 351694,
  workflowId: "WF",
  status: "success",
  mode: "trigger",
  finished: true,
  startedAt: "S",
  stoppedAt: "T",
  data: {
    resultData: {
      runData: {
        "HTTP Request": [
          { executionStatus: "success", data: { main: [[{ json: { order: { id: "500857721" } } }]] } },
        ],
      },
    },
  },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-search-"));
  process.env.N8N_LOCATE_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runSearch returns exit 0 when a value is found in an execution", async () => {
  const client = { getExecution: async () => execution };
  const code = await runSearch(
    "500857721",
    "https://h.co/workflow/WF/executions/351694",
    { json: true, quiet: true, maxMatches: "100", truncate: "200" },
    () => client as any,
  );
  expect(code).toBe(0);
});

test("runSearch returns exit 1 when nothing matches", async () => {
  const client = { getExecution: async () => execution };
  const code = await runSearch(
    "nothere",
    "https://h.co/workflow/WF/executions/351694",
    { json: true, quiet: true, maxMatches: "100", truncate: "200" },
    () => client as any,
  );
  expect(code).toBe(1);
});

test("runSearch rejects conflicting match modes", async () => {
  const client = { getExecution: async () => execution };
  await expect(
    runSearch(
      "x",
      "https://h.co/workflow/WF/executions/351694",
      { json: true, quiet: true, exact: true, regex: true, maxMatches: "100", truncate: "200" },
      () => client as any,
    ),
  ).rejects.toMatchObject({ code: "bad-arguments" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/commands-search.test.ts`
Expected: FAIL — cannot resolve `../src/commands/search`.

- [ ] **Step 3: Write `src/commands/search.ts`**

```ts
import { writeFileSync } from "node:fs";
import {
  CliError,
  type Match,
  type MatchMode,
  type ResolvedInstance,
} from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { parseN8nUrl, classifyBareId } from "../url";
import { getExecutionCached } from "../exec-cache";
import {
  normalizeExecutionData,
  extractSearchUnits,
  extractExecutionInfo,
} from "../n8n-data";
import { searchUnits, type SearchOptions } from "../search";
import { emitJson, progress } from "../format";

export interface SearchCmdOpts {
  node?: string;
  exact?: boolean;
  regex?: boolean;
  caseSensitive?: boolean;
  limit?: string;
  status?: "success" | "error" | "waiting";
  maxMatches?: string;
  context?: boolean;
  truncate?: string | false;
  refresh?: boolean;
  cache?: boolean;
  out?: string;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

function resolveMode(opts: SearchCmdOpts): MatchMode {
  const chosen = [opts.exact && "exact", opts.regex && "regex"].filter(Boolean);
  if (chosen.length > 1) {
    throw new CliError(
      "bad-arguments",
      "Use only one of --exact or --regex.",
    );
  }
  if (opts.exact) return "exact";
  if (opts.regex) return "regex";
  return "substring";
}

async function searchOneExecution(
  client: N8nClient,
  host: string,
  baseUrl: string,
  executionId: string,
  value: string,
  searchOpts: SearchOptions,
  cacheOpts: { refresh: boolean; noCache: boolean },
): Promise<{ matches: Match[]; itemsSearched: number; nodesSearched: number; truncated: boolean }> {
  const raw = await getExecutionCached(client, host, executionId, cacheOpts);
  const info = extractExecutionInfo(raw, baseUrl);
  const data = normalizeExecutionData(raw);
  const units = extractSearchUnits(data, searchOpts.node);
  const result = searchUnits(units, value, searchOpts, {
    executionId: info.id,
    url: info.url,
  });
  const nodes = new Set(units.map((u) => u.node));
  return {
    matches: result.matches,
    itemsSearched: result.itemsSearched,
    nodesSearched: nodes.size,
    truncated: result.truncated,
  };
}

export async function runSearch(
  value: string,
  target: string,
  opts: SearchCmdOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveMode(opts);
  const quiet = opts.quiet ?? false;

  const parsed = parseN8nUrl(target);
  const instance = resolveInstance({
    host: parsed?.host,
    baseUrl: parsed?.baseUrl,
  });
  const client = clientFactory(instance);

  const kind = parsed ? parsed.kind : classifyBareId(target);
  const searchOpts: SearchOptions = {
    mode,
    caseSensitive: opts.caseSensitive ?? false,
    node: opts.node,
    maxMatches: Number(opts.maxMatches ?? "100"),
    context: opts.context ?? false,
    truncate: opts.truncate === false ? null : Number(opts.truncate ?? "200"),
  };
  const cacheOpts = {
    refresh: opts.refresh ?? false,
    noCache: opts.cache === false,
  };

  const allMatches: Match[] = [];
  let itemsSearched = 0;
  let nodesSearched = 0;
  let executionsSearched = 0;
  let truncated = false;

  if (kind === "execution") {
    const executionId = parsed?.executionId ?? target;
    progress(`Searching execution ${executionId}...`, quiet);
    const r = await searchOneExecution(
      client,
      instance.host,
      instance.baseUrl,
      executionId,
      value,
      searchOpts,
      cacheOpts,
    );
    allMatches.push(...r.matches);
    itemsSearched = r.itemsSearched;
    nodesSearched = r.nodesSearched;
    executionsSearched = 1;
    truncated = r.truncated;
  } else {
    const workflowId = parsed?.workflowId ?? target;
    const limit = Number(opts.limit ?? "20");
    progress(
      `Listing up to ${limit} executions for workflow ${workflowId}...`,
      quiet,
    );
    const page = await client.listExecutions({
      workflowId,
      status: opts.status,
      limit,
    });
    progress(`Searching ${page.data.length} executions...`, quiet);

    let index = 0;
    const concurrency = 5;
    const ids = page.data.map((e: any) => String(e.id));
    async function worker(): Promise<void> {
      while (index < ids.length && allMatches.length < searchOpts.maxMatches) {
        const id = ids[index++];
        const r = await searchOneExecution(
          client,
          instance.host,
          instance.baseUrl,
          id,
          value,
          searchOpts,
          cacheOpts,
        );
        allMatches.push(...r.matches);
        itemsSearched += r.itemsSearched;
        nodesSearched += r.nodesSearched;
        executionsSearched++;
        if (r.truncated) truncated = true;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ids.length) }, worker),
    );
  }

  const capped = allMatches.slice(0, searchOpts.maxMatches);
  if (allMatches.length > capped.length) truncated = true;

  const payload = {
    query: { value, mode, caseSensitive: searchOpts.caseSensitive },
    scope:
      kind === "execution"
        ? {
            type: "execution",
            executionId: parsed?.executionId ?? target,
          }
        : { type: "workflow", workflowId: parsed?.workflowId ?? target },
    matches: capped,
    summary: {
      matchCount: capped.length,
      executionsSearched,
      nodesSearched,
      itemsSearched,
      truncated,
    },
  };

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(payload, null, 2) + "\n");
    progress(`Wrote results to ${opts.out}`, quiet);
  } else {
    emitJson(payload);
  }

  return capped.length > 0 ? 0 : 1;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/commands-search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/search.ts tests/commands-search.test.ts
git commit -m "feat: add search command for execution and workflow targets"
```

### Task 18: `get` command

**Files:**
- Create: `src/commands/get.ts`
- Test: `tests/commands-get.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/commands-get.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGet } from "../src/commands/get";

let home: string;

const execution = {
  id: 351694,
  workflowId: "WF",
  status: "success",
  mode: "trigger",
  finished: true,
  startedAt: "S",
  stoppedAt: "T",
  data: {
    resultData: {
      lastNodeExecuted: "HTTP Request",
      runData: {
        "HTTP Request": [
          { executionStatus: "success", data: { main: [[{ json: { order: { id: "500857721" } } }]] } },
        ],
      },
    },
  },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-get-"));
  process.env.N8N_LOCATE_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runGet returns 0 for an execution summary", async () => {
  const client = { getExecution: async () => execution };
  const code = await runGet(
    "https://h.co/workflow/WF/executions/351694",
    { json: true, quiet: true },
    () => client as any,
  );
  expect(code).toBe(0);
});

test("runGet returns 0 when drilling a node and path", async () => {
  const client = { getExecution: async () => execution };
  const code = await runGet(
    "351694",
    { json: true, quiet: true, node: "HTTP Request", path: "json.order.id" },
    () => client as any,
  );
  expect(code).toBe(0);
});

test("runGet throws when a path resolves to nothing", async () => {
  const client = { getExecution: async () => execution };
  await expect(
    runGet("351694", { json: true, quiet: true, node: "HTTP Request", path: "json.missing" }, () => client as any),
  ).rejects.toMatchObject({ code: "bad-arguments" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/commands-get.test.ts`
Expected: FAIL — cannot resolve `../src/commands/get`.

- [ ] **Step 3: Write `src/commands/get.ts`**

```ts
import { writeFileSync } from "node:fs";
import { CliError, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { parseN8nUrl } from "../url";
import { getExecutionCached } from "../exec-cache";
import {
  normalizeExecutionData,
  extractSearchUnits,
  extractNodeSummaries,
  extractExecutionInfo,
} from "../n8n-data";
import { parsePath, resolvePath } from "../paths";
import { emitJson, progress } from "../format";

export interface GetOpts {
  node?: string;
  path?: string;
  run?: string;
  output?: string;
  item?: string;
  refresh?: boolean;
  cache?: boolean;
  out?: string;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

function maybe(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

export async function runGet(
  target: string,
  opts: GetOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const parsed = parseN8nUrl(target);
  if (parsed && parsed.kind === "workflow") {
    throw new CliError(
      "bad-arguments",
      "Pass an execution URL or id, not a workflow URL.",
    );
  }
  const executionId = parsed?.executionId ?? target;
  const instance = resolveInstance({
    host: parsed?.host,
    baseUrl: parsed?.baseUrl,
  });
  const client = clientFactory(instance);
  const quiet = opts.quiet ?? false;

  progress(`Fetching execution ${executionId}...`, quiet);
  const raw = await getExecutionCached(client, instance.host, executionId, {
    refresh: opts.refresh ?? false,
    noCache: opts.cache === false,
  });
  const info = extractExecutionInfo(raw, instance.baseUrl);
  const data = normalizeExecutionData(raw);

  let payload: unknown;

  if (!opts.node) {
    const summaries = extractNodeSummaries(data);
    payload = {
      execution: info,
      nodes: summaries,
      summary: {
        nodeCount: summaries.length,
        lastNodeExecuted: data?.resultData?.lastNodeExecuted ?? null,
      },
    };
  } else {
    const runFilter = maybe(opts.run);
    const outputFilter = maybe(opts.output);
    const itemFilter = maybe(opts.item);
    const units = extractSearchUnits(data, opts.node).filter(
      (u) =>
        (runFilter === undefined || u.runIndex === runFilter) &&
        (outputFilter === undefined || u.outputIndex === outputFilter) &&
        (itemFilter === undefined || u.itemIndex === itemFilter),
    );
    if (units.length === 0) {
      throw new CliError(
        "bad-arguments",
        `Node "${opts.node}" produced no matching items in execution ${executionId}.`,
      );
    }

    const pathSegments = opts.path ? parsePath(opts.path) : null;
    const items = units.map((u) => {
      let value: unknown = u.json;
      if (pathSegments) {
        const resolved = resolvePath(u.json, pathSegments);
        value = resolved.found ? resolved.value : undefined;
      }
      return {
        runIndex: u.runIndex,
        outputIndex: u.outputIndex,
        itemIndex: u.itemIndex,
        value,
      };
    });

    if (pathSegments && items.every((i) => i.value === undefined)) {
      throw new CliError(
        "bad-arguments",
        `Path "${opts.path}" resolved to nothing in node "${opts.node}".`,
      );
    }

    payload = { execution: info, node: opts.node, items };
  }

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(payload, null, 2) + "\n");
    progress(`Wrote output to ${opts.out}`, quiet);
  } else {
    emitJson(payload);
  }
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/commands-get.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/commands/get.ts tests/commands-get.test.ts
git commit -m "feat: add get command"
```

---

## Phase 5 — CLI wiring and docs

### Task 19: CLI entry point (`cli.ts`)

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write the failing test** in `tests/cli.test.ts`

This test runs the built CLI as a subprocess and checks `--help` and the JSON
error envelope for a missing-credentials case.

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-cli-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, N8N_LOCATE_HOME: home, N8N_API_KEY: "", N8N_BASE_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test("--help lists all six commands", async () => {
  const { stdout, exitCode } = await run(["--help"]);
  expect(exitCode).toBe(0);
  for (const cmd of ["login", "sync", "workflows", "executions", "search", "get"]) {
    expect(stdout).toContain(cmd);
  }
});

test("a missing-credentials error exits 2 with a JSON envelope", async () => {
  const { stdout, exitCode } = await run(["workflows", "--json", "--no-sync"]);
  expect(exitCode).toBe(2);
  const parsed = JSON.parse(stdout);
  expect(parsed.error.code).toBe("no-credentials");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/cli.test.ts`
Expected: FAIL — `src/cli.ts` does not exist.

- [ ] **Step 3: Write `src/cli.ts`**

```ts
#!/usr/bin/env bun
import { Command } from "commander";
import { emitError, resolveOutputMode, toCliError } from "./format";
import { runLogin } from "./commands/login";
import { runSync } from "./commands/sync";
import { runWorkflows } from "./commands/workflows";
import { runExecutions } from "./commands/executions";
import { runSearch } from "./commands/search";
import { runGet } from "./commands/get";

async function execute(
  opts: { json?: boolean; text?: boolean },
  fn: () => Promise<number>,
): Promise<never> {
  try {
    const code = await fn();
    process.exit(code);
  } catch (err) {
    const cliErr = toCliError(err);
    emitError(cliErr, resolveOutputMode(opts));
    process.exit(2);
  }
}

const program = new Command();

program
  .name("n8n-locate")
  .description("Locate n8n workflows and execution data via the n8n public API")
  .version("0.1.0")
  .option("--json", "force JSON output")
  .option("--text", "force human-readable output")
  .option("--instance <host>", "n8n instance host to target")
  .option("--quiet", "suppress progress messages");

program
  .command("login")
  .description("Save an n8n instance's API key to the global config")
  .requiredOption("--url <base-url>", "n8n instance base URL")
  .option("--key <api-key>", "API key (prompts if omitted)")
  .option("--default", "make this the default instance")
  .action(async (_options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runLogin(opts));
  });

program
  .command("sync")
  .description("Rebuild the workflow catalog for the instance")
  .action(async (_options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runSync(opts));
  });

program
  .command("workflows")
  .description("Search workflows by id, name, webhook, or tag")
  .argument("[query]", "case-insensitive substring to match")
  .option("--field <field>", "restrict to one field: id | name | webhook | tag")
  .option("--active", "only active workflows")
  .option("--limit <n>", "max results", "50")
  .option("--offset <n>", "result offset", "0")
  .option("--refresh", "sync the catalog before searching")
  .option("--no-sync", "do not auto-sync when the catalog is missing")
  .action(async (query, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runWorkflows(query, opts));
  });

program
  .command("executions")
  .description("List a workflow's executions")
  .argument("<workflow>", "workflow URL or id")
  .option("--status <status>", "filter: success | error | waiting")
  .option("--limit <n>", "page size", "20")
  .option("--cursor <cursor>", "pagination cursor")
  .option("--all", "auto-paginate up to 1000 executions")
  .action(async (workflow, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runExecutions(workflow, opts));
  });

program
  .command("search")
  .description("Locate a value inside execution data")
  .argument("<value>", "value to locate")
  .argument("<target>", "execution or workflow URL/id")
  .option("--node <name>", "restrict to one node")
  .option("--exact", "match a whole string value")
  .option("--regex", "treat value as a regular expression")
  .option("--case-sensitive", "case-sensitive matching")
  .option("--limit <n>", "workflow target: executions to search", "20")
  .option("--status <status>", "workflow target: execution status filter")
  .option("--max-matches <n>", "stop after this many matches", "100")
  .option("--context", "include each match's parent object")
  .option("--truncate <n>", "max characters per matched value", "200")
  .option("--no-truncate", "do not truncate matched values")
  .option("--refresh", "re-fetch executions, bypassing the cache")
  .option("--no-cache", "do not read or write the execution cache")
  .option("--out <file>", "write JSON results to a file")
  .action(async (value, target, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runSearch(value, target, opts));
  });

program
  .command("get")
  .description("Inspect an execution or drill into a node/path")
  .argument("<execution>", "execution URL or id")
  .option("--node <name>", "show one node's items")
  .option("--path <path>", "resolve a JSON path (e.g. json.order.id)")
  .option("--run <n>", "narrow to a run index")
  .option("--output <n>", "narrow to an output branch index")
  .option("--item <n>", "narrow to an item index")
  .option("--refresh", "re-fetch the execution, bypassing the cache")
  .option("--no-cache", "do not read or write the execution cache")
  .option("--out <file>", "write JSON output to a file")
  .action(async (execution, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runGet(execution, opts));
  });

program.parseAsync().catch((err) => {
  const cliErr = toCliError(err);
  emitError(cliErr, resolveOutputMode(program.opts()));
  process.exit(2);
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/cli.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: wire up commander CLI entry point"
```

### Task 20: README and manual verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
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
```

- [ ] **Step 2: Manual verification against a live instance**

With valid credentials in the environment, confirm each command works:

```bash
N8N_API_KEY=<key> N8N_BASE_URL=https://n8n.example.com bun src/cli.ts sync --json
N8N_API_KEY=<key> N8N_BASE_URL=https://n8n.example.com bun src/cli.ts workflows --json
N8N_API_KEY=<key> bun src/cli.ts search "1671490087" \
  "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694" --json
N8N_API_KEY=<key> bun src/cli.ts get \
  "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694" --json
```

Expected: `sync` reports a `workflowCount`; `workflows` returns rows; `search`
finds `1671490087` (it is in execution 351694's input) and exits `0`; `get`
prints a node summary including 20 nodes.

- [ ] **Step 3: Run the full suite a final time**

Run: `bun test && bun run typecheck`
Expected: all tests pass; no type errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## Self-Review Notes

- **Spec coverage:** `login` → Task 13; `sync` + catalog → Tasks 10, 14;
  `workflows` catalog search by id/name/webhook/tag → Tasks 10, 15;
  `executions` → Task 16; `search` (execution + workflow targets, modes,
  truncation, `--out`) → Tasks 5, 17; `get` (summary + node/path drill) →
  Tasks 4, 18; execution cache → Task 11; URL parsing → Task 3; config +
  multi-instance + env override → Task 8; client + 429 retry → Task 9;
  stdout/stderr discipline + exit codes + JSON error envelope → Tasks 12, 19;
  webhook extraction → Task 7; data normalization → Task 6.
- **Output-size flags:** `--max-matches`, `--truncate`/`--no-truncate`,
  `--context`, `--out` are implemented in Task 17 (`search`) and `--out` in
  Task 18 (`get`).
- **Decoupling for Raycast:** pure/I-O modules (Tasks 3–12) never call
  `process.exit` or write to the console; only `commands/*` and `cli.ts` do.
- **Type consistency:** `SearchOptions`, `SearchUnit`, `Match`, `WorkflowRow`,
  `CatalogManifest`, `ResolvedInstance`, and `CliError` are defined once
  (Tasks 2, 5) and reused with identical shapes by every consumer.
