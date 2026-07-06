import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEdit } from "../src/commands/edit";

let temp: string;
let workflowsDir: string;
let stdout = "";
let stderr = "";
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

function workflow() {
  return {
    name: "Edit Me",
    connections: {},
    nodes: [
      {
        id: "code-id",
        name: "Code",
        type: "n8n-nodes-base.code",
        position: [100, 200],
        parameters: { jsCode: "return 1;" },
      },
      {
        id: "agent-id",
        name: "Agent",
        type: "@n8n/n8n-nodes-langchain.agent",
        position: [300, 400],
        parameters: {
          options: { systemMessage: "old system" },
          text: "old user",
        },
      },
    ],
  };
}

function workflowPath(): string {
  return join(workflowsDir, "edit-me.json");
}

function readWorkflow(): any {
  return JSON.parse(readFileSync(workflowPath(), "utf8"));
}

function parseStdout(): any {
  return JSON.parse(stdout);
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "n8n-helper-edit-"));
  workflowsDir = join(temp, "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(workflowPath(), JSON.stringify(workflow(), null, 2) + "\n");

  stdout = "";
  stderr = "";
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: any) => {
    stdout += String(chunk);
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    stderr += String(chunk);
    return true;
  }) as any;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  rmSync(temp, { recursive: true, force: true });
});

test("set-code with --code-file writes the workflow and prints EditResult JSON", async () => {
  const codeFile = join(temp, "code.js");
  writeFileSync(codeFile, "return $json.id;\n");

  const code = await runEdit("Edit Me", "set-code", {
    dir: workflowsDir,
    node: "Code",
    lang: "js",
    codeFile,
    json: true,
    quiet: true,
  });

  expect(code).toBe(0);
  expect(readWorkflow().nodes[0].parameters.jsCode).toBe("return $json.id;\n");
  expect(parseStdout()).toEqual({
    node: "Code",
    field: "parameters.jsCode",
    action: "set",
    beforeChars: "return 1;".length,
    afterChars: "return $json.id;\n".length,
  });
});

test("set-code with inline --code works", async () => {
  const code = await runEdit("Edit Me", "set-code", {
    dir: workflowsDir,
    node: "Code",
    lang: "python",
    code: "return 5",
    json: true,
    quiet: true,
  });

  expect(code).toBe(0);
  expect(readWorkflow().nodes[0].parameters.pythonCode).toBe("return 5");
  expect(parseStdout()).toMatchObject({
    node: "Code",
    field: "parameters.pythonCode",
    action: "set",
  });
});

test("set-code with both --code and --code-file exits 2", async () => {
  const codeFile = join(temp, "code.js");
  writeFileSync(codeFile, "return 1;");

  const code = await runEdit("Edit Me", "set-code", {
    dir: workflowsDir,
    node: "Code",
    lang: "js",
    code: "return 2;",
    codeFile,
    json: true,
    quiet: true,
  });

  expect(code).toBe(2);
  expect(parseStdout().error.code).toBe("bad-arguments");
});

test("set-code with neither --code nor --code-file exits 2", async () => {
  const code = await runEdit("Edit Me", "set-code", {
    dir: workflowsDir,
    node: "Code",
    lang: "js",
    json: true,
    quiet: true,
  });

  expect(code).toBe(2);
  expect(parseStdout().error.code).toBe("bad-arguments");
});

test("set-prompt with --system-file works", async () => {
  const systemFile = join(temp, "system.md");
  writeFileSync(systemFile, "You are concise.");

  const code = await runEdit("Edit Me", "set-prompt", {
    dir: workflowsDir,
    node: "Agent",
    systemFile,
    json: true,
    quiet: true,
  });

  expect(code).toBe(0);
  expect(readWorkflow().nodes[1].parameters.options.systemMessage).toBe(
    "You are concise.",
  );
  expect(parseStdout()).toEqual([
    {
      node: "Agent",
      field: "parameters.options.systemMessage",
      action: "set",
      beforeChars: "old system".length,
      afterChars: "You are concise.".length,
    },
  ]);
});

test("replace-node with --file works", async () => {
  const nodeFile = join(temp, "node.json");
  writeFileSync(
    nodeFile,
    JSON.stringify({
      name: "Code",
      type: "n8n-nodes-base.httpRequest",
      parameters: { url: "https://example.com" },
    }),
  );

  const code = await runEdit("Edit Me", "replace-node", {
    dir: workflowsDir,
    node: "Code",
    file: nodeFile,
    json: true,
    quiet: true,
  });

  expect(code).toBe(0);
  expect(readWorkflow().nodes[0]).toMatchObject({
    id: "code-id",
    name: "Code",
    type: "n8n-nodes-base.httpRequest",
    position: [100, 200],
    parameters: { url: "https://example.com" },
  });
  expect(parseStdout()).toMatchObject({
    node: "Code",
    field: "node",
    action: "replaced",
  });
});

test("no local file found exits 2 with a no-local-file error", async () => {
  const code = await runEdit("Missing Workflow", "set-code", {
    dir: workflowsDir,
    node: "Code",
    lang: "js",
    code: "return 1;",
    json: true,
    quiet: true,
  });

  expect(code).toBe(2);
  expect(parseStdout().error.code).toBe("no-local-file");
  expect(stderr).toBe("");
});
