# Execution Time Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-backed execution start-time filtering to `executions` and workflow-wide `search`.

**Architecture:** A focused time-window module validates and normalizes CLI values. `N8nClient` gains an internal `/rest/executions` request that sends the session cookie and browser ID, while a shared collector handles session acquisition, one refresh after 401, and `lastId` pagination. Both commands use that collector only when time options are present and otherwise retain the public API path.

**Tech Stack:** TypeScript, Bun, Commander, Bun test, n8n public and internal REST APIs.

## Global Constraints

- Time filters require an n8n browser session; never silently fall back to client-side public API filtering.
- Never print cookies, browser IDs, saved email addresses, or passwords.
- Preserve all existing behavior when no time option is supplied.
- Interpret unzoned absolute timestamps in the machine's local timezone.
- `--from` and `--to` are inclusive bounds; `--since` and `--from` are mutually exclusive.
- Time-filtered `search` is supported only for workflow targets.

---

### Task 1: Time-window parsing

**Files:**
- Create: `src/time-window.ts`
- Create: `tests/time-window.test.ts`

**Interfaces:**
- Produces: `TimeWindowOpts`, `TimeWindow`, `hasTimeWindow(opts)`, and `parseTimeWindow(opts, now?)`.
- `parseTimeWindow` returns normalized ISO strings or `undefined` when no filter exists.

- [ ] **Step 1: Write failing parser tests**

Cover `2h`, absolute timestamps, local timestamp parsing, default upper bound, conflicting options, invalid values, and reversed ranges in `tests/time-window.test.ts`.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/time-window.test.ts`

Expected: FAIL because `src/time-window.ts` does not exist.

- [ ] **Step 3: Implement the parser**

Create `src/time-window.ts` with these public types and functions:

```ts
export interface TimeWindowOpts {
  from?: string;
  to?: string;
  since?: string;
}

export interface TimeWindow {
  from: string;
  to: string;
}

export function hasTimeWindow(opts: TimeWindowOpts): boolean;
export function parseTimeWindow(
  opts: TimeWindowOpts,
  now?: Date,
): TimeWindow | undefined;
```

Durations must match `/^(\d+)(m|h|d|w)$/i`. Absolute values use `Date.parse`. Throw `CliError("bad-arguments", ...)` for invalid or conflicting inputs.

- [ ] **Step 4: Verify GREEN**

Run: `bun test tests/time-window.test.ts`

Expected: all parser tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/time-window.ts tests/time-window.test.ts
git commit -m "feat: parse execution time windows"
```

### Task 2: Internal execution listing and session collector

**Files:**
- Modify: `src/client.ts`
- Modify: `src/session.ts`
- Create: `src/execution-list.ts`
- Modify: `tests/client.test.ts`
- Modify: `tests/session.test.ts`
- Create: `tests/execution-list.test.ts`

**Interfaces:**
- `N8nClient.listExecutionsInternal(params, auth)` sends the REST request and returns `{ results, count, estimated }`.
- `SessionManager.hasSession()` reports whether a saved cookie or login credentials exist.
- `collectTimeFilteredExecutions(input)` returns normalized summary rows and total count.

- [ ] **Step 1: Write failing client request tests**

Assert that `listExecutionsInternal` calls `/rest/executions`, serializes `workflowId`, status, `startedAfter`, and `startedBefore` in `filter`, sends `limit` and optional `lastId`, and includes `Cookie` plus `browser-id` headers.

- [ ] **Step 2: Verify RED**

Run: `bun test tests/client.test.ts`

Expected: FAIL because `listExecutionsInternal` is absent.

- [ ] **Step 3: Implement the internal client method**

Add typed parameter and response interfaces in `src/client.ts`. Parse n8n's `{ data: { results, count, estimated } }` envelope. Map 401 to the existing `unauthorized` code without exposing auth values.

- [ ] **Step 4: Verify client GREEN**

Run: `bun test tests/client.test.ts`

Expected: all client tests pass.

- [ ] **Step 5: Write failing session and collector tests**

Cover:

