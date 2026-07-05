import { test, expect } from "bun:test";
import {
  replaceNode,
  setByPath,
  setCode,
  setPrompt,
} from "../src/workflow-edit";
import type { WorkflowDefinition } from "../src/types";

function workflow(): WorkflowDefinition {
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
        type: "n8n-nodes-base.agent",
        position: [300, 400],
        parameters: {
          options: { systemMessage: "old system" },
          text: "old user",
        },
      },
      {
        id: "blank-code-id",
        name: "Blank Code",
        type: "n8n-nodes-base.code",
        position: [500, 600],
        parameters: {},
      },
    ],
  };
}

test("setByPath creates intermediate objects and sets the leaf value", () => {
  const obj: Record<string, unknown> = {};
  setByPath(obj, "a.b.c", "value");
  expect(obj).toEqual({ a: { b: { c: "value" } } });
});

test("setCode sets JavaScript code and reports character counts", () => {
  const def = workflow();
  const result = setCode(def, "Code", "return 123;", "js");

  expect(def.nodes[0].parameters?.jsCode).toBe("return 123;");
  expect(result).toEqual({
    node: "Code",
    field: "parameters.jsCode",
    action: "set",
    beforeChars: "return 1;".length,
    afterChars: "return 123;".length,
  });
});

test("setCode sets Python code and treats an undefined old value as zero chars", () => {
  const def = workflow();
  const result = setCode(def, "Blank Code", "return 123", "python");

  expect(def.nodes[2].parameters?.pythonCode).toBe("return 123");
  expect(result).toEqual({
    node: "Blank Code",
    field: "parameters.pythonCode",
    action: "set",
    beforeChars: 0,
    afterChars: "return 123".length,
  });
});

test("setPrompt sets only the default system prompt path", () => {
  const def = workflow();
  const result = setPrompt(def, "Agent", { system: "new system" });

  expect((def.nodes[1].parameters?.options as any).systemMessage).toBe(
    "new system",
  );
  expect(result).toEqual([
    {
      node: "Agent",
      field: "parameters.options.systemMessage",
      action: "set",
      beforeChars: "old system".length,
      afterChars: "new system".length,
    },
  ]);
});

test("setPrompt sets only the default user prompt path", () => {
  const def = workflow();
  const result = setPrompt(def, "Agent", { user: "new user" });

  expect(def.nodes[1].parameters?.text).toBe("new user");
  expect(result).toEqual([
    {
      node: "Agent",
      field: "parameters.text",
      action: "set",
      beforeChars: "old user".length,
      afterChars: "new user".length,
    },
  ]);
});

test("setPrompt sets system and user prompts in one call", () => {
  const def = workflow();
  const result = setPrompt(def, "Agent", {
    system: "system v2",
    user: "user v2",
  });

  expect((def.nodes[1].parameters?.options as any).systemMessage).toBe(
    "system v2",
  );
  expect(def.nodes[1].parameters?.text).toBe("user v2");
  expect(result).toHaveLength(2);
  expect(result.map((r) => r.field)).toEqual([
    "parameters.options.systemMessage",
    "parameters.text",
  ]);
});

test("setPrompt honors custom systemPath and userPath", () => {
  const def = workflow();
  const result = setPrompt(def, "Agent", {
    system: "custom system",
    user: "custom user",
    systemPath: "parameters.prompt.system",
    userPath: "parameters.prompt.user",
  });

  expect((def.nodes[1].parameters?.prompt as any).system).toBe("custom system");
  expect((def.nodes[1].parameters?.prompt as any).user).toBe("custom user");
  expect(result.map((r) => r.field)).toEqual([
    "parameters.prompt.system",
    "parameters.prompt.user",
  ]);
});

test("setPrompt preserves a single expression prefix when the old value was an expression", () => {
  const def = workflow();
  (def.nodes[1].parameters!.options as any).systemMessage = "=old";

  const result = setPrompt(def, "Agent", { system: "new" });

  expect((def.nodes[1].parameters?.options as any).systemMessage).toBe("=new");
  expect(result[0]).toMatchObject({
    beforeChars: 4,
    afterChars: 4,
  });
});

test("setPrompt does not double an existing expression prefix on the new value", () => {
  const def = workflow();
  (def.nodes[1].parameters!.options as any).systemMessage = "=old";

  setPrompt(def, "Agent", { system: "=new" });

  expect((def.nodes[1].parameters?.options as any).systemMessage).toBe("=new");
});

test("setPrompt literal bypasses expression prefix preservation", () => {
  const def = workflow();
  (def.nodes[1].parameters!.options as any).systemMessage = "=old";

  setPrompt(def, "Agent", { system: "new", literal: true });

  expect((def.nodes[1].parameters?.options as any).systemMessage).toBe("new");
});

test("setPrompt rejects calls without system or user values", () => {
  expect(() => setPrompt(workflow(), "Agent", {})).toThrow(
    expect.objectContaining({ code: "bad-arguments" }),
  );
});

test("setPrompt rejects unknown nodes with available node names", () => {
  expect(() => setPrompt(workflow(), "Missing", { user: "x" })).toThrow(
    expect.objectContaining({
      code: "bad-arguments",
      message: "Unknown node 'Missing'. Available: Code, Agent, Blank Code",
    }),
  );
});

test("replaceNode preserves id and position when replacement omits them", () => {
  const def = workflow();
  const before = JSON.stringify(def.nodes[0]).length;
  const result = replaceNode(def, "Code", {
    name: "Code",
    type: "n8n-nodes-base.httpRequest",
    parameters: { url: "https://example.com" },
  } as any);
  const after = JSON.stringify(def.nodes[0]).length;

  expect(def.nodes[0]).toMatchObject({
    id: "code-id",
    name: "Code",
    type: "n8n-nodes-base.httpRequest",
    position: [100, 200],
    parameters: { url: "https://example.com" },
  });
  expect(result).toMatchObject({
    node: "Code",
    field: "node",
    action: "replaced",
  });
  expect(result.beforeChars).toBe(before);
  expect(result.afterChars).toBe(after);
});

test("replaceNode respects explicit id and position in the replacement", () => {
  const def = workflow();
  replaceNode(def, "Code", {
    id: "new-id",
    name: "Code",
    type: "n8n-nodes-base.noOp",
    position: [9, 10],
    parameters: {},
  });

  expect(def.nodes[0].id).toBe("new-id");
  expect(def.nodes[0].position).toEqual([9, 10]);
});

test("replaceNode rejects name mismatches", () => {
  expect(() =>
    replaceNode(workflow(), "Code", {
      name: "Renamed",
      type: "n8n-nodes-base.noOp",
    } as any),
  ).toThrow(expect.objectContaining({ code: "bad-arguments" }));
});

test("replaceNode rejects unknown nodes", () => {
  expect(() =>
    replaceNode(workflow(), "Missing", {
      name: "Missing",
      type: "n8n-nodes-base.noOp",
    } as any),
  ).toThrow(
    expect.objectContaining({
      code: "bad-arguments",
      message: "Unknown node 'Missing'. Available: Code, Agent, Blank Code",
    }),
  );
});
