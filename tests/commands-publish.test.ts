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
