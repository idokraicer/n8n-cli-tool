import { test, expect } from "bun:test";
import {
  parseN8nUrl,
  classifyBareId,
  buildWorkflowUrl,
  buildExecutionUrl,
} from "../src/url";

test("parses an execution URL", () => {
  const r = parseN8nUrl(
    "https://n8n.example.com/workflow/NDiulczinIqHUJJF/executions/351694",
  );
  expect(r).toEqual({
    kind: "execution",
    host: "n8n.example.com",
    baseUrl: "https://n8n.example.com",
    workflowId: "NDiulczinIqHUJJF",
    executionId: "351694",
  });
});

test("parses a workflow URL with a trailing slash", () => {
  const r = parseN8nUrl("https://n8n.example.com/workflow/NDiulczinIqHUJJF/");
  expect(r).toEqual({
    kind: "workflow",
    host: "n8n.example.com",
    baseUrl: "https://n8n.example.com",
    workflowId: "NDiulczinIqHUJJF",
  });
});

test("returns null for a non-n8n URL", () => {
  expect(parseN8nUrl("https://example.com/foo")).toBeNull();
});

test("returns null for a bare id", () => {
  expect(parseN8nUrl("351694")).toBeNull();
});

test("classifies an all-digit id as an execution", () => {
  expect(classifyBareId("351694")).toBe("execution");
});

test("classifies an alphanumeric id as a workflow", () => {
  expect(classifyBareId("NDiulczinIqHUJJF")).toBe("workflow");
});

test("builds canonical URLs", () => {
  expect(buildWorkflowUrl("https://h.co", "WF")).toBe(
    "https://h.co/workflow/WF",
  );
  expect(buildExecutionUrl("https://h.co", "WF", "99")).toBe(
    "https://h.co/workflow/WF/executions/99",
  );
});
