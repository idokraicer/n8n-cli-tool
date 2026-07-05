import { expect, test } from "bun:test";
import {
  diffWorkflows,
  validateWorkflow,
  type ValidationError,
} from "../src/workflow-validate";
import type { WorkflowDefinition, WorkflowNode } from "../src/types";

function node(
  id: string,
  name: string,
  parameters: Record<string, unknown> = {},
  patch: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    name,
    type: "n8n-nodes-base.set",
    typeVersion: 1,
    position: [0, 0],
    parameters,
    ...patch,
  };
}

function workflow(
  nodes: WorkflowNode[],
  connections: WorkflowDefinition["connections"] = {},
  patch: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    name: "Workflow",
    nodes,
    connections,
    ...patch,
  };
}

function connect(from: string, to: string): WorkflowDefinition["connections"] {
  return {
    [from]: {
      main: [[{ node: to, type: "main", index: 0 }]],
    },
  };
}

test("non-existent reference returns a hard error", () => {
  const local = workflow([
    node("a", "Trigger"),
    node("b", "Use Missing", {
      value: "={{ $('Missing').item.json.id }}",
    }),
  ], connect("Trigger", "Use Missing"));

  const result = validateWorkflow(local, null);

  expect(result.valid).toBe(false);
  expect(result.summary).toEqual({ errorCount: 1, warningCount: 0 });
  expect(result.errors).toContainEqual({
    type: "broken-reference",
    node: "Use Missing",
    expression: "$('Missing')",
    referencedNode: "Missing",
    reason: "non-existent",
  });
});

test("not-upstream reference returns a hard error when the node exists on another branch", () => {
  const local = workflow([
    node("a", "Source"),
    node("b", "Sibling"),
    node("c", "Consumer", {
      value: "={{ $('Sibling').item.json.id }}",
    }),
  ], connect("Source", "Consumer"));

  const result = validateWorkflow(local, null);

  expect(result.valid).toBe(false);
  expect(result.errors).toContainEqual({
    type: "broken-reference",
    node: "Consumer",
    expression: "$('Sibling')",
    referencedNode: "Sibling",
    reason: "not-upstream",
  });
});

test("upstream reference passes without errors", () => {
  const local = workflow([
    node("a", "Source"),
    node("b", "Consumer", {
      value: "={{ $('Source').item.json.id }}",
    }),
  ], connect("Source", "Consumer"));

  const result = validateWorkflow(local, null);

  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result).not.toHaveProperty("diff");
});

test("stale-json warning is emitted when immediate main predecessors change", () => {
  const remote = workflow([
    node("a", "Source"),
    node("b", "Build Payload", {
      orderId: "={{ $json.orderId }}",
    }),
  ], connect("Source", "Build Payload"));
  const local = workflow([
    node("a", "Source"),
    node("n", "Normalize"),
    node("b", "Build Payload", {
      orderId: "={{ $json.orderId }}",
    }),
  ], {
    Source: { main: [[{ node: "Normalize", type: "main", index: 0 }]] },
    Normalize: { main: [[{ node: "Build Payload", type: "main", index: 0 }]] },
  });

  const result = validateWorkflow(local, remote);

  expect(result.valid).toBe(true);
  expect(result.warnings).toContainEqual({
    type: "stale-json",
    node: "Build Payload",
    from: ["Source"],
    to: ["Normalize"],
    expressions: ["$json.orderId"],
    reason: "stale-json",
  });
  expect(result.diff?.nodesAdded).toEqual(["Normalize"]);
});

test("rename hint is attached when a broken old-name reference matches a stable id rename", () => {
  const remote = workflow([
    node("agent-id", "Agent"),
    node("consumer-id", "Send Reply", {
      text: "={{ $('Agent').item.json.output }}",
    }),
  ], connect("Agent", "Send Reply"));
  const local = workflow([
    node("agent-id", "AI Agent"),
    node("consumer-id", "Send Reply", {
      text: "={{ $('Agent').item.json.output }}",
    }),
  ], connect("AI Agent", "Send Reply"));

  const result = validateWorkflow(local, remote);

  expect(result.valid).toBe(false);
  expect(result.errors[0]).toEqual({
    type: "broken-reference",
    node: "Send Reply",
    expression: "$('Agent')",
    referencedNode: "Agent",
    reason: "non-existent",
    hint: "node was renamed 'Agent' -> 'AI Agent'",
  } satisfies ValidationError);
});

test("diffWorkflows reports added, removed, modified, renamed, and top-level flags", () => {
  const remote = workflow(
    [
      node("renamed-id", "Agent"),
      node("edited-id", "Edited", { old: true }),
      node("removed-id", "Removed"),
    ],
    connect("Agent", "Edited"),
    { name: "Remote Workflow", settings: { saveDataSuccessExecution: "all" } },
  );
  const local = workflow(
    [
      node("renamed-id", "AI Agent"),
      node("edited-id", "Edited", { old: false }, {
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [100, 200],
      }),
      node("added-id", "Added"),
    ],
    connect("AI Agent", "Edited"),
    { name: "Local Workflow", settings: { saveDataSuccessExecution: "none" } },
  );

  expect(diffWorkflows(local, remote)).toEqual({
    nameChanged: true,
    nodesAdded: ["Added"],
    nodesRemoved: ["Removed"],
    nodesModified: ["AI Agent", "Edited"],
    nodesRenamed: [{ id: "renamed-id", from: "Agent", to: "AI Agent" }],
    connectionsChanged: true,
    settingsChanged: true,
  });
});

test("parse failure returns invalid validation result without throwing", () => {
  const result = validateWorkflow({ name: 7, nodes: [], connections: {} }, null);

  expect(result.valid).toBe(false);
  expect(result.warnings).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toMatchObject({
    type: "parse",
    reason: "parse",
  });
  expect(result.summary).toEqual({ errorCount: 1, warningCount: 0 });
});

test("an AI sub-node referencing the agent's upstream node is NOT flagged not-upstream", () => {
  // Trigger --main--> Agent ; Memory --ai_memory--> Agent.
  // Memory references Trigger (upstream of the agent it feeds) — valid at runtime.
  const local = workflow(
    [
      node("t", "Trigger"),
      node("ag", "Agent", {}, { type: "@n8n/n8n-nodes-langchain.agent" }),
      node(
        "mem",
        "Memory",
        { sessionKey: "={{ $('Trigger').item.json.sessionId }}" },
        { type: "@n8n/n8n-nodes-langchain.memoryBufferWindow" },
      ),
    ],
    {
      Trigger: { main: [[{ node: "Agent", type: "main", index: 0 }]] },
      Memory: { ai_memory: [[{ node: "Agent", type: "ai_memory", index: 0 }]] },
    },
  );

  const result = validateWorkflow(local, null);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});
