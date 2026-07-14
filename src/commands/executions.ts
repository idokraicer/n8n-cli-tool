import { CliError, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { parseN8nUrl, buildWorkflowUrl, buildExecutionUrl } from "../url";
import { emitJson, progress } from "../format";
import { requireIntOption } from "../options";
import { SessionManager } from "../session";
import { collectTimeFilteredExecutions, type ExecutionListSession } from "../execution-list";
import { parseTimeWindow, type TimeWindowOpts } from "../time-window";

export interface ExecutionsOpts extends TimeWindowOpts {
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
type SessionFactory = (instance: ResolvedInstance) => ExecutionListSession;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });
const defaultSessionFactory: SessionFactory = (instance) =>
  new SessionManager(instance.host, instance.baseUrl);

const ALL_CAP = 1000;

export async function runExecutions(
  target: string,
  opts: ExecutionsOpts,
  clientFactory: ClientFactory = defaultClientFactory,
  sessionFactory: SessionFactory = defaultSessionFactory,
): Promise<number> {
  const timeWindow = parseTimeWindow(opts);
  if (timeWindow && opts.cursor) {
    throw new CliError(
      "bad-arguments",
      "--cursor cannot be combined with execution time filters; use --all to retrieve the full window.",
    );
  }
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
  const limit = requireIntOption("limit", opts.limit ?? "20");

  progress(`Listing executions for workflow ${workflowId}...`, quiet);

  let rows: any[];
  let nextCursor: string | null = null;
  if (timeWindow) {
    const result = await collectTimeFilteredExecutions({
      client,
      session: sessionFactory(instance),
      instance,
      workflowId,
      status: opts.status,
      window: timeWindow,
      maxResults: opts.all ? ALL_CAP : limit,
      pageSize: limit || undefined,
    });
    rows = result.data;
  } else {
    rows = [];
    let cursor = opts.cursor;
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
  }

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
    ...(timeWindow ? { timeWindow } : {}),
    nextCursor,
    summary: { count: rows.length },
  });
  return 0;
}
