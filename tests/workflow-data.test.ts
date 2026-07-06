import { expect, test } from "bun:test";
import {
  buildGraph,
  extractReferences,
  findNode,
  parseWorkflow,
} from "../src/workflow-data";
import type { WorkflowDefinition, WorkflowNode } from "../src/types";

function node(name: string, parameters: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: name,
    name,
    type: "test",
    parameters,
  };
}

test("parseWorkflow returns a valid workflow definition", () => {
  const raw = {
    name: "Workflow",
    nodes: [node("A")],
    connections: {},
  };

  expect(parseWorkflow(raw)).toBe(raw);
});

test("parseWorkflow throws parse when raw is not an object", () => {
  expect(() => parseWorkflow(null)).toThrow(
    expect.objectContaining({
      code: "parse",
      message: expect.stringContaining("object"),
    }),
  );
});

test("parseWorkflow throws parse when name is not a string", () => {
  expect(() => parseWorkflow({ name: 7, nodes: [], connections: {} })).toThrow(
    expect.objectContaining({
      code: "parse",
      message: expect.stringContaining("name"),
    }),
  );
});

test("parseWorkflow throws parse when nodes is not an array", () => {
  expect(() =>
    parseWorkflow({ name: "Workflow", nodes: {}, connections: {} }),
  ).toThrow(
    expect.objectContaining({
      code: "parse",
      message: expect.stringContaining("nodes"),
    }),
  );
});

test("parseWorkflow throws parse when connections is not an object", () => {
  expect(() =>
    parseWorkflow({ name: "Workflow", nodes: [], connections: null }),
  ).toThrow(
    expect.objectContaining({
      code: "parse",
      message: expect.stringContaining("connections"),
    }),
  );
});

test("findNode returns a node by name", () => {
  const def = {
    name: "Workflow",
    nodes: [node("A"), node("B")],
    connections: {},
  } as WorkflowDefinition;

  expect(findNode(def, "B")?.name).toBe("B");
  expect(findNode(def, "Missing")).toBeUndefined();
});

test("extractReferences finds named refs and $json in nested expression params", () => {
  const refs = extractReferences(
    node("B", {
      direct: "=Value: {{ $('Agent').item.json.x }}",
      nested: {
        legacyNode: '={{ $node["Legacy"].json.value }}',
        array: ["={{ $items('Items')[0].json.id }}", "plain $('Ignored')"],
      },
      json: "={{ $json.id }}",
      jsonLongerWord: "={{ $jsonify.id }}",
    }),
  );

  expect(refs).toContainEqual({
    node: "B",
    expression: "$('Agent')",
    referencedNode: "Agent",
  });
  expect(refs).toContainEqual({
    node: "B",
    expression: "$('Legacy')",
    referencedNode: "Legacy",
  });
  expect(refs).toContainEqual({
    node: "B",
    expression: "$('Items')",
    referencedNode: "Items",
  });
  expect(refs).toContainEqual({
    node: "B",
    expression: "$json",
  });
  expect(refs.map((ref) => ref.referencedNode)).not.toContain("Ignored");
  expect(refs.map((ref) => ref.expression)).not.toContain("$jsonify");
});

test("extractReferences ignores dot-form legacy node references", () => {
  const refs = extractReferences(
    node("B", {
      dotForm: "={{ $node.Agent.json.value }}",
    }),
  );

  expect(refs).toEqual([]);
});

test("buildGraph returns ancestors over all connection types", () => {
  const def = {
    name: "Workflow",
    nodes: [node("Trigger"), node("Agent"), node("Model"), node("Done")],
    connections: {
      Trigger: {
        main: [[{ node: "Agent", type: "main", index: 0 }]],
      },
      Agent: {
        main: [[{ node: "Done", type: "main", index: 0 }]],
      },
      Model: {
        ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]],
      },
    },
  } as WorkflowDefinition;

  const graph = buildGraph(def);

  expect(graph.ancestors("Done")).toEqual(new Set(["Agent", "Trigger", "Model"]));
});

test("buildGraph returns direct main predecessors only", () => {
  const def = {
    name: "Workflow",
    nodes: [node("Trigger"), node("Agent"), node("Model"), node("Done")],
    connections: {
      Trigger: {
        main: [[{ node: "Agent", type: "main", index: 0 }]],
      },
      Agent: {
        main: [[{ node: "Done", type: "main", index: 0 }]],
      },
      Model: {
        ai_languageModel: [[{ node: "Done", type: "ai_languageModel", index: 0 }]],
      },
    },
  } as WorkflowDefinition;

  const graph = buildGraph(def);

  expect(graph.mainPredecessors("Done")).toEqual(new Set(["Agent"]));
});

test("buildGraph handles cycles without infinite traversal", () => {
  const def = {
    name: "Workflow",
    nodes: [node("A"), node("B"), node("C")],
    connections: {
      A: {
        main: [[{ node: "B", type: "main", index: 0 }]],
      },
      B: {
        main: [[{ node: "C", type: "main", index: 0 }]],
      },
      C: {
        main: [[{ node: "A", type: "main", index: 0 }]],
      },
    },
  } as WorkflowDefinition;

  const graph = buildGraph(def);

  expect(graph.ancestors("A")).toEqual(new Set(["C", "B", "A"]));
});

test("extractReferences unescapes escaped delimiters in node names and dedupes", () => {
  const node = {
    id: "n", name: "B", type: "x",
    parameters: {
      a: "={{ $('O\\'Brien').item.json.x }}",
      b: "={{ $('O\\'Brien').item.json.y }}",
    },
  };
  const named = extractReferences(node as any).filter((r) => r.referencedNode);
  expect(named).toHaveLength(1);
  expect(named[0].referencedNode).toBe("O'Brien");
});

test("extractReferences is linear on backslash-heavy input (no ReDoS)", () => {
  // Unterminated $(' followed by many backslashes — the pathological case.
  const evil = "=" + "$('" + "\\".repeat(50000);
  const node = { id: "n", name: "B", type: "x", parameters: { a: evil } };
  const start = performance.now();
  extractReferences(node as any);
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(500); // linear; the old regex took minutes here
});
