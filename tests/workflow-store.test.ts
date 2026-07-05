import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findLocalFile,
  newFilePath,
  readWorkflowFile,
  resolveWorkflowsDir,
  slugify,
  writeWorkflowFile,
} from "../src/workflow-store";

const tempDirs: string[] = [];
const originalWorkflowsDir = process.env.N8N_WORKFLOWS_DIR;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wfstore-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  if (originalWorkflowsDir === undefined) {
    delete process.env.N8N_WORKFLOWS_DIR;
  } else {
    process.env.N8N_WORKFLOWS_DIR = originalWorkflowsDir;
  }
});

test("slugifies workflow names", () => {
  expect(slugify("Apply Agreement")).toBe("apply-agreement");
});

test("resolves workflows dir by explicit option, env, then default", () => {
  process.env.N8N_WORKFLOWS_DIR = "/env/workflows";

  expect(resolveWorkflowsDir({ dir: "/explicit/workflows" })).toBe(
    "/explicit/workflows",
  );
  expect(resolveWorkflowsDir({})).toBe("/env/workflows");

  delete process.env.N8N_WORKFLOWS_DIR;
  expect(resolveWorkflowsDir({})).toBe("./workflows");
});

test("finds a local workflow file by parsed name recursively", () => {
  const dir = tempDir();
  const nested = join(dir, "agents", "foo.json");
  writeJson(nested, { name: "Apply Agreement", nodes: [], connections: {} });
  writeFileSync(join(dir, "ignore.txt"), "not json");

  expect(findLocalFile(dir, "Apply Agreement")).toBe(nested);
});

test("falls back to the slugified file stem when parsed names do not match", () => {
  const dir = tempDir();
  const path = join(dir, "apply-agreement.json");
  writeJson(path, { name: "Different Name", nodes: [], connections: {} });

  expect(findLocalFile(dir, "Apply Agreement")).toBe(path);
});

test("throws bad-arguments when multiple files parse to the same workflow name", () => {
  const dir = tempDir();
  const first = join(dir, "one.json");
  const second = join(dir, "nested", "two.json");
  writeJson(first, { name: "Duplicate", nodes: [], connections: {} });
  writeJson(second, { name: "Duplicate", nodes: [], connections: {} });

  expect(() => findLocalFile(dir, "Duplicate")).toThrow(
    expect.objectContaining({
      code: "bad-arguments",
      message: expect.stringContaining(first),
    }),
  );
  expect(() => findLocalFile(dir, "Duplicate")).toThrow(
    expect.objectContaining({
      message: expect.stringContaining(second),
    }),
  );
});

test("returns null when no local workflow file matches or the dir is missing", () => {
  const dir = tempDir();

  expect(findLocalFile(dir, "Missing")).toBeNull();
  expect(findLocalFile(join(dir, "does-not-exist"), "Missing")).toBeNull();
});

test("builds a new workflow file path from the slugified name", () => {
  expect(newFilePath("/tmp/workflows", "Apply Agreement")).toBe(
    "/tmp/workflows/apply-agreement.json",
  );
});

test("readWorkflowFile throws no-local-file when the file is missing", () => {
  const path = join(tempDir(), "missing.json");

  expect(() => readWorkflowFile(path)).toThrow(
    expect.objectContaining({
      code: "no-local-file",
      message: `No local workflow file at ${path}. Run \`n8n-helper pull\` first.`,
    }),
  );
});

test("writeWorkflowFile creates a pretty JSON file and readWorkflowFile reads it back", () => {
  const path = join(tempDir(), "nested", "workflow.json");
  const def = {
    name: "Apply Agreement",
    nodes: [],
    connections: {},
  };

  writeWorkflowFile(path, def);

  expect(readFileSync(path, "utf8")).toBe(
    '{\n  "name": "Apply Agreement",\n  "nodes": [],\n  "connections": {}\n}\n',
  );
  expect(readWorkflowFile(path)).toEqual(def);
});
