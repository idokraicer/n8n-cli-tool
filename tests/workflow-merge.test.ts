import { expect, test } from "bun:test";
import {
  computeChangedNodes,
  mergeNodes,
  stripForPut,
} from "../src/workflow-merge";
import type { WorkflowDefinition, WorkflowNode } from "../src/types";

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
    id: "WF",
    name: "Workflow",
    nodes,
    connections: {},
    settings: { executionOrder: "v1" },
    ...overrides,
  };
}

test("computeChangedNodes returns deep-different shared nodes and local-only nodes", () => {
  const live = workflow([
    node("a", "A", { value: { z: 1, a: 2 } }),
    node("b", "B", { value: "same" }),
  ]);
  const local = workflow([
    node("a", "A", { value: { a: 2, z: 1 } }),
    node("b", "B", { value: "changed" }),
    node("c", "C", { value: "new" }),
  ]);

  expect(computeChangedNodes(local, live)).toEqual(["B", "C"]);
});

test("mergeNodes splices only the requested existing nodes into the live workflow", () => {
  const liveA = node("a", "A", { value: "live-a" });
  const liveB = node("b", "B", { value: "live-b" });
  const localA = node("a", "A", { value: "local-a" });
  const localB = node("b", "B", { value: "local-b" });
  const live = workflow([liveA, liveB], {
    connections: { A: { main: [[{ node: "B", type: "main", index: 0 }]] } },
    settings: { live: true },
  });
  const local = workflow([localA, localB], {
    connections: {},
    settings: { local: true },
  });

  const plan = mergeNodes(live, local, ["A"]);

  expect(plan.updated).toEqual(["A"]);
  expect(plan.merged.nodes).toEqual([localA, liveB]);
  expect(plan.merged.connections).toEqual(live.connections);
  expect(plan.merged.settings).toEqual(live.settings);
});

test("mergeNodes with null targets uses all changed existing nodes", () => {
  const live = workflow([
    node("a", "A", { value: "live-a" }),
    node("b", "B", { value: "same" }),
  ]);
  const local = workflow([
    node("a", "A", { value: "local-a" }),
    node("b", "B", { value: "same" }),
  ]);

  const plan = mergeNodes(live, local, null);

  expect(plan.updated).toEqual(["A"]);
  expect(plan.merged.nodes).toEqual([local.nodes[0], live.nodes[1]]);
});

test("mergeNodes records added removed and connection changes without applying them", () => {
  const live = workflow(
    [node("a", "A"), node("removed", "Removed")],
    {
      connections: { A: { main: [[{ node: "Removed", type: "main", index: 0 }]] } },
    },
  );
  const local = workflow(
    [node("a", "A", { value: "changed" }), node("new", "Added")],
    {
      connections: { A: { main: [[{ node: "Added", type: "main", index: 0 }]] } },
    },
  );

  const plan = mergeNodes(live, local, null);

  expect(plan.updated).toEqual(["A"]);
  expect(plan.excluded).toEqual({
    addedNodes: ["Added"],
    removedNodes: ["Removed"],
    connectionsChanged: true,
  });
  expect(plan.merged.nodes.map((item) => item.name)).toEqual(["A", "Removed"]);
  expect(plan.merged.connections).toEqual(live.connections);
});

test("mergeNodes reports locally-added nodes even when --node selects a subset that excludes them", () => {
  const live = workflow([node("a", "A")]);
  const local = workflow([
    node("a", "A", { value: "changed" }),
    node("new", "Added"),
  ]);

  // Push only "A"; "Added" is new locally but outside the target subset.
  const plan = mergeNodes(live, local, ["A"]);

  expect(plan.updated).toEqual(["A"]);
  // "Added" must still surface so the user can escalate to --whole.
  expect(plan.excluded.addedNodes).toEqual(["Added"]);
});

test("stripForPut keeps only writable fields, defaults settings, and reports stripped read-only fields", () => {
  const def: WorkflowDefinition = {
    id: "WF",
    name: "Workflow",
    active: true,
    tags: [{ id: "tag" }],
    versionId: "v1",
    triggerCount: 2,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-02",
    pinData: { A: [{ json: { id: 1 } }] },
    nodes: [node("a", "A")],
    connections: {},
    staticData: { lastId: 1 },
    extra: "ignored",
  };

  expect(stripForPut(def)).toEqual({
    body: {
      name: "Workflow",
      nodes: def.nodes,
      connections: {},
      settings: {},
      staticData: { lastId: 1 },
    },
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
    strippedSettingsKeys: [],
  });
});

test("stripForPut allowlists settings and reports editor-only keys it drops", () => {
  const def: WorkflowDefinition = {
    id: "WF",
    name: "Workflow",
    nodes: [node("a", "A")],
    connections: {},
    // executionOrder is writable; binaryMode/availableInMCP are editor-only keys
    // n8n's public PUT rejects (this is the exact 400 seen in the field).
    settings: {
      executionOrder: "v1",
      binaryMode: "separate",
      availableInMCP: false,
    },
  };

  const { body, strippedSettingsKeys } = stripForPut(def);
  expect(body.settings).toEqual({ executionOrder: "v1" });
  expect(strippedSettingsKeys).toEqual(["binaryMode", "availableInMCP"]);
});

test("mergeNodes throws when an explicitly named node is absent locally", () => {
  const live = workflow([node("a", "A"), node("b", "B")]);
  const local = workflow([node("a", "A"), node("b", "B")]);
  expect(() => mergeNodes(live, local, ["Ghost"])).toThrow(/Unknown node 'Ghost'/);
});
