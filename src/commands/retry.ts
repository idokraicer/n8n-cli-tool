import { CliError, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { SessionManager } from "../session";
import { parseN8nUrl, buildExecutionUrl, buildWorkflowUrl } from "../url";
import { emitJson, progress } from "../format";
import { requireIntOption } from "../options";

type Status = "success" | "error" | "waiting" | "crashed";

export interface RetryOpts {
  status?: Status;
  startedAfter?: string;
  startedBefore?: string;
  ids?: string;
  exclude?: string;
  limit?: string;
  loadWorkflow?: boolean;
  concurrency?: string;
  dryRun?: boolean;
  cookie?: string;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export type Session = Pick<
  SessionManager,
  "hasCredentials" | "getCookie" | "refreshCookie"
>;
type SessionFactory = (instance: ResolvedInstance) => Session;

const defaultSessionFactory: SessionFactory = (instance) =>
  new SessionManager(instance.host, instance.baseUrl);

const PAGE_CAP = 250;
const FETCH_CAP = 2000;

function parseIdList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function parseDate(name: string, raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new CliError(
      "bad-arguments",
      `--${name} must be an ISO 8601 timestamp (got "${raw}").`,
    );
  }
  return ms;
}

export async function runRetry(
  target: string,
  opts: RetryOpts,
  clientFactory: ClientFactory = defaultClientFactory,
  sessionFactory: SessionFactory = defaultSessionFactory,
): Promise<number> {
  const explicitIds = parseIdList(opts.ids);
  const excludeIds = parseIdList(opts.exclude);

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
  const concurrency = requireIntOption("concurrency", opts.concurrency ?? "5");
  if (concurrency === 0) {
    throw new CliError("bad-arguments", "--concurrency must be at least 1.");
  }
  const pageLimit = Math.min(
    requireIntOption("limit", opts.limit ?? "200"),
    PAGE_CAP,
  );
  const startedAfter = parseDate("started-after", opts.startedAfter);
  const startedBefore = parseDate("started-before", opts.startedBefore);
  const explicitCookie =
    opts.cookie ??
    process.env.N8N_SESSION_COOKIE ??
    process.env.N8N_COOKIE ??
    undefined;
  const session = explicitCookie ? null : sessionFactory(instance);
  let cookie = explicitCookie ?? (await session?.getCookie()) ?? undefined;

  let candidates: string[];

  if (explicitIds.size > 0) {
    candidates = [...explicitIds].filter((id) => !excludeIds.has(id));
    progress(`Retrying ${candidates.length} explicit execution(s)...`, quiet);
  } else {
    progress(
      `Collecting executions for workflow ${workflowId}` +
        (opts.status ? ` (status=${opts.status})` : "") +
        "...",
      quiet,
    );
    const collected: { id: string; startedAt: string | null }[] = [];
    let pageCursor: string | undefined;
    do {
      const page = await client.listExecutions({
        workflowId,
        status: opts.status,
        limit: pageLimit,
        cursor: pageCursor,
      });
      for (const row of page.data) {
        const id = String(row.id);
        const startedAt: string | null = row.startedAt ?? null;
        const startedMs = startedAt ? Date.parse(startedAt) : NaN;
        if (startedAfter !== undefined) {
          if (Number.isNaN(startedMs) || startedMs < startedAfter) continue;
        }
        if (startedBefore !== undefined) {
          if (Number.isNaN(startedMs) || startedMs > startedBefore) continue;
        }
        if (excludeIds.has(id)) continue;
        collected.push({ id, startedAt });
      }
      pageCursor = page.nextCursor ?? undefined;
      if (collected.length >= FETCH_CAP) break;
      // Stop early if we've paged past the startedAfter window (n8n returns newest-first).
      if (
        startedAfter !== undefined &&
        page.data.length > 0 &&
        page.data.every((row: any) => {
          const ms = Date.parse(row.startedAt ?? "");
          return !Number.isNaN(ms) && ms < startedAfter;
        })
      ) {
        break;
      }
    } while (pageCursor);

    candidates = collected.map((c) => c.id);
    progress(`Matched ${candidates.length} execution(s).`, quiet);
  }

  if (opts.dryRun) {
    emitJson({
      instance: instance.host,
      workflow: {
        id: workflowId,
        url: buildWorkflowUrl(instance.baseUrl, workflowId),
      },
      dryRun: true,
      count: candidates.length,
      executions: candidates.map((id) => ({
        id,
        url: buildExecutionUrl(instance.baseUrl, workflowId, id),
      })),
    });
    return 0;
  }

  type Result = {
    id: string;
    url: string;
    ok: boolean;
    status?: number;
    error?: { code: string; message: string };
  };
  const results: Result[] = [];

  // A 401 means the persisted session cookie expired: re-login once for the
  // whole run (shared across workers; /rest/login is rate-limited) and retry.
  let refreshInFlight: Promise<string | null> | null = null;
  const refreshCookie = () => {
    refreshInFlight ??= session!.refreshCookie().catch(() => null);
    return refreshInFlight;
  };
  const attemptRetry = async (id: string) => {
    try {
      return await client.retryExecution(id, {
        loadWorkflow: opts.loadWorkflow ?? false,
        cookie,
      });
    } catch (err) {
      if (
        err instanceof CliError &&
        err.code === "unauthorized" &&
        session?.hasCredentials()
      ) {
        const fresh = await refreshCookie();
        if (fresh) {
          cookie = fresh;
          return await client.retryExecution(id, {
            loadWorkflow: opts.loadWorkflow ?? false,
            cookie: fresh,
          });
        }
      }
      throw err;
    }
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= candidates.length) return;
      const id = candidates[idx];
      const url = buildExecutionUrl(instance.baseUrl, workflowId, id);
      try {
        const { status } = await attemptRetry(id);
        results.push({ id, url, ok: true, status });
        progress(`  retried ${id} (HTTP ${status})`, quiet);
      } catch (err) {
        const cliErr =
          err instanceof CliError
            ? err
            : new CliError("n8n-error", (err as Error).message);
        if (cliErr.code === "unauthorized" && !cookie) {
          cliErr.message += ` The /rest retry endpoint needs a session: run \`n8n-helper login --url ${instance.baseUrl} --email <email>\` or pass --cookie.`;
        }
        results.push({
          id,
          url,
          ok: false,
          error: { code: cliErr.code, message: cliErr.message },
        });
        progress(`  FAILED ${id}: ${cliErr.message}`, quiet);
      }
    }
  });
  await Promise.all(workers);

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  emitJson({
    instance: instance.host,
    workflow: {
      id: workflowId,
      url: buildWorkflowUrl(instance.baseUrl, workflowId),
    },
    summary: { attempted: results.length, succeeded, failed },
    results: results.sort((a, b) => a.id.localeCompare(b.id)),
  });
  return failed === 0 ? 0 : 1;
}
