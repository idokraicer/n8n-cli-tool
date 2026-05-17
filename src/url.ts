import type { ParsedN8nUrl } from "./types";

const N8N_URL_RE =
  /^(https?:\/\/([^/]+))\/workflow\/([^/?#]+)(?:\/executions\/([^/?#]+))?\/?(?:[?#].*)?$/;

export function parseN8nUrl(input: string): ParsedN8nUrl | null {
  const match = input.trim().match(N8N_URL_RE);
  if (!match) return null;
  const [, baseUrl, host, workflowId, executionId] = match;
  if (executionId) {
    return { kind: "execution", host, baseUrl, workflowId, executionId };
  }
  return { kind: "workflow", host, baseUrl, workflowId };
}

export function classifyBareId(id: string): "execution" | "workflow" {
  return /^\d+$/.test(id.trim()) ? "execution" : "workflow";
}

export function buildWorkflowUrl(baseUrl: string, workflowId: string): string {
  return `${baseUrl}/workflow/${workflowId}`;
}

export function buildExecutionUrl(
  baseUrl: string,
  workflowId: string,
  executionId: string,
): string {
  return `${baseUrl}/workflow/${workflowId}/executions/${executionId}`;
}
