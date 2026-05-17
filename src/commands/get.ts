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
