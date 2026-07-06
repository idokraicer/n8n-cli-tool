# n8n Workflow Write Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `n8n-helper` into an agent-driven match → `pull` → `edit` → `validate` → `push` → `run` loop over a repo of workflow JSON files, with every write to n8n gated behind a diff + `--yes`.

**Architecture:** Add five commands (`pull`, `edit`, `validate`, `push`, `run`) on the existing commander binary. All logic lives in CLI-pure helper modules (inputs in, values or typed `CliError` out — no `process.exit`, no console) so commands stay thin and modules stay unit-testable with a mocked client and temp dirs. Workflows are referenced by **exact n8n name** (resolved to an id via the existing catalog, else a live scan), and stored one-file-per-workflow under a name-based `./workflows` tree.

**Tech Stack:** Bun + TypeScript (runs `.ts` directly, no build), `commander@14`, `bun:test`, `node:fs`. Reuses existing `N8nClient`, `resolveInstance`, `SessionManager`, `emitJson`/`progress`/`CliError`, `parseN8nUrl`.

**Spec:** `docs/superpowers/specs/2026-07-05-n8n-workflow-write-loop-design.md`. Reuses `validate`/graph analysis from `docs/superpowers/specs/2026-05-17-n8n-edit-loop-design.md`.

## Global Constraints

- **Bun only.** Run tests with `bun test`, typecheck with `bunx tsc --noEmit`. Never `npm`/`npx`.
- **CLI-pure helpers.** Modules under `src/*.ts` (non-command) must not call `process.exit` or write to stdout/stderr; they return values or throw `CliError`.
- **Output contract.** stdout = machine result (`emitJson`), stderr = progress (`progress`). Exit `0` success, `1` normal-negative (invalid/refused), `2` operational error (envelope in JSON mode via `emitError`).
- **Writes to n8n are gated.** `push` and `pull`-overwrite require `--yes` in a non-TTY; interactive `y/N` in a TTY. `edit` mutates only local files (no gate).
- **Name is the key.** Every command accepts an exact workflow name, a bare id, or a workflow URL. Name collisions (local or live) → `bad-arguments` listing candidates.
- **Workflows root** defaults to `./workflows`, overridable via `--dir <path>` or `N8N_WORKFLOWS_DIR`.
- **Verified field paths:** Code body `parameters.jsCode` / `parameters.pythonCode`; agent system `parameters.options.systemMessage`; agent user `parameters.text`. Agent type `@n8n/n8n-nodes-langchain.agent`, code type `n8n-nodes-base.code`.

---

## File Structure

```
src/
  types.ts              (modify) add WorkflowDefinition, WorkflowNode, edit/merge/run/validate result types
  client.ts             (modify) generalize request(); add getWorkflow, updateWorkflow, runWorkflow, postWebhook
  name-resolve.ts       (new) exact-name/id/url → { id, name }; catalog then live; collision handling
  workflow-store.ts     (new) name-based local file resolution, read/write, --dir/--out, slugify
  workflow-data.ts      (new) parseWorkflow, findNode, connection graph, expression/reference extraction
  workflow-edit.ts      (new) pure setCode / setPrompt / replaceNode + dotpath helpers
  workflow-validate.ts  (new) reference integrity, diff, stale-$json, rename hints
  workflow-merge.ts     (new) computeChangedNodes, mergeNodes, stripForPut
  workflow-run.ts       (new) detectTrigger, buildInternalRunPayload, buildWebhookRequest, summarizeRun
  commands/
    pull.ts             (new)
    edit.ts             (new)
    validate.ts         (new)
    push.ts             (new)
    run.ts              (new)
  cli.ts                (modify) register the five commands
tests/
  client.test.ts                (modify) getWorkflow/updateWorkflow/runWorkflow/postWebhook
  name-resolve.test.ts          (new)
  workflow-store.test.ts        (new)
  workflow-data.test.ts         (new)
  workflow-edit.test.ts         (new)
  workflow-validate.test.ts     (new)
  workflow-merge.test.ts        (new)
  workflow-run.test.ts          (new)
  commands-pull.test.ts         (new)
  commands-edit.test.ts         (new)
  commands-validate.test.ts     (new)
  commands-push.test.ts         (new)
  commands-run.test.ts          (new)
```

