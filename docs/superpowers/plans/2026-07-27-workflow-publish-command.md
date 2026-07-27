# Workflow Publish Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an idempotent, `--yes`-gated `n8n-helper publish <workflow>` command that activates an inactive workflow through n8n's public API.

**Architecture:** Add one public-API wrapper to `N8nClient`, then keep command orchestration in a focused `src/commands/publish.ts` module. The command resolves the same workflow references as existing commands, fetches current state before writing, previews by default, and treats an already-active workflow as a successful no-op.

**Tech Stack:** TypeScript, Bun, `bun:test`, Commander 14, n8n Public API v1.

## Global Constraints

- `push` remains unchanged and continues to update already-published workflows.
- Publishing uses `POST /api/v1/workflows/{id}/activate` with API-key authentication.
- No browser session is required.
- No activation request occurs without `--yes`.
- An already-active workflow is a successful no-op.
- Preserve all unrelated existing worktree changes; selectively stage only publish-command hunks.

---

### Task 1: Public API publish method

**Files:**
- Modify: `tests/client.test.ts`
- Modify: `src/client.ts`

**Interfaces:**
- Consumes: `N8nClient.request<T>(path, opts)` and `WorkflowDefinition`.
- Produces: `N8nClient.publishWorkflow(id: string): Promise<WorkflowDefinition>`.

- [ ] **Step 1: Write the failing client boundary test**

Add this test to `tests/client.test.ts`. The production break it catches is using the wrong route, method, authentication mode, or return body.

```ts
test("publishWorkflow POSTs to the public workflow activation endpoint", async () => {
  let seenUrl = "";
  let seenMethod = "";
  let seenHeaders: Record<string, string> = {};
  const client = clientWith(async (url, init) => {
    seenUrl = String(url);
    seenMethod = init?.method ?? "GET";
    seenHeaders = init?.headers as Record<string, string>;
    return jsonResponse({
      id: "W 1",
      name: "New Tool",
      active: true,
      nodes: [],
      connections: {},
    });
  });

  const result = await client.publishWorkflow("W 1");

  expect(seenUrl).toBe("https://h.co/api/v1/workflows/W%201/activate");
  expect(seenMethod).toBe("POST");
  expect(seenHeaders["X-N8N-API-KEY"]).toBe("K");
  expect(seenHeaders.Cookie).toBeUndefined();
  expect(result.active).toBe(true);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test tests/client.test.ts
```

Expected: FAIL because `N8nClient.publishWorkflow` does not exist.

- [ ] **Step 3: Add the minimal client method**

Add beside the other workflow methods in `src/client.ts`:

```ts
publishWorkflow(id: string): Promise<WorkflowDefinition> {
  return this.request<WorkflowDefinition>(
    `/workflows/${encodeURIComponent(id)}/activate`,
    { method: "POST" },
  );
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bun test tests/client.test.ts
```

Expected: all client tests pass.

- [ ] **Step 5: Selectively commit the client contract**

Use interactive staging because both files contain pre-existing unrelated changes:

```bash
git add -p src/client.ts tests/client.test.ts
git diff --cached --check
git diff --cached --name-status
git commit -m "feat: add workflow publish API method"
```

Stage only the `publishWorkflow` method and its test.

### Task 2: Publish command behavior

**Files:**
- Create: `tests/commands-publish.test.ts`
- Create: `src/commands/publish.ts`

**Interfaces:**
- Consumes: `resolveInstance`, `parseN8nUrl`, `resolveWorkflowRef`, `N8nClient.getWorkflow`, and `N8nClient.publishWorkflow`.
- Produces: `PublishOpts` and `runPublish(ref, opts, clientFactory?): Promise<number>`.

- [ ] **Step 1: Write failing command behavior tests**

Create `tests/commands-publish.test.ts` with complete workflow fixtures and a client fake. The tests must assert emitted command behavior, while the fake records only the external API boundary:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPublish } from "../src/commands/publish";
import type { WorkflowDefinition } from "../src/types";

let home: string;

function workflow(active: boolean): WorkflowDefinition {
  return {
    id: "W1",
    name: "New Tool",
    active,
    nodes: [],
    connections: {},
    settings: {},
  } as WorkflowDefinition;
}

async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string }> {
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function clientStub(active: boolean) {
  const published: string[] = [];
  const client = {
    getWorkflow: async () => workflow(active),
    publishWorkflow: async (id: string) => {
      published.push(id);
      return workflow(true);
    },
  };
  return { client, published };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-publish-home-"));
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_API_KEY = "K";
  process.env.N8N_BASE_URL = "https://h.co";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_BASE_URL;
});

test("runPublish previews an inactive workflow without publishing", async () => {
  const { client, published } = clientStub(false);
  const { result, stdout } = await captureStdout(() =>
    runPublish("https://h.co/workflow/W1", {}, () => client as never),
  );

  expect(result).toBe(0);
  expect(published).toEqual([]);
  expect(JSON.parse(stdout)).toMatchObject({
    published: false,
    alreadyPublished: false,
    wasActive: false,
    active: false,
  });
  expect(JSON.parse(stdout).hint).toContain("--yes");
});

