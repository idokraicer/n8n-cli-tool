import { CliError, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { parseN8nUrl, buildWorkflowUrl, buildExecutionUrl } from "../url";
import { emitJson, progress } from "../format";

export interface ExecutionsOpts {
  status?: "success" | "error" | "waiting";
  limit?: string;
  cursor?: string;
  all?: boolean;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

const ALL_CAP = 1000;

export async function runExecutions(
  target: string,
  opts: ExecutionsOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const parsed = parseN8nUrl(target);
  if (parsed && parsed.kind === "execution") {
    throw new CliError(
      "bad-arguments",
      "Pass a workflow URL or id, not an execution URL.",
    );
  }
  const workflowId = parsed ? parsed.workflowId : target;
  const instance = resolveInstance({
    host: parsed?.host,
    baseUrl: parsed?.baseUrl,
  });
  const client = clientFactory(instance);
  const quiet = opts.quiet ?? false;
  const limit = Number(opts.limit ?? "20");

  progress(`Listing executions for workflow ${workflowId}...`, quiet);

  const rows: any[] = [];
  let cursor = opts.cursor;
  let nextCursor: string | null = null;
  do {
    const page = await client.listExecutions({
      workflowId,
      status: opts.status,
      limit,
      cursor,
    });
    rows.push(...page.data);
    nextCursor = page.nextCursor;
    cursor = page.nextCursor ?? undefined;
  } while (opts.all && cursor && rows.length < ALL_CAP);

  emitJson({
    instance: instance.host,
    workflow: {
      id: workflowId,
      url: buildWorkflowUrl(instance.baseUrl, workflowId),
    },
    executions: rows.map((e) => ({
      id: String(e.id),
      status: e.status ?? "unknown",
      mode: e.mode ?? "unknown",
      finished: Boolean(e.finished),
      startedAt: e.startedAt ?? null,
      stoppedAt: e.stoppedAt ?? null,
      url: buildExecutionUrl(instance.baseUrl, workflowId, String(e.id)),
    })),
    nextCursor: opts.all ? null : nextCursor,
    summary: { count: rows.length },
  });
  return 0;
}
