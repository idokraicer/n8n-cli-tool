import { test, expect } from "bun:test";
import {
  normalizeExecutionData,
  extractSearchUnits,
  extractNodeSummaries,
  extractExecutionInfo,
} from "../src/n8n-data";
import { CliError } from "../src/types";

function exec(dataField: unknown) {
  return {
    id: 7,
    workflowId: "WF",
    status: "success",
    mode: "trigger",
    finished: true,
    startedAt: "S",
    stoppedAt: "T",
    data: dataField,
  };
}

const runData = {
  resultData: {
    lastNodeExecuted: "B",
    runData: {
      A: [
        {
          executionStatus: "success",
          data: { main: [[{ json: { v: "alpha" } }, { json: { v: "beta" } }]] },
        },
      ],
      B: [{ executionStatus: "success", data: { main: [[{ json: { v: "gamma" } }]] } }],
    },
  },
};

test("normalizes object-form data", () => {
  expect(normalizeExecutionData(exec(runData))).toEqual(runData);
});

test("normalizes stringified data", () => {
  expect(normalizeExecutionData(exec(JSON.stringify(runData)))).toEqual(runData);
});

test("throws no-execution-data when data is missing", () => {
  try {
    normalizeExecutionData(exec(undefined));
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).code).toBe("no-execution-data");
  }
});

test("extracts search units across nodes", () => {
  const units = extractSearchUnits(runData);
  expect(units.length).toBe(3);
  expect(units[0]).toEqual({
    node: "A",
    runIndex: 0,
    outputIndex: 0,
    itemIndex: 0,
    json: { v: "alpha" },
    binary: undefined,
  });
});

test("filters search units by node", () => {
  const units = extractSearchUnits(runData, "B");
  expect(units.length).toBe(1);
  expect(units[0].node).toBe("B");
});

test("summarizes nodes with run and item counts", () => {
  const summaries = extractNodeSummaries(runData);
  expect(summaries).toContainEqual({ name: "A", runs: 1, items: 2, status: "success" });
  expect(summaries).toContainEqual({ name: "B", runs: 1, items: 1, status: "success" });
});

test("extracts execution info with a canonical URL", () => {
  const info = extractExecutionInfo(exec(runData), "https://h.co");
  expect(info.id).toBe("7");
  expect(info.workflowId).toBe("WF");
  expect(info.url).toBe("https://h.co/workflow/WF/executions/7");
});