---

## Shared Type Definitions (Task 1 defines; all later tasks consume)

```ts
// types.ts additions
export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface WorkflowDefinition {
  id?: string;
  name: string;
  active?: boolean;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  staticData?: unknown;
  pinData?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface EditResult {
  node: string;
  field: string;          // e.g. "parameters.jsCode"
  action: "set" | "replaced";
  beforeChars: number;
  afterChars: number;
}
export interface NodeReference {
  node: string;           // referencing node name
  expression: string;     // e.g. "$('Agent')" or "$json"
  referencedNode?: string;// undefined for $json
}
export interface MergePlan {
  merged: WorkflowDefinition;
  updated: string[];      // node names spliced into live
  excluded: { addedNodes: string[]; removedNodes: string[]; connectionsChanged: boolean };
}
export interface RunPlan {
  kind: "internal" | "webhook";
  triggerNode: string;
}
```

---

## Phase 1 — Foundations (Tasks 1–4)

### Task 1: Workflow types + client generalization

**Files:**
- Modify: `src/types.ts` (append the type block above)
- Modify: `src/client.ts` (generalize `request`, add methods)
- Test: `tests/client.test.ts`

**Interfaces:**
- Produces: `N8nClient.getWorkflow(id: string): Promise<WorkflowDefinition>`; `N8nClient.updateWorkflow(id: string, body: Partial<WorkflowDefinition>): Promise<WorkflowDefinition>`; `N8nClient.runWorkflow(id: string, payload: unknown, opts: { cookie: string }): Promise<{ status: number; body: unknown }>`; `N8nClient.postWebhook(url: string, body: unknown): Promise<{ status: number; body: unknown }>`. Types `WorkflowDefinition`, `WorkflowNode`, etc. from `types.ts`.
- Consumes: existing `request` retry/timeout behavior.

- [ ] **Step 1: Write failing tests** in `tests/client.test.ts` (append):

```ts
import { test, expect } from "bun:test";
import { N8nClient } from "../src/client";

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  return async (url: string, init?: RequestInit) => handler(url, init);
}

test("getWorkflow GETs /api/v1/workflows/:id and returns the body", async () => {
  let seenUrl = "";
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch((url) => { seenUrl = url; return new Response(JSON.stringify({ id: "W1", name: "Foo", nodes: [], connections: {} }), { status: 200 }); }),
  });
  const wf = await client.getWorkflow("W1");
  expect(seenUrl).toBe("https://n8n.test/api/v1/workflows/W1");
  expect(wf.name).toBe("Foo");
});

test("updateWorkflow PUTs the body with the api key header", async () => {
  let method = ""; let body = ""; let key = "";
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch((url, init) => { method = init!.method!; body = init!.body as string; key = (init!.headers as any)["X-N8N-API-KEY"]; return new Response(JSON.stringify({ id: "W1", name: "Foo", nodes: [], connections: {} }), { status: 200 }); }),
  });
  await client.updateWorkflow("W1", { name: "Foo", nodes: [], connections: {}, settings: {} });
  expect(method).toBe("PUT");
  expect(key).toBe("k");
  expect(JSON.parse(body).name).toBe("Foo");
});

test("runWorkflow POSTs to /rest/workflows/:id/run with the session cookie", async () => {
  let url = ""; let cookie = "";
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch((u, init) => { url = u; cookie = (init!.headers as any).Cookie; return new Response(JSON.stringify({ data: { executionId: "42" } }), { status: 200 }); }),
  });
  const res = await client.runWorkflow("W1", { workflowData: {} }, { cookie: "n8n-auth=abc" });
  expect(url).toBe("https://n8n.test/rest/workflows/W1/run");
  expect(cookie).toBe("n8n-auth=abc");
  expect(res.status).toBe(200);
});

test("postWebhook POSTs the given url and returns parsed body", async () => {
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  });
  const res = await client.postWebhook("https://n8n.test/webhook/abc", { a: 1 });
  expect(res.status).toBe(200);
  expect((res.body as any).ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/client.test.ts` → FAIL (methods undefined).
