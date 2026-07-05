import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPull } from "../src/commands/pull";
import type { WorkflowDefinition } from "../src/types";

let home: string;
let workflowsDir: string;
let originalIsTTY: boolean | undefined;
let originalWrite: typeof process.stdout.write;

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: "WF1",
    name: "Apply Agreement",
    active: true,
    nodes: [
      {
        id: "trigger",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        parameters: { path: "apply" },
      },
      {
        id: "set",
        name: "Set Data",
        type: "n8n-nodes-base.set",
        parameters: { value: "live" },
      },
    ],
    connections: {},
    ...overrides,
  };
}

function clientFor(fetched: WorkflowDefinition) {
  return {
    listWorkflows: async () => ({
      data: [
        {
          id: fetched.id,
          name: fetched.name,
          active: fetched.active,
          nodes: fetched.nodes,
        },
      ],
      nextCursor: null,
    }),
    getWorkflow: async (id: string) => {
      expect(id).toBe(String(fetched.id));
      return fetched;
    },
  };
}

function captureStdout(): () => string {
  let output = "";
  originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return () => output;
}

function setStdoutTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-pull-home-"));
  workflowsDir = mkdtempSync(join(tmpdir(), "n8n-helper-pull-workflows-"));
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_BASE_URL = "https://h.co";
  process.env.N8N_API_KEY = "K";
  originalIsTTY = process.stdout.isTTY;
  originalWrite = process.stdout.write;
});

afterEach(() => {
  process.stdout.write = originalWrite;
  setStdoutTty(originalIsTTY);
  rmSync(home, { recursive: true, force: true });
  rmSync(workflowsDir, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
});

test("runPull writes to the slug path when no local file exists", async () => {
  const fetched = workflow();
  const getOutput = captureStdout();

  const code = await runPull(
    fetched.name,
    { dir: workflowsDir, json: true, quiet: true },
    () => clientFor(fetched) as any,
  );

  const file = join(workflowsDir, "apply-agreement.json");
  expect(code).toBe(0);
  expect(readJson(file)).toEqual(fetched);
  expect(JSON.parse(getOutput())).toEqual({
    instance: "h.co",
    workflow: {
      id: "WF1",
      name: "Apply Agreement",
      url: "https://h.co/workflow/WF1",
    },
    file,
    wrote: true,
    summary: {
      nodeCount: 2,
      active: true,
      triggerNodes: ["Webhook"],
    },
  });
});

test("runPull reports wrote true and leaves matching existing content equivalent", async () => {
  const fetched = workflow();
  const file = join(workflowsDir, "apply-agreement.json");
  writeFileSync(file, `${JSON.stringify(fetched, null, 2)}\n`);
  const getOutput = captureStdout();

  const code = await runPull(
    fetched.name,
    { dir: workflowsDir, json: true, quiet: true },
    () => clientFor(fetched) as any,
  );

  expect(code).toBe(0);
  expect(readJson(file)).toEqual(fetched);
  expect(JSON.parse(getOutput())).toMatchObject({
    file,
    wrote: true,
    summary: { nodeCount: 2, active: true, triggerNodes: ["Webhook"] },
  });
});

test("runPull emits a diff and does not overwrite different local content in non-TTY mode without yes", async () => {
  setStdoutTty(false);
  const fetched = workflow({
    nodes: [
      {
        id: "trigger",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        parameters: { path: "apply" },
      },
      {
        id: "set",
        name: "Set Data",
        type: "n8n-nodes-base.set",
        parameters: { value: "live" },
      },
      {
        id: "new",
        name: "New Node",
        type: "n8n-nodes-base.noOp",
        parameters: {},
      },
    ],
  });
  const local = workflow({
    nodes: [
      {
        id: "trigger",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        parameters: { path: "old" },
      },
      {
        id: "old",
        name: "Old Node",
        type: "n8n-nodes-base.noOp",
        parameters: {},
      },
    ],
  });
  const file = join(workflowsDir, "apply-agreement.json");
  writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`);
  const before = readFileSync(file, "utf8");
  const getOutput = captureStdout();

  const code = await runPull(
    fetched.name,
    { dir: workflowsDir, json: true, quiet: true },
    () => clientFor(fetched) as any,
  );

  const payload = JSON.parse(getOutput());
  expect(code).toBe(0);
  expect(payload.wrote).toBe(false);
  expect(payload.diff).toEqual({
    different: true,
    nodes: {
      added: ["New Node", "Set Data"],
      removed: ["Old Node"],
      changed: ["Webhook"],
    },
  });
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("runPull overwrites different local content when yes is true", async () => {
  setStdoutTty(false);
  const fetched = workflow();
  const file = join(workflowsDir, "apply-agreement.json");
  writeFileSync(
    file,
    `${JSON.stringify(workflow({ active: false, nodes: [] }), null, 2)}\n`,
  );
  const getOutput = captureStdout();

  const code = await runPull(
    fetched.name,
    { dir: workflowsDir, yes: true, json: true, quiet: true },
    () => clientFor(fetched) as any,
  );

  expect(code).toBe(0);
  expect(readJson(file)).toEqual(fetched);
  expect(JSON.parse(getOutput())).toMatchObject({
    file,
    wrote: true,
    diff: { different: true },
  });
});

test("runPull returns 2 when instance resolution fails", async () => {
  delete process.env.N8N_BASE_URL;
  delete process.env.N8N_API_KEY;
  const getOutput = captureStdout();

  const code = await runPull("Missing", {
    dir: workflowsDir,
    instance: "missing.example",
    json: true,
    quiet: true,
  });

  expect(code).toBe(2);
  expect(JSON.parse(getOutput())).toMatchObject({
    error: { code: "no-credentials" },
  });
});
