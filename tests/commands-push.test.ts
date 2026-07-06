import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPush } from "../src/commands/push";
import type { ResolvedInstance, WorkflowDefinition, WorkflowNode } from "../src/types";

let home: string;
let workflowsDir: string;
let originalIsTTY: boolean | undefined;

function node(
  id: string,
  name: string,
  parameters: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    name,
    type: "n8n-nodes-base.set",
    typeVersion: 1,
    position: [0, 0],
    parameters,
  };
}

function workflow(
  nodes: WorkflowNode[],
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: "WF1",
    name: "Apply Agreement",
    active: true,
    tags: [{ id: "tag" }],
    versionId: "v1",
    triggerCount: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    nodes,
    connections: {},
    settings: { executionOrder: "v1" },
    ...overrides,
  };
}

function writeLocal(def: WorkflowDefinition): void {
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, "wf1.json"), `${JSON.stringify(def, null, 2)}\n`);
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await fn(), stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function setStdoutTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}

function clientFor(live: WorkflowDefinition) {
  const calls: Array<{ id: string; body: Partial<WorkflowDefinition> }> = [];
  const client = {
    getWorkflow: async (id: string) => {
      expect(id).toBe("WF1");
      return live;
    },
    updateWorkflow: async (id: string, body: Partial<WorkflowDefinition>) => {
      calls.push({ id, body });
      return { ...body, id } as WorkflowDefinition;
    },
  };
  return { client, calls };
}

function url(): string {
  return "https://h.co/workflow/WF1";
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-push-home-"));
  workflowsDir = join(home, "workflows");
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_API_KEY = "K";
  originalIsTTY = process.stdout.isTTY;
  setStdoutTty(false);
});

afterEach(() => {
  setStdoutTty(originalIsTTY);
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_API_KEY;
});

test("runPush default merge mode pushes only changed existing nodes", async () => {
  const liveA = node("a", "A", { value: "live-a" });
  const liveB = node("b", "B", { value: "live-b" });
  const localA = node("a", "A", { value: "live-a" });
  const localB = node("b", "B", { value: "local-b" });
  const live = workflow([liveA, liveB]);
  writeLocal(workflow([localA, localB]));
  const { client, calls } = clientFor(live);

  const { result: code, stdout } = await captureStdout(() =>
    runPush(url(), { dir: workflowsDir, yes: true, json: true, quiet: true }, () => client as any),
  );

  expect(code).toBe(0);
  expect(calls).toEqual([
    {
      id: "WF1",
      body: {
        name: "Apply Agreement",
        nodes: [liveA, localB],
        connections: live.connections,
        settings: live.settings,
      },
    },
  ]);
  expect(JSON.parse(stdout)).toMatchObject({
    instance: "h.co",
    workflow: {
      id: "WF1",
      name: "Apply Agreement",
      url: "https://h.co/workflow/WF1",
    },
    mode: "merge",
    pushed: true,
    nodesUpdated: ["B"],
    nodesExcluded: {
      addedNodes: [],
      removedNodes: [],
      connectionsChanged: false,
    },
    validation: { valid: true, errorCount: 0, warningCount: 0 },
  });
});

test("runPush node option restricts the merge to that node", async () => {
  const liveA = node("a", "A", { value: "live-a" });
  const liveB = node("b", "B", { value: "live-b" });
  const localA = node("a", "A", { value: "local-a" });
  const localB = node("b", "B", { value: "local-b" });
  const live = workflow([liveA, liveB]);
  writeLocal(workflow([localA, localB]));
  const { client, calls } = clientFor(live);

  const { result: code, stdout } = await captureStdout(() =>
    runPush(url(), { dir: workflowsDir, node: ["A"], yes: true, json: true, quiet: true }, () => client as any),
  );

  expect(code).toBe(0);
  expect(calls[0].body.nodes).toEqual([localA, liveB]);
  expect(JSON.parse(stdout).nodesUpdated).toEqual(["A"]);
});

