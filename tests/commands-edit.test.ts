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

  // Isolate credential/config resolution to the temp dir so --remote tests never
  // touch the real ~/.n8n-helper config or catalog.
  process.env.N8N_HELPER_HOME = temp;
  process.env.N8N_API_KEY = "K";

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
  delete process.env.N8N_HELPER_HOME;
  delete process.env.N8N_API_KEY;
  rmSync(temp, { recursive: true, force: true });
});

function remoteWorkflow() {
  return {
    id: "WF",
    name: "Edit Me",
    active: true,
    versionId: "v9",
    nodes: [
      {
        id: "code-id",
        name: "Code",
        type: "n8n-nodes-base.code",
        position: [100, 200],
        parameters: { jsCode: "return 1;" },
      },
    ],
    connections: {},
    // binaryMode is an editor-only key n8n's public PUT rejects; the push path
    // must sanitize it away.
    settings: { executionOrder: "v1", binaryMode: "separate" },
  };
}

function remoteClient() {
  const updated: { id: string; body: any }[] = [];
  const client = {
    listWorkflows: async () => ({ data: [], nextCursor: null }),
    getWorkflow: async () => remoteWorkflow(),
    updateWorkflow: async (id: string, body: any) => {
      updated.push({ id, body });
      return { ...body, id };
    },
  };
  return { client, updated };
}

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

// --- stdin ('-') content ---

test("set-code reads code from stdin when --code is '-'", async () => {
  const code = await runEdit(
    "Edit Me",
    "set-code",
    { dir: workflowsDir, node: "Code", lang: "js", code: "-", json: true, quiet: true },
    undefined,
    () => "return 'from stdin';",
  );

  expect(code).toBe(0);
  expect(readWorkflow().nodes[0].parameters.jsCode).toBe("return 'from stdin';");
});

test("--code-file '-' also reads stdin", async () => {
  const code = await runEdit(
    "Edit Me",
    "set-code",
    { dir: workflowsDir, node: "Code", lang: "js", codeFile: "-", json: true, quiet: true },
    undefined,
    () => "// piped\nreturn 2;",
  );

  expect(code).toBe(0);
  expect(readWorkflow().nodes[0].parameters.jsCode).toBe("// piped\nreturn 2;");
});

test("two options requesting stdin ('-') is a bad-arguments error", async () => {
  const code = await runEdit(
    "Edit Me",
    "set-prompt",
    { dir: workflowsDir, node: "Agent", systemFile: "-", userFile: "-", json: true, quiet: true },
    undefined,
    () => "only one stream",
  );

  expect(code).toBe(2);
  expect(parseStdout().error.code).toBe("bad-arguments");
  expect(parseStdout().error.message).toContain("stdin");
});

// --- id/URL hint in local mode ---

test("local edit on an id points the user at --remote", async () => {
  const code = await runEdit("U7ggnfBjGrVEl1Ze", "set-code", {
    dir: workflowsDir,
    node: "Code",
    lang: "js",
    code: "return 1;",
    json: true,
    quiet: true,
  });

  expect(code).toBe(2);
  const err = parseStdout().error;
  expect(err.code).toBe("no-local-file");
  expect(err.hint).toContain("id or URL");
  expect(err.hint).toContain("--remote");
});

// --- remote (fileless) mode ---

test("--remote without --yes previews the diff and pushes nothing", async () => {
  const { client, updated } = remoteClient();

  const code = await runEdit(
    "https://h.co/workflow/WF",
    "set-code",
    { node: "Code", lang: "js", code: "return 42;", remote: true, json: true, quiet: true },
    () => client as any,
  );

  expect(code).toBe(0);
  expect(updated).toEqual([]); // nothing pushed without --yes
  const out = parseStdout();
  expect(out.pushed).toBe(false);
  expect(out.edit.field).toBe("parameters.jsCode");
  expect(out.diff.nodesModified).toContain("Code");
  expect(out.hint).toContain("--yes");
});

test("--remote --yes pushes a sanitized single-node merge", async () => {
  const { client, updated } = remoteClient();

  const code = await runEdit(
    "https://h.co/workflow/WF",
    "set-code",
    { node: "Code", lang: "js", code: "return 42;", remote: true, yes: true, json: true, quiet: true },
    () => client as any,
  );

  expect(code).toBe(0);
  expect(updated.length).toBe(1);
  const body = updated[0].body;
  // read-only top-level fields and editor-only settings keys are stripped.
  expect(body.id).toBeUndefined();
  expect(body.active).toBeUndefined();
  expect(body.settings).toEqual({ executionOrder: "v1" });
  // the edited node carries the new code.
  const pushedCode = body.nodes.find((n: any) => n.name === "Code");
  expect(pushedCode.parameters.jsCode).toBe("return 42;");
  const out = parseStdout();
  expect(out.pushed).toBe(true);
  expect(out.strippedSettingsKeys).toContain("binaryMode");
});

test("--remote refuses to push when the edit fails validation (exit 1)", async () => {
  const { client, updated } = remoteClient();
  const nodeFile = join(temp, "broken.json");
  writeFileSync(
    nodeFile,
    JSON.stringify({
      name: "Code",
      type: "n8n-nodes-base.set",
      parameters: { value: "={{ $('Ghost').item.json.id }}" },
    }),
  );

  const code = await runEdit(
    "https://h.co/workflow/WF",
    "replace-node",
    { node: "Code", file: nodeFile, remote: true, yes: true, json: true, quiet: true },
    () => client as any,
  );

  expect(code).toBe(1);
  expect(updated).toEqual([]); // refused — nothing pushed
  const out = parseStdout();
  expect(out.pushed).toBe(false);
  expect(out.validation.valid).toBe(false);
  expect(out.hint).toContain("--force");
});

test("--remote reads code from stdin ('-') too", async () => {
  const { client, updated } = remoteClient();

  const code = await runEdit(
    "https://h.co/workflow/WF",
    "set-code",
    { node: "Code", lang: "js", code: "-", remote: true, yes: true, json: true, quiet: true },
    () => client as any,
    () => "return 'remote stdin';",
  );

  expect(code).toBe(0);
  const pushedCode = updated[0].body.nodes.find((n: any) => n.name === "Code");
  expect(pushedCode.parameters.jsCode).toBe("return 'remote stdin';");
});