- [ ] **Step 3: Implement.** Refactor `request` to accept `(path, { query?, method?, body? })` (keep existing callers working — `getExecution`/`listExecutions`/`listWorkflows` pass `{ query }`). Add the four methods. `getWorkflow` → `request('/workflows/'+id, {})`. `updateWorkflow` → `request('/workflows/'+id, { method: 'PUT', body })`. `runWorkflow` mirrors `retryExecution` (POST `/rest/workflows/:id/run`, `Cookie` header, parse text→JSON, throw `CliError` on non-ok). `postWebhook` POSTs the absolute url with JSON body. Preserve 429 retry + timeout in `request`.
- [ ] **Step 4: Run tests** — `bun test tests/client.test.ts` → PASS. Then `bun test` (full suite) → still green.
- [ ] **Step 5: Typecheck + commit** — `bunx tsc --noEmit`; `git add src/types.ts src/client.ts tests/client.test.ts && git commit -m "feat: workflow types + client getWorkflow/updateWorkflow/runWorkflow/postWebhook"`.

### Task 2: `name-resolve.ts`

**Files:**
- Create: `src/name-resolve.ts`, `tests/name-resolve.test.ts`

**Interfaces:**
- Produces: `resolveWorkflowRef(ref: string, opts: { host: string; client: N8nClient }): Promise<{ id: string; name: string }>`.
- Consumes: `parseN8nUrl` (url.ts), `searchCatalog`/`catalogExists` (catalog.ts) with `{ query, field: "name", limit, offset }`, `N8nClient.listWorkflows`.

- [ ] **Step 1: Write failing tests** (`tests/name-resolve.test.ts`): (a) a workflow URL → its id + name via a mocked `getWorkflow`; (b) exact name present once in catalog → its id; (c) name absent from catalog, falls back to a live `listWorkflows` scan and matches exactly; (d) two catalog rows share the name → throws `CliError` code `bad-arguments` whose message lists both ids; (e) a ref that matches no name is treated as a bare id (returned as `{ id: ref }`, name fetched lazily or left as ref).

```ts
import { test, expect } from "bun:test";
import { resolveWorkflowRef } from "../src/name-resolve";
// Build a fake client with listWorkflows + getWorkflow; stub catalog via N8N_HELPER_HOME temp dir or a catalog seam.
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Order: if `parseN8nUrl(ref)?.kind === "workflow"` → `{ id: parsed.workflowId }` (name optional). Else search the catalog for exact name (case-sensitive equality against `row.name`); 1 match → its id+name; >1 → `CliError("bad-arguments", "Multiple workflows named '…': <id> (<url>), …")`. 0 matches and catalog exists → scan `listWorkflows` pages for exact name; 1 → id+name; >1 → collision error; 0 → treat `ref` as a bare id (`{ id: ref, name: ref }`). Keep catalog access injectable for tests (accept an optional `catalogSearch` param defaulting to the real `searchCatalog`).
- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat: resolve workflows by exact name, id, or url"`.

### Task 3: `workflow-store.ts`

**Files:**
- Create: `src/workflow-store.ts`, `tests/workflow-store.test.ts`

**Interfaces:**
- Produces: `resolveWorkflowsDir(opts: { dir?: string }): string` (opt → `N8N_WORKFLOWS_DIR` → `./workflows`); `findLocalFile(dir: string, name: string): string | null` (recursive; parsed `name` match, else `<slug>.json` stem match); `slugify(name: string): string`; `newFilePath(dir: string, name: string): string`; `readWorkflowFile(path: string): WorkflowDefinition` (throws `CliError("no-local-file", …)` when missing); `writeWorkflowFile(path: string, def: WorkflowDefinition): void` (pretty JSON + trailing newline, `mkdir -p`).
- Consumes: `WorkflowDefinition` (types.ts).