test("runPush whole mode sends the stripped full local workflow", async () => {
  const live = workflow([node("a", "A", { value: "live-a" })]);
  const local = workflow(
    [node("a", "A", { value: "local-a" }), node("b", "B", { value: "local-b" })],
    {
      name: "Local Name",
      connections: { A: { main: [[{ node: "B", type: "main", index: 0 }]] } },
      settings: { saveDataSuccessExecution: "none" },
      staticData: { lastId: 1 },
      pinData: { A: [{ json: { id: 1 } }] },
    },
  );
  writeLocal(local);
  const { client, calls } = clientFor(live);

  const { result: code, stdout } = await captureStdout(() =>
    runPush(url(), { whole: true, dir: workflowsDir, yes: true, json: true, quiet: true }, () => client as any),
  );

  expect(code).toBe(0);
  expect(calls).toEqual([
    {
      id: "WF1",
      body: {
        name: "Local Name",
        nodes: local.nodes,
        connections: local.connections,
        settings: local.settings,
        staticData: { lastId: 1 },
      },
    },
  ]);
  expect(JSON.parse(stdout)).toMatchObject({
    mode: "whole",
    strippedFields: [
      "id",
      "active",
      "tags",
      "versionId",
      "triggerCount",
      "createdAt",
      "updatedAt",
      "pinData",
    ],
  });
});

test("runPush blocks validation hard errors unless force is set", async () => {
  const live = workflow([node("a", "A")]);
  const local = workflow([
    node("a", "A", { value: "={{ $('Missing').item.json.id }}" }),
  ]);
  writeLocal(local);
  const { client, calls } = clientFor(live);

  const blocked = await captureStdout(() =>
    runPush(url(), { dir: workflowsDir, yes: true, json: true, quiet: true }, () => client as any),
  );

  expect(blocked.result).toBe(1);
  expect(calls).toEqual([]);
  expect(JSON.parse(blocked.stdout)).toMatchObject({
    pushed: false,
    validation: { valid: false, errorCount: 1, warningCount: 0 },
  });

  const forced = await captureStdout(() =>
    runPush(url(), { dir: workflowsDir, yes: true, force: true, json: true, quiet: true }, () => client as any),
  );

  expect(forced.result).toBe(0);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(forced.stdout)).toMatchObject({
    pushed: true,
    validation: { valid: false, errorCount: 1, warningCount: 0 },
  });
});

test("runPush is a safe no-op in non-TTY mode without yes", async () => {
  const live = workflow([node("a", "A", { value: "live-a" })]);
  writeLocal(workflow([node("a", "A", { value: "local-a" })]));
  const { client, calls } = clientFor(live);

  const { result: code, stdout } = await captureStdout(() =>
    runPush(url(), { dir: workflowsDir, json: true, quiet: true }, () => client as any),
  );

  expect(code).toBe(0);
  expect(calls).toEqual([]);
  expect(JSON.parse(stdout)).toMatchObject({
    pushed: false,
    validation: { valid: true, errorCount: 0, warningCount: 0 },
    diff: { nodesModified: ["A"] },
  });
});

test("runPush reports excluded added removed and connection changes", async () => {
  const live = workflow(
    [node("a", "A", { value: "live-a" }), node("removed", "Removed")],
    {
      connections: { A: { main: [[{ node: "Removed", type: "main", index: 0 }]] } },
    },
  );
  const local = workflow(
    [node("a", "A", { value: "local-a" }), node("added", "Added")],
    {
      connections: { A: { main: [[{ node: "Added", type: "main", index: 0 }]] } },
    },
  );
  writeLocal(local);
  const { client } = clientFor(live);

  const { result: code, stdout } = await captureStdout(() =>
    runPush(url(), { dir: workflowsDir, yes: true, json: true, quiet: true }, (_instance: ResolvedInstance) => client as any),
  );

  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    nodesUpdated: ["A"],
    nodesExcluded: {
      addedNodes: ["Added"],
      removedNodes: ["Removed"],
      connectionsChanged: true,
    },
  });
});

test("runPush preview (no --yes) includes an agentic hint to apply with --yes", async () => {
  const live = workflow([node("a", "A", { value: "live" })]);
  writeLocal(workflow([node("a", "A", { value: "local" })]));
  const { client } = clientFor(live);
  const { stdout } = await captureStdout(() =>
    runPush(url(), { dir: workflowsDir, json: true, quiet: true }, () => client as any),
  );
  expect(JSON.parse(stdout).hint).toContain("--yes");
});

test("runPush validation-refused includes a hint mentioning --force", async () => {
  const live = workflow([node("a", "A")]);
  writeLocal(workflow([node("a", "A", { value: "={{ $('Missing').item.json.id }}" })]));
  const { client } = clientFor(live);
  const { stdout } = await captureStdout(() =>
    runPush(url(), { dir: workflowsDir, yes: true, json: true, quiet: true }, () => client as any),
  );
  const out = JSON.parse(stdout);
  expect(out.pushed).toBe(false);
  expect(out.hint).toContain("--force");
});