test("runPublish --yes publishes an inactive workflow", async () => {
  const { client, published } = clientStub(false);
  const { result, stdout } = await captureStdout(() =>
    runPublish(
      "https://h.co/workflow/W1",
      { yes: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(published).toEqual(["W1"]);
  expect(JSON.parse(stdout)).toMatchObject({
    published: true,
    alreadyPublished: false,
    wasActive: false,
    active: true,
    workflow: {
      id: "W1",
      name: "New Tool",
      url: "https://h.co/workflow/W1",
    },
  });
});

test("runPublish is a successful no-op when the workflow is active", async () => {
  const { client, published } = clientStub(true);
  const { result, stdout } = await captureStdout(() =>
    runPublish(
      "https://h.co/workflow/W1",
      { yes: true },
      () => client as never,
    ),
  );

  expect(result).toBe(0);
  expect(published).toEqual([]);
  expect(JSON.parse(stdout)).toMatchObject({
    published: false,
    alreadyPublished: true,
    wasActive: true,
    active: true,
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
bun test tests/commands-publish.test.ts
```

Expected: FAIL because `src/commands/publish.ts` does not exist.

- [ ] **Step 3: Implement the focused command runner**

Create `src/commands/publish.ts`:

```ts
import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { resolveWorkflowRef } from "../name-resolve";
import { parseN8nUrl } from "../url";
import type { ResolvedInstance } from "../types";

export interface PublishOpts {
  yes?: boolean;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

function workflowUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/workflow/${encodeURIComponent(id)}`;
}

export async function runPublish(
  ref: string,
  opts: PublishOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);
  try {
    const parsed = parseN8nUrl(ref);
    const instance = resolveInstance({
      host: opts.instance ?? parsed?.host,
      baseUrl: parsed?.baseUrl,
    });
    const client = clientFactory(instance);
    const resolved = await resolveWorkflowRef(ref, {
      host: instance.host,
      client,
    });
    const workflow = await client.getWorkflow(resolved.id);
    const id = String(workflow.id ?? resolved.id);
    const basePayload = {
      instance: instance.host,
      workflow: {
        id,
        name: workflow.name,
        url: workflowUrl(instance.baseUrl, id),
      },
    };

    if (workflow.active) {
      emitJson({
        ...basePayload,
        published: false,
        alreadyPublished: true,
        wasActive: true,
        active: true,
      });
      return 0;
    }

    if (!opts.yes) {
      emitJson({
        ...basePayload,
        published: false,
        alreadyPublished: false,
        wasActive: false,
        active: false,
        hint: "Preview only — nothing was published. Re-run with --yes to publish the workflow.",
      });
      return 0;
    }

    const published = await client.publishWorkflow(id);
    emitJson({
      ...basePayload,
      published: true,
      alreadyPublished: false,
      wasActive: false,
      active: published.active ?? true,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}
```

- [ ] **Step 4: Run the focused command tests and verify GREEN**

Run:

```bash
bun test tests/commands-publish.test.ts
```

Expected: all three publish-command tests pass.

- [ ] **Step 5: Commit the command runner**

```bash
git add src/commands/publish.ts tests/commands-publish.test.ts
git diff --cached --check
git diff --cached --name-status
git commit -m "feat: add workflow publish command"
```

### Task 3: CLI registration and operator documentation

**Files:**
- Modify: `tests/cli.test.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `skills/n8n-helper/SKILL.md`

**Interfaces:**
- Consumes: `runPublish(ref, opts): Promise<number>`.
- Produces: `n8n-helper publish <workflow> [--yes]`.

- [ ] **Step 1: Extend the failing CLI help test**

In `tests/cli.test.ts`, add `"publish"` to the existing command-list assertion:

```ts
for (const cmd of ["executions", "get", "retry", "stop", "publish"]) {
  expect(stdout).toContain(cmd);
}
```

Add a behavior-oriented help test that catches accidental removal of the write gate:

```ts
test("publish help exposes the explicit write gate", async () => {
  const { stdout, exitCode } = await run(["publish", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("<workflow>");
  expect(stdout).toContain("--yes");
});
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run:

```bash
bun test tests/cli.test.ts
```

Expected: FAIL because `publish` is not registered.

- [ ] **Step 3: Register the command**

Import `runPublish` in `src/cli.ts`, then register:

```ts
program
  .command("publish")
  .description("Publish an inactive workflow on n8n")
  .argument("<workflow>", "exact workflow name, id, or URL")
  .option("--yes", "publish the workflow (required to write; otherwise a preview no-op)")
  .action(async (workflow, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runPublish(workflow, opts));
  });
```

- [ ] **Step 4: Run CLI and command tests and verify GREEN**

Run:

```bash
bun test tests/cli.test.ts tests/commands-publish.test.ts
```

Expected: both test files pass.

- [ ] **Step 5: Document the operator workflow**

Add a `publish <workflow>` row to both command tables. In `README.md`, add:

```bash
# Publish the newly created inactive workflow (preview, then apply)
n8n-helper publish "New Tool"
n8n-helper publish "New Tool" --yes
```

Keep `skills/n8n-helper/SKILL.md` compact: one table row and one short
create/publish example only. Do not duplicate endpoint internals into the skill.

- [ ] **Step 6: Selectively commit CLI and docs**

Use interactive staging because all four files contain pre-existing unrelated changes:

```bash
git add -p src/cli.ts tests/cli.test.ts README.md skills/n8n-helper/SKILL.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: expose workflow publish command"
```

Stage only publish-command hunks.

### Task 4: Full verification

**Files:**
- Verify only; no planned edits.

**Interfaces:**
- Consumes: all publish-command interfaces from Tasks 1–3.
- Produces: fresh evidence that the feature and existing suite pass.

- [ ] **Step 1: Run focused verification**

```bash
bun test tests/client.test.ts tests/commands-publish.test.ts tests/cli.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run the complete test suite**

```bash
bun test
```

Expected: zero failures.

- [ ] **Step 3: Run the TypeScript check**

```bash
bun run typecheck
```

Expected: exit code 0.

- [ ] **Step 4: Verify worktree and commit scope**

```bash
git diff --check
git status --short
git log -4 --oneline
```

Confirm unrelated pre-existing stop/retry changes remain unstaged and uncommitted.
