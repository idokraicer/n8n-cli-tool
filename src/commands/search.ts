import { writeFileSync } from "node:fs";
import {
  CliError,
  type Match,
  type MatchMode,
  type ResolvedInstance,
} from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { parseN8nUrl, classifyBareId } from "../url";
import { getExecutionCached } from "../exec-cache";
import {
  normalizeExecutionData,
  extractSearchUnits,
  extractExecutionInfo,
} from "../n8n-data";
import { searchUnits, type SearchOptions } from "../search";
import { emitJson, progress } from "../format";

export interface SearchCmdOpts {
  node?: string;
  exact?: boolean;
  regex?: boolean;
  caseSensitive?: boolean;
  limit?: string;
  status?: "success" | "error" | "waiting";
  maxMatches?: string;
  context?: boolean;
  truncate?: string | false;
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

function resolveMode(opts: SearchCmdOpts): MatchMode {
  const chosen = [opts.exact && "exact", opts.regex && "regex"].filter(Boolean);
  if (chosen.length > 1) {
    throw new CliError(
      "bad-arguments",
      "Use only one of --exact or --regex.",
    );
  }
  if (opts.exact) return "exact";
  if (opts.regex) return "regex";
  return "substring";
}

async function searchOneExecution(
  client: N8nClient,
  host: string,
  baseUrl: string,
  executionId: string,
  value: string,
  searchOpts: SearchOptions,
  cacheOpts: { refresh: boolean; noCache: boolean },
): Promise<{ matches: Match[]; itemsSearched: number; nodesSearched: number; truncated: boolean }> {
  const raw = await getExecutionCached(client, host, executionId, cacheOpts);
  const info = extractExecutionInfo(raw, baseUrl);
  const data = normalizeExecutionData(raw);
  const units = extractSearchUnits(data, searchOpts.node);
  const result = searchUnits(units, value, searchOpts, {
    executionId: info.id,
    url: info.url,
  });
  const nodes = new Set(units.map((u) => u.node));
  return {
    matches: result.matches,
    itemsSearched: result.itemsSearched,
    nodesSearched: nodes.size,
    truncated: result.truncated,
  };
}

export async function runSearch(
  value: string,
  target: string,
  opts: SearchCmdOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveMode(opts);
  const quiet = opts.quiet ?? false;

  const parsed = parseN8nUrl(target);
  const instance = resolveInstance({
    host: parsed?.host,
    baseUrl: parsed?.baseUrl,
  });
  const client = clientFactory(instance);

  const kind = parsed ? parsed.kind : classifyBareId(target);
  const searchOpts: SearchOptions = {
    mode,
    caseSensitive: opts.caseSensitive ?? false,
    node: opts.node,
    maxMatches: Number(opts.maxMatches ?? "100"),
    context: opts.context ?? false,
    truncate: opts.truncate === false ? null : Number(opts.truncate ?? "200"),
  };
  const cacheOpts = {
    refresh: opts.refresh ?? false,
    noCache: opts.cache === false,
  };

  const allMatches: Match[] = [];
  let itemsSearched = 0;
  let nodesSearched = 0;
  let executionsSearched = 0;
  let truncated = false;

  if (kind === "execution") {
    const executionId = parsed?.executionId ?? target;
    progress(`Searching execution ${executionId}...`, quiet);
    const r = await searchOneExecution(
      client,
      instance.host,
      instance.baseUrl,
      executionId,
      value,
      searchOpts,
      cacheOpts,
    );
    allMatches.push(...r.matches);
    itemsSearched = r.itemsSearched;
    nodesSearched = r.nodesSearched;
    executionsSearched = 1;
    truncated = r.truncated;
  } else {
    const workflowId = parsed?.workflowId ?? target;
    const limit = Number(opts.limit ?? "20");
    progress(
      `Listing up to ${limit} executions for workflow ${workflowId}...`,
      quiet,
    );
    const page = await client.listExecutions({
      workflowId,
      status: opts.status,
      limit,
    });
    progress(`Searching ${page.data.length} executions...`, quiet);

    let index = 0;
    const concurrency = 5;
    const ids = page.data.map((e: any) => String(e.id));
    async function worker(): Promise<void> {
      while (index < ids.length && allMatches.length < searchOpts.maxMatches) {
        const id = ids[index++];
        const r = await searchOneExecution(
          client,
          instance.host,
          instance.baseUrl,
          id,
          value,
          searchOpts,
          cacheOpts,
        );
        allMatches.push(...r.matches);
        itemsSearched += r.itemsSearched;
        nodesSearched += r.nodesSearched;
        executionsSearched++;
        if (r.truncated) truncated = true;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ids.length) }, worker),
    );
  }

  const capped = allMatches.slice(0, searchOpts.maxMatches);
  if (allMatches.length > capped.length) truncated = true;

  const payload = {
    query: { value, mode, caseSensitive: searchOpts.caseSensitive },
    scope:
      kind === "execution"
        ? {
            type: "execution",
            executionId: parsed?.executionId ?? target,
          }
        : { type: "workflow", workflowId: parsed?.workflowId ?? target },
    matches: capped,
    summary: {
      matchCount: capped.length,
      executionsSearched,
      nodesSearched,
      itemsSearched,
      truncated,
    },
  };

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(payload, null, 2) + "\n");
    progress(`Wrote results to ${opts.out}`, quiet);
  } else {
    emitJson(payload);
  }

  return capped.length > 0 ? 0 : 1;
}