- [ ] **Step 1: Write failing tests** using a `mkdtempSync` temp dir: recursive find by parsed `name` in a nested `agents/foo.json`; stem fallback when the file doesn't parse to that name; two files parsing to the same name → `CliError("bad-arguments")`; `readWorkflowFile` missing → `no-local-file`; write then read round-trips and pretty-prints (2-space, trailing `\n`); `slugify("Apply Agreement")` → `"apply-agreement"`; `resolveWorkflowsDir` precedence (explicit > env > default).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Recursive walk with `readdirSync(dir, { withFileTypes: true })` skipping non-`.json`; for each, `try { JSON.parse }` and compare `.name`; collect matches; >1 → collision error; else stem match on `slugify`. `slugify` = lowercase, non-alnum → `-`, collapse/trim dashes.
- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat: name-based local workflow file store"`.

### Task 4: `workflow-data.ts` (parse + graph + references)

**Files:**
- Create: `src/workflow-data.ts`, `tests/workflow-data.test.ts`

**Interfaces:**
- Produces: `parseWorkflow(raw: unknown): WorkflowDefinition` (validates `name:string`, `nodes:array`, `connections:object`; else `CliError` — see spec parse rule); `findNode(def, name): WorkflowNode | undefined`; `buildGraph(def): { ancestors(node: string): Set<string>; mainPredecessors(node: string): Set<string> }`; `extractReferences(node: WorkflowNode): NodeReference[]`.
- Consumes: types.

- [ ] **Step 1: Write failing tests** per the 2026-05-17 spec test list: reference extraction across `$('X')`, `$node["X"]`, `$items('X')`, `$json` (word-boundary), nested `parameters`, ignoring non-`=` strings; `ancestors` over `main` + AI connection types; `mainPredecessors` direct-only; cycle safety (no infinite loop). Example:

```ts
test("extractReferences finds $() and $json in nested params", () => {
  const node = { id: "n", name: "B", type: "x", parameters: { a: "=A: {{ $('Agent').item.json.x }}", b: { c: "={{ $json.id }}" }, d: "plain" } };
  const refs = extractReferences(node as any).map(r => r.expression).sort();
  expect(refs).toContain("$('Agent')");
  expect(refs).toContain("$json");
  expect(refs).not.toContain("plain");
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per spec §"Reference & Graph Analysis": regexes for the reference forms over every string value beginning with `=`; connection graph from `connections[source][type][idx][] = {node,…}` reversed for ancestors (all types) and forward `main` for predecessors; BFS with a visited set.
- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat: workflow parse, connection graph, reference extraction"`.

---

## Phase 2 — `pull` (Task 5)

### Task 5: `commands/pull.ts` + wire into cli.ts

**Files:**
- Create: `src/commands/pull.ts`, `tests/commands-pull.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `runPull(ref: string, opts: PullOpts, clientFactory?): Promise<number>` where `PullOpts = { dir?, out?, yes?, instance?, json?, text?, quiet? }`.
- Consumes: `resolveInstance`, `resolveWorkflowRef`, `N8nClient.getWorkflow`, `workflow-store`, `workflow-data.parseWorkflow`.

- [ ] **Step 1: Write failing tests** (inject a `clientFactory` returning a stub client; use a temp `--dir`): (a) no local file → writes `<dir>/<slug>.json`, exit `0`, JSON `{ wrote:true, file, summary:{nodeCount,active,triggerNodes} }`; (b) existing identical file → `wrote:true`/no-op-equivalent, exit `0`; (c) existing **different** file, non-TTY, no `--yes` → `wrote:false`, exit `0`, `diff` present, file unchanged on disk; (d) same with `--yes` → overwrites, `wrote:true`; (e) resolve error surfaces exit `2`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Resolve instance + ref → id; `getWorkflow`; find existing local file (`findLocalFile`) else `newFilePath`/`--out`; compute a shallow diff vs existing (reuse `workflow-validate.diffWorkflows` once Task 7 exists — for Task 5 use a local `JSON.stringify` inequality + node-name add/remove summary; refactor to shared diff in Task 7); if existing differs and not `--yes` and not TTY-confirmed → report diff, `wrote:false`; else `writeWorkflowFile`. Emit JSON. Register the command in `cli.ts` mirroring existing `.action` wiring with `optsWithGlobals()`.
- [ ] **Step 4: Run tests → PASS**, plus `bun test` full suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat: pull command (live workflow -> local file, diff-gated)"`.

