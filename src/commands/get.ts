import { writeFileSync } from "node:fs";
import { CliError, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { parseN8nUrl } from "../url";
import { getExecutionCached } from "../exec-cache";
import {
  normalizeExecutionData,
  extractSearchUnits,
  extractNodeSummaries,
  extractExecutionInfo,
  extractParentExecution,
  type ParentExecutionRef,
} from "../n8n-data";
import { parsePath, resolvePath } from "../paths";
import { emitJson, progress } from "../format";
import { optionalIntOption } from "../options";

export interface GetOpts {
  node?: string;
  path?: string;
  run?: string;
  output?: string;
  item?: string;
  trace?: boolean;
  refresh?: boolean;
  cache?: boolean;
  out?: string;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export async function runGet(
  target: string,
  opts: GetOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const parsed = parseN8nUrl(target);
  if (parsed && parsed.kind === "workflow") {
    throw new CliError(
      "bad-arguments",
      "Pass an execution URL or id, not a workflow URL.",
    );
  }
  const executionId = parsed?.executionId ?? target;
  const instance = resolveInstance({
    host: parsed?.host,
    baseUrl: parsed?.baseUrl,
  });
  const client = clientFactory(instance);
  const quiet = opts.quiet ?? false;

  if (opts.trace) {
    return runTrace(executionId, instance, client, opts);
  }

  progress(`Fetching execution ${executionId}...`, quiet);
  const raw = await getExecutionCached(client, instance.host, executionId, {
    refresh: opts.refresh ?? false,
    noCache: opts.cache === false,
  });
  const info = extractExecutionInfo(raw, instance.baseUrl);
  const data = normalizeExecutionData(raw);

  let payload: unknown;

  if (!opts.node) {
    const summaries = extractNodeSummaries(data);
    payload = {
      execution: info,
      nodes: summaries,
      summary: {
        nodeCount: summaries.length,
        lastNodeExecuted: data?.resultData?.lastNodeExecuted ?? null,
      },
    };
  } else {
    const runFilter = optionalIntOption("run", opts.run);
    const outputFilter = optionalIntOption("output", opts.output);
    const itemFilter = optionalIntOption("item", opts.item);
    const units = extractSearchUnits(data, opts.node).filter(
      (u) =>
        (runFilter === undefined || u.runIndex === runFilter) &&
        (outputFilter === undefined || u.outputIndex === outputFilter) &&
        (itemFilter === undefined || u.itemIndex === itemFilter),
    );
    if (units.length === 0) {
      throw new CliError(
        "bad-arguments",
        `Node "${opts.node}" produced no matching items in execution ${executionId}.`,
      );
    }

    const pathSegments = opts.path ? parsePath(opts.path) : null;
    const items = units.map((u) => {
      let value: unknown = u.json;
      if (pathSegments) {
        const resolved = resolvePath(u.json, pathSegments);
        value = resolved.found ? resolved.value : undefined;
      }
      return {
        runIndex: u.runIndex,
        outputIndex: u.outputIndex,
        itemIndex: u.itemIndex,
        value,
      };
    });

    if (pathSegments && items.every((i) => i.value === undefined)) {
      throw new CliError(
        "bad-arguments",
        `Path "${opts.path}" resolved to nothing in node "${opts.node}".`,
      );
    }

    payload = { execution: info, node: opts.node, items };
  }

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(payload, null, 2) + "\n");
    progress(`Wrote output to ${opts.out}`, quiet);
  } else {
    emitJson(payload);
  }
  return 0;
}

const TRACE_DEPTH_CAP = 20;

interface TraceEntry {
  executionId: string;
  workflowId: string;
  workflowName: string | null;
  status: string;
  mode: string;
  startedAt: string | null;
  url: string;
  triggeredBy: ParentExecutionRef | null;
}

async function runTrace(
  executionId: string,
  instance: ResolvedInstance,
  client: N8nClient,
  opts: GetOpts,
): Promise<number> {
  const quiet = opts.quiet ?? false;
  const chain: TraceEntry[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let currentId: string | undefined = executionId;

  while (currentId && !seen.has(currentId)) {
    if (chain.length >= TRACE_DEPTH_CAP) {
      truncated = true;
      break;
    }
    seen.add(currentId);
    progress(`Fetching execution ${currentId}...`, quiet);
    const raw = await getExecutionCached(client, instance.host, currentId, {
      refresh: opts.refresh ?? false,
      noCache: opts.cache === false,
    });
    const info = extractExecutionInfo(raw, instance.baseUrl);
    let parent: ParentExecutionRef | null = null;
    try {
      parent = extractParentExecution(normalizeExecutionData(raw));
    } catch {
      // Execution data pruned: the chain ends here.
    }
    chain.push({
      executionId: info.id,
      workflowId: info.workflowId,
      workflowName: (raw as any)?.workflowData?.name ?? null,
      status: info.status,
      mode: info.mode,
      startedAt: info.startedAt,
      url: info.url,
      triggeredBy: parent,
    });
    currentId = parent?.executionId;
  }

  // Root first, so the chain reads in trigger order.
  chain.reverse();
  const root = chain[0];
  const payload = {
    execution: { id: executionId },
    trace: chain,
    summary: {
      depth: chain.length,
      truncated,
      root: root
        ? {
            executionId: root.executionId,
            workflowId: root.workflowId,
            workflowName: root.workflowName,
            mode: root.mode,
            url: root.url,
          }
        : null,
    },
  };

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(payload, null, 2) + "\n");
    progress(`Wrote output to ${opts.out}`, quiet);
  } else {
    emitJson(payload);
  }
  return 0;
}
