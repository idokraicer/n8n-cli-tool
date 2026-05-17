import {
  CliError,
  type ExecutionInfo,
  type NodeSummary,
  type SearchUnit,
} from "./types";
import { buildExecutionUrl } from "./url";

export function normalizeExecutionData(execution: unknown): any {
  const exec = execution as Record<string, unknown>;
  const data = exec?.data;
  if (data === undefined || data === null) {
    throw new CliError(
      "no-execution-data",
      "Execution returned no data. It may have been pruned by retention, or it is too old.",
    );
  }
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      throw new CliError(
        "no-execution-data",
        "Execution data could not be parsed.",
      );
    }
  }
  return data;
}

function runDataOf(data: any): Record<string, any[]> {
  return data?.resultData?.runData ?? {};
}

export function extractSearchUnits(data: any, nodeFilter?: string): SearchUnit[] {
  const runData = runDataOf(data);
  const units: SearchUnit[] = [];
  for (const [node, runs] of Object.entries(runData)) {
    if (nodeFilter && node !== nodeFilter) continue;
    (runs ?? []).forEach((run: any, runIndex: number) => {
      const main: any[] = run?.data?.main ?? [];
      main.forEach((output: any[], outputIndex: number) => {
        (output ?? []).forEach((item: any, itemIndex: number) => {
          units.push({
            node,
            runIndex,
            outputIndex,
            itemIndex,
            json: item?.json ?? {},
            binary: item?.binary,
          });
        });
      });
    });
  }
  return units;
}

export function extractNodeSummaries(data: any): NodeSummary[] {
  const runData = runDataOf(data);
  const summaries: NodeSummary[] = [];
  for (const [name, runs] of Object.entries(runData)) {
    const runList = runs ?? [];
    let items = 0;
    for (const run of runList) {
      const main: any[] = run?.data?.main ?? [];
      for (const output of main) items += (output ?? []).length;
    }
    const last = runList[runList.length - 1];
    summaries.push({
      name,
      runs: runList.length,
      items,
      status: last?.executionStatus ?? "unknown",
    });
  }
  return summaries;
}

export function extractExecutionInfo(
  execution: any,
  baseUrl: string,
): ExecutionInfo {
  const id = String(execution.id);
  const workflowId = String(execution.workflowId);
  return {
    id,
    workflowId,
    status: execution.status ?? "unknown",
    mode: execution.mode ?? "unknown",
    finished: Boolean(execution.finished),
    startedAt: execution.startedAt ?? null,
    stoppedAt: execution.stoppedAt ?? null,
    url: buildExecutionUrl(baseUrl, workflowId, id),
  };
}