---

## Phase 3 — `edit` (Task 6)

### Task 6: `workflow-edit.ts` + `commands/edit.ts`

**Files:**
- Create: `src/workflow-edit.ts`, `tests/workflow-edit.test.ts`, `src/commands/edit.ts`, `tests/commands-edit.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `setCode(def, nodeName, code, lang: "js"|"python"): EditResult`; `setPrompt(def, nodeName, opts: { system?: string; user?: string; systemPath?: string; userPath?: string; literal?: boolean }): EditResult[]`; `replaceNode(def, nodeName, replacement: WorkflowNode): EditResult`. All mutate `def` in place and return the change record(s); unknown node → `CliError("bad-arguments", "Unknown node '…'. Available: …")`. `runEdit(ref, sub, opts, clientFactory?): Promise<number>`.
- Consumes: `findNode`, `readWorkflowFile`/`writeWorkflowFile`, `resolveWorkflowsDir`.

- [ ] **Step 1: Write failing unit tests** (`workflow-edit.test.ts`): `setCode` sets `parameters.jsCode` (js) / `parameters.pythonCode` (python); `setPrompt({system})` sets `parameters.options.systemMessage`, `setPrompt({user})` sets `parameters.text`, both at once returns two `EditResult`s; expression-prefix rule — when the existing value started with `=`, the new value keeps a single leading `=` (added if absent) unless `literal:true`; `--*-path` overrides the target field; `replaceNode` swaps the object, preserves existing `id`/`position` when the replacement omits them, throws on `name` mismatch; unknown node → `bad-arguments`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `workflow-edit.ts`** with a small `setByPath(obj, "options.systemMessage", value)` helper (dot path, creating intermediate objects). Apply the expression-prefix rule. Default paths: code→`parameters.jsCode`|`parameters.pythonCode`; system→`parameters.options.systemMessage`; user→`parameters.text`.
- [ ] **Step 4: Write failing command tests** (`commands-edit.test.ts`): `edit <name> set-code --node X --code-file f.js` writes the file and prints the `EditResult`; inline `--code` works; `--code` + `--code-file` together → exit `2` `bad-arguments`; neither → exit `2`; `set-prompt --node Agent --system-file s.md`; `replace-node --node X --file node.json`; no local file → exit `2` `no-local-file`.
- [ ] **Step 5: Implement `commands/edit.ts`** as a dispatcher over the three subcommands (commander sub-subcommands, or one `edit` command with a `<op>` argument + option validation). Read the value from `--x` or `--x-file` (`readFileSync`), enforce exactly-one. Register in `cli.ts`.
- [ ] **Step 6: Run tests → PASS** (`bun test tests/workflow-edit.test.ts tests/commands-edit.test.ts`), full suite green, `bunx tsc --noEmit`.
- [ ] **Step 7: Commit** — `git commit -m "feat: edit command (set-code, set-prompt, replace-node)"`.

---

## Phase 4 — `validate` (Task 7)

### Task 7: `workflow-validate.ts` + `commands/validate.ts`

**Files:**
- Create: `src/workflow-validate.ts`, `tests/workflow-validate.test.ts`, `src/commands/validate.ts`, `tests/commands-validate.test.ts`
- Modify: `src/cli.ts`; refactor `pull.ts` to use the shared `diffWorkflows`.

**Interfaces:**
- Produces: `diffWorkflows(local, remote): WorkflowDiff`; `validateWorkflow(local, remote | null): ValidationResult`. Types `WorkflowDiff`, `ValidationResult`, `ValidationError`, `ValidationWarning` added to `types.ts` per the 2026-05-17 spec §validate JSON shape. `runValidate(ref, opts, clientFactory?): Promise<number>`.
- Consumes: `workflow-data` (graph, references), `resolveWorkflowRef`, `getWorkflow`.

- [ ] **Step 1: Write failing unit tests** per 2026-05-17 spec: `non-existent` reference (hard error); `not-upstream` reference on a disconnected branch (hard error); a valid upstream reference passes; stale-`$json` warning when a node is inserted between two nodes; rename hint via stable `id`; `diffWorkflows` add/remove/modify/rename; parse failure → `valid:false` with a `parse` error; `--local` omits remote-only output.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per spec §"Reference & Graph Analysis" and §"Diff Semantics".
- [ ] **Step 4: Write + pass command tests** (`commands-validate.test.ts`): exit `0` valid, `1` invalid, `2` operational (no local file); `--local` path. Register in `cli.ts`. Refactor `pull.ts` to import `diffWorkflows`.
- [ ] **Step 5: Run full suite green, typecheck.**
- [ ] **Step 6: Commit** — `git commit -m "feat: validate command (reference integrity, diff, stale-json)"`.

---

## Phase 5 — `push` (Task 8)

### Task 8: `workflow-merge.ts` + `commands/push.ts`

**Files:**
- Create: `src/workflow-merge.ts`, `tests/workflow-merge.test.ts`, `src/commands/push.ts`, `tests/commands-push.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `computeChangedNodes(local, live): string[]`; `mergeNodes(live, local, nodeNames: string[] | null): MergePlan`; `stripForPut(def): { body: Partial<WorkflowDefinition>; strippedFields: string[] }`. `runPush(ref, opts, clientFactory?): Promise<number>` where `PushOpts = { whole?, node?: string[], yes?, force?, dir?, instance?, json?, text?, quiet? }`.
- Consumes: `getWorkflow`, `updateWorkflow`, `validateWorkflow`, `diffWorkflows`, store.

