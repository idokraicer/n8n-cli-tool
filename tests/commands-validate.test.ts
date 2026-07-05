import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidate } from "../src/commands/validate";
import type { ResolvedInstance, WorkflowDefinition, WorkflowNode } from "../src/types";

let home: string;
let workflowsDir: string;

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

function workflow(nodes: WorkflowNode[], connections: WorkflowDefinition["connections"] = {}): WorkflowDefinition {
  return {
    id: "WF",
    name: "Workflow",
    nodes,
    connections,
  };
}

function writeWorkflow(def: WorkflowDefinition): void {
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, "wf.json"), `${JSON.stringify(def, null, 2)}\n`);
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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-validate-"));
  workflowsDir = join(home, "workflows");
  process.env.N8N_HELPER_HOME = home;
  process.env.N8N_API_KEY = "K";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_API_KEY;
});

test("runValidate returns exit 0 for a valid workflow", async () => {
  const local = workflow(
    [
      node("a", "Source"),
      node("b", "Consumer", { value: "={{ $('Source').item.json.id }}" }),
    ],
    { Source: { main: [[{ node: "Consumer", type: "main", index: 0 }]] } },
  );
  writeWorkflow(local);
  const client = {
    getWorkflow: async (id: string) => ({ ...local, id }),
  };

  const { result: code, stdout } = await captureStdout(() =>
    runValidate("https://h.co/workflow/WF", { dir: workflowsDir, json: true, quiet: true }, () => client as any),
  );

  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    instance: "h.co",
    workflow: { id: "WF" },
    valid: true,
    summary: { errorCount: 0, warningCount: 0 },
  });
});

test("runValidate returns exit 1 when hard errors are present", async () => {
  const local = workflow([
    node("b", "Consumer", { value: "={{ $('Missing').item.json.id }}" }),
  ]);
  writeWorkflow(local);
  const client = {
    getWorkflow: async () => local,
  };

  const { result: code, stdout } = await captureStdout(() =>
    runValidate("https://h.co/workflow/WF", { dir: workflowsDir, json: true, quiet: true }, () => client as any),
  );

  expect(code).toBe(1);
  expect(JSON.parse(stdout).errors).toContainEqual(
    expect.objectContaining({
      type: "broken-reference",
      reason: "non-existent",
      referencedNode: "Missing",
    }),
  );
});

test("runValidate returns exit 2 on an operational failure", async () => {
  const client = {
    getWorkflow: async () => {
      throw new Error("should not fetch without a local file");
    },
  };

  const { result: code, stdout } = await captureStdout(() =>
    runValidate("https://h.co/workflow/WF", { dir: workflowsDir, json: true, quiet: true }, () => client as any),
  );

  expect(code).toBe(2);
  expect(JSON.parse(stdout)).toMatchObject({
    error: {
      code: "no-local-file",
    },
  });
});

test("--local skips remote fetch and omits remote-derived output", async () => {
  const local = workflow([
    node("b", "Build Payload", { value: "={{ $json.orderId }}" }),
  ]);
  writeWorkflow(local);
  let fetches = 0;
  const clientFactory = (_instance: ResolvedInstance) => ({
    getWorkflow: async () => {
      fetches += 1;
      throw new Error("remote fetch should be skipped");
    },
  });

  const { result: code, stdout } = await captureStdout(() =>
    runValidate("https://h.co/workflow/WF", { local: true, dir: workflowsDir, json: true, quiet: true }, clientFactory as any),
  );
  const payload = JSON.parse(stdout);

  expect(code).toBe(0);
  expect(fetches).toBe(0);
  expect(payload).not.toHaveProperty("diff");
  expect(payload.warnings).toEqual([]);
});