- `hasSession()` with cookie, credentials, and API-key-only config.
- `no-session` error with the exact login setup hint.
- one cookie refresh after 401.
- `lastId` pagination and requested-result limiting.
- status and normalized time-filter forwarding.

- [ ] **Step 6: Verify collector RED**

Run: `bun test tests/session.test.ts tests/execution-list.test.ts`

Expected: FAIL because the new session predicate and collector are absent.

- [ ] **Step 7: Implement session-backed collection**

Create `collectTimeFilteredExecutions` in `src/execution-list.ts`. Obtain the cookie, require `getBrowserId()`, call `listExecutionsInternal`, refresh once on 401 when credentials exist, and advance with the last returned execution ID. Throw `CliError("no-session", ...)` with this hint:

```text
Run `n8n-helper login --url <baseUrl> --email <email>` to save an n8n browser session.
```

- [ ] **Step 8: Verify collector GREEN**

Run: `bun test tests/session.test.ts tests/execution-list.test.ts`

Expected: all session and collector tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/client.ts src/session.ts src/execution-list.ts tests/client.test.ts tests/session.test.ts tests/execution-list.test.ts
git commit -m "feat: list executions by time through n8n rest"
```

### Task 3: Wire `executions` and `search`

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/commands/executions.ts`
- Modify: `src/commands/search.ts`
- Modify: `tests/commands-executions.test.ts`
- Modify: `tests/commands-search.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Both option types extend `TimeWindowOpts`.
- Commands inject a session factory for isolated tests.
- JSON payloads add `timeWindow` only for filtered requests.

- [ ] **Step 1: Write failing command tests**

Assert that:

- `executions --since/--from/--to` uses the shared collector.
- `search` uses filtered candidate IDs for workflow targets.
- execution-targeted `search` rejects time options.
- normalized `timeWindow` appears in JSON output objects.
- no time options preserve `listExecutions` public API calls.

- [ ] **Step 2: Verify command RED**

Run: `bun test tests/commands-executions.test.ts tests/commands-search.test.ts tests/cli.test.ts`

Expected: FAIL because command options and wiring are absent.

- [ ] **Step 3: Implement CLI and command wiring**

Add these Commander options to both commands:

```ts
.option("--from <date-time>", "executions started at or after this date/time")
.option("--to <date-time>", "executions started at or before this date/time")
.option("--since <duration-or-date-time>", "executions since a duration such as 2h, or a date/time")
```

Parse before network access, use session-backed collection only when a window exists, and add the normalized window to output.

- [ ] **Step 4: Verify command GREEN**

Run: `bun test tests/commands-executions.test.ts tests/commands-search.test.ts tests/cli.test.ts`

Expected: all command tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/commands/executions.ts src/commands/search.ts tests/commands-executions.test.ts tests/commands-search.test.ts tests/cli.test.ts
git commit -m "feat: add execution time filters to cli commands"
```

### Task 4: Documentation and complete verification

**Files:**
- Modify: `README.md`
- Modify: `skills/n8n-helper/SKILL.md`

**Interfaces:**
- Documents exact flags, examples, session requirement, and remediation command.

- [ ] **Step 1: Update user and agent documentation**

Add examples for an explicit interval and relative `--since` search. Explain that time filters require browser-session login and that ordinary execution listing still uses the API key.

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test tests/time-window.test.ts tests/execution-list.test.ts tests/commands-executions.test.ts tests/commands-search.test.ts tests/client.test.ts tests/session.test.ts tests/cli.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run complete verification**

Run:

```bash
bun test
bun run typecheck
git diff --check
```

Expected: all tests pass, typecheck exits 0, and no whitespace errors are reported.

- [ ] **Step 4: Perform a safe live read-only smoke test**

Run a narrow historical `executions --from ... --to ... --limit 3` request against the configured instance. Verify all returned timestamps fall inside the normalized output window. Do not retry, edit, or run any workflow.

- [ ] **Step 5: Commit**

```bash
git add README.md skills/n8n-helper/SKILL.md
git commit -m "docs: explain execution time filters"
```