- [ ] **Step 1: Write failing unit tests** (`workflow-merge.test.ts`): `computeChangedNodes` returns names whose object deep-differs between local and live; `mergeNodes(live, local, ["A"])` splices only node `A` into live, leaving others; `nodeNames=null` uses all changed nodes; added/removed local nodes and connection changes appear in `excluded`, not in `merged`; `stripForPut` keeps `name/nodes/connections/settings` (+`staticData` when present), defaults missing `settings` to `{}`, and lists stripped read-only fields (`id,active,tags,versionId,triggerCount,createdAt,updatedAt,pinData`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement `workflow-merge.ts`.** Deep-equal via stable `JSON.stringify` with sorted keys, or a small `deepEqual`. Merge by node `name`.
- [ ] **Step 4: Write failing command tests** (`commands-push.test.ts`): merge mode default pushes only changed nodes (assert PUT body via stub); `--node A` restricts to A; `--whole` PUTs the stripped full file; validate hard errors refuse (exit `1`) unless `--force`; non-TTY without `--yes` → `wrote/pushed:false` diff-only, exit `0` (safe no-op); `--yes` applies, `pushed:true`; excluded changes reported. JSON envelope matches spec.
- [ ] **Step 5: Implement `commands/push.ts`.** Load local; resolve id; `getWorkflow` live; build merged def (merge or whole+strip); run `validateWorkflow(merged, live)`; if hard errors and not `--force` → exit `1`; compute `diffWorkflows(merged, live)`; if not `--yes` (and not TTY-confirmed) → emit diff, `pushed:false`, exit `0`; else `updateWorkflow(id, stripForPut(merged).body)`, `pushed:true`. Register in `cli.ts`.
- [ ] **Step 6: Run full suite green, typecheck.**
- [ ] **Step 7: Commit** — `git commit -m "feat: push command (merge/whole, validate-gated, --yes)"`.

---

## Phase 6 — `run` (Task 9, verification-gated)

> **⚠ Verify before implementing the internal path.** The exact `POST /rest/workflows/:id/run` payload for a **manual sub-workflow execution with pinned trigger data** is NOT assumed. Before Step 3b, capture a real manual-run request from the n8n editor (browser network tab on `n8n.example.com`) or probe the endpoint, and record the confirmed payload shape in the spec's Open Assumptions. The **webhook path (Step 3a) ships first** and is independently green; the internal path lands only once its shape is confirmed. If it can't be confirmed, `run` ships webhook-only and the internal path is deferred to a follow-up.

### Task 9: `workflow-run.ts` + `commands/run.ts`

**Files:**
- Create: `src/workflow-run.ts`, `tests/workflow-run.test.ts`, `src/commands/run.ts`, `tests/commands-run.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `detectTrigger(def, override?: string): RunPlan` (webhook if a `n8n-nodes-base.webhook` node exists and no override forces otherwise; internal for `n8n-nodes-base.executeWorkflowTrigger`; `--node` override selects by name); `buildWebhookRequest(baseUrl, def, triggerNode, data): { url: string; body: unknown }`; `buildInternalRunPayload(def, triggerNode, data): unknown` (shape per the verified request); `summarizeRun(response): { executionId?: string; status?: string }`. `runRun(ref, opts, clientFactory?): Promise<number>`.
- Consumes: `getWorkflow`, `SessionManager.getCookie`, `runWorkflow`, `postWebhook`, `getExecution` (for `--poll`).

- [ ] **Step 1: Write failing unit tests** (`workflow-run.test.ts`): `detectTrigger` returns `webhook` for a webhook workflow, `internal` for an executeWorkflowTrigger workflow, honors `--node`; `buildWebhookRequest` builds `<baseUrl>/webhook/<path>` with the sample body; `summarizeRun` extracts `executionId`/`status` from a sample response.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3a: Implement the webhook path** in `workflow-run.ts` + `commands/run.ts`: detect trigger; for webhook → `postWebhook`; read sample from `--data <file>` / `--data-inline <json>` / empty; emit `{ mode:"webhook", execution?, result }`. Register command. Tests green.
- [ ] **Step 3b: Implement the internal path** (after the verification gate): obtain the cookie via `SessionManager` (same as `retry`), `buildInternalRunPayload`, `runWorkflow`; with `--poll`, `getExecution` and summarize. Add its tests with a stubbed client.
- [ ] **Step 4: Run full suite green, typecheck.**
- [ ] **Step 5: Commit** — `git commit -m "feat: run command (webhook + internal /rest sample-data test-run)"`.

---

## Phase 7 — Docs (Task 10)

### Task 10: SKILL.md loop + README command reference

**Files:**
- Modify: `skills/n8n-helper/SKILL.md`, `README.md`

- [ ] **Step 1:** Document the match → `pull` → `edit` → `validate` → `push` → `run` loop in `SKILL.md`, emphasizing the approval discipline: **always show the diff and get user acceptance before `pull`-overwrite and before `push`; pass `--yes` only after the user approves.** Include the motivating example from the spec and the sidecar-file convention (`--code-file`, `--system-file`).
- [ ] **Step 2:** Add a command reference to `README.md` for `pull`/`edit`/`validate`/`push`/`run` with the exact flags and one example each, mirroring the existing README style.
- [ ] **Step 3:** `bun test` (docs change is inert) and `git commit -m "docs: document the workflow write loop in SKILL.md and README"`.

---

## Self-Review

**Spec coverage:**
- inject code / replace node / inject prompts → Task 6 (`set-code`/`replace-node`/`set-prompt`). ✅
- match local ↔ live by exact name → Tasks 2 (`name-resolve`) + 3 (`workflow-store`). ✅
- pull latest if accepted → Task 5 (diff + `--yes`). ✅
- edit → Task 6. ✅
- push whole or partial if accepted → Task 8 (merge/`--whole`, validate + `--yes`). ✅
- run sub-workflow with sample data → Task 9 (internal `/rest`, verification-gated) + webhook. ✅
- safety/validate → Task 7, reused by Task 8. ✅
- SKILL.md "agent understands the flow" → Task 10. ✅

**Type consistency:** `WorkflowDefinition`/`WorkflowNode`/`EditResult`/`MergePlan`/`RunPlan` defined in Task 1 and consumed with matching signatures downstream. `resolveWorkflowRef` (Task 2), `findLocalFile`/`readWorkflowFile`/`writeWorkflowFile` (Task 3), `diffWorkflows`/`validateWorkflow` (Task 7) referenced by later tasks with the same names/params. `pull` uses a local diff in Task 5, refactored to shared `diffWorkflows` in Task 7 (noted explicitly).

**Placeholder scan:** no TBD/TODO; each code step shows concrete tests or implementation direction with exact field paths and commands. The one deliberately-unresolved value (internal run payload) is fenced behind an explicit verification gate rather than a silent placeholder.
