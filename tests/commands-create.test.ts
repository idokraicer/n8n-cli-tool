import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCreate } from "../src/commands/create";
import type { WorkflowDefinition, WorkflowNode } from "../src/types";

let home: string;
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

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "LOCAL",
    name: "New Tool",
    active: false,
    nodes: [node("a", "A"), node("b", "B")],
    connections: { A: { main: [[{ node: "B", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1" },
    ...overrides,
  } as WorkflowDefinition;
}

function writeLocal(def: unknown): string {
  const file = join(home, "new-tool.json");
  writeFileSync(file, `${JSON.stringify(def, null, 2)}\n`);
  return file;
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

function clientStub() {
  const calls: Array<Partial<WorkflowDefinition>> = [];
  const client = {
    createWorkflow: async (body: Partial<WorkflowDefinition>) => {
      calls.push(body);
      return { ...body, id: "NEW1", active: false } as WorkflowDefinition;
    },
  };
  return { client, calls };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-create-home-"));
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_API_KEY = "K";
  process.env.N8N_BASE_URL = "https://h.co";
  originalIsTTY = process.stdout.isTTY;
  setStdoutTty(false);
});

afterEach(() => {
  setStdoutTty(originalIsTTY);
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_BASE_URL;
});

test("runCreate without --yes is a preview no-op", async () => {
  const file = writeLocal(workflow());
  const { client, calls } = clientStub();
  const { result, stdout } = await captureStdout(() =>
    runCreate(file, {}, () => client as never),
  );
  expect(result).toBe(0);
  expect(calls.length).toBe(0);
  const payload = JSON.parse(stdout);
  expect(payload.created).toBe(false);
  expect(payload.nodeCount).toBe(2);
  expect(payload.hint).toContain("--yes");
});

test("runCreate --yes creates and strips read-only fields", async () => {
  const file = writeLocal(
    workflow({
      // read-only/server-managed fields that must NOT reach the POST body
      tags: [{ id: "t1" }],
      versionId: "v9",
      triggerCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Partial<WorkflowDefinition>),
  );
  const { client, calls } = clientStub();
  const { result, stdout } = await captureStdout(() =>
    runCreate(file, { yes: true }, () => client as never),
  );
  expect(result).toBe(0);
  expect(calls.length).toBe(1);
  const body = calls[0];
  expect(Object.keys(body).sort()).toEqual(["connections", "name", "nodes", "settings"]);
  expect(body.name).toBe("New Tool");
  const payload = JSON.parse(stdout);
  expect(payload.created).toBe(true);
  expect(payload.workflow.id).toBe("NEW1");
  expect(payload.workflow.url).toBe("https://h.co/workflow/NEW1");
});

test("runCreate carries create-writable fields the public API v1 accepts", async () => {
  // A pulled/exported workflow can contain these; the public-API v1 create
  // schema marks them writable (not readOnly), so they must reach the POST body.
  const file = writeLocal(
    workflow({
      description: "My tool",
      nodeGroups: [{ nodes: ["A"], label: "Group" }],
      pinData: { A: [{ json: { id: 1 } }] },
      staticData: { lastId: 5 },
      // read-only/server-managed — must still be stripped
      tags: [{ id: "t1" }],
      versionId: "v9",
      active: true,
    } as Partial<WorkflowDefinition>),
  );
  const { client, calls } = clientStub();
  const { result, stdout } = await captureStdout(() =>
    runCreate(file, { yes: true }, () => client as never),
  );
  expect(result).toBe(0);
  const body = calls[0] as Record<string, unknown>;
  expect(body.description).toBe("My tool");
  expect(body.nodeGroups).toEqual([{ nodes: ["A"], label: "Group" }]);
  expect(body.pinData).toEqual({ A: [{ json: { id: 1 } }] });
  expect(body.staticData).toEqual({ lastId: 5 });
  // read-only fields never reach the POST body
  expect("tags" in body).toBe(false);
  expect("active" in body).toBe(false);
  expect("versionId" in body).toBe(false);
  // and they are not double-reported as "stripped" once re-added
  const payload = JSON.parse(stdout);
  expect(payload.strippedFields).not.toContain("pinData");
  expect(payload.strippedFields).toContain("tags");
});

test("runCreate --name overrides the file name", async () => {
  const file = writeLocal(workflow());
  const { client, calls } = clientStub();
  const { result } = await captureStdout(() =>
    runCreate(file, { yes: true, name: "Renamed Tool" }, () => client as never),
  );
  expect(result).toBe(0);
  expect(calls[0].name).toBe("Renamed Tool");
});

test("runCreate refuses on validation hard errors without --force", async () => {
  // expression referencing a node that doesn't exist = hard reference error
  const bad = workflow({
    nodes: [
      node("a", "A"),
      node("b", "B", { value: "={{ $('GHOST').first().json.x }}" }),
    ],
  });
  const file = writeLocal(bad);
  const { client, calls } = clientStub();
  const { result, stdout } = await captureStdout(() =>
    runCreate(file, { yes: true }, () => client as never),
  );
  expect(result).toBe(1);
  expect(calls.length).toBe(0);
  const payload = JSON.parse(stdout);
  expect(payload.created).toBe(false);
  expect(payload.validation.valid).toBe(false);

  // --force overrides
  const forced = await captureStdout(() =>
    runCreate(file, { yes: true, force: true }, () => client as never),
  );
  expect(forced.result).toBe(0);
  expect(calls.length).toBe(1);
});

test("runCreate errors on a missing file", async () => {
  const { client } = clientStub();
  const { result, stdout } = await captureStdout(() =>
    runCreate(join(home, "nope.json"), { yes: true }, () => client as never),
  );
  expect(result).toBe(2);
  expect(stdout).toContain("no-local-file");
});
