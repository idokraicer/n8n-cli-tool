import { N8nClient } from "./client";
import { SessionManager } from "./session";
import { CliError, type ResolvedInstance } from "./types";
import type { TimeWindow } from "./time-window";

export type ExecutionListSession = Pick<
  SessionManager,
  | "hasSession"
  | "hasCredentials"
  | "getCookie"
  | "getBrowserId"
  | "refreshCookie"
>;

export interface CollectTimeFilteredExecutionsInput {
  client: Pick<N8nClient, "listExecutionsInternal">;
  session: ExecutionListSession;
  instance: ResolvedInstance;
  workflowId: string;
  status?: string;
  window: TimeWindow;
  maxResults: number;
  pageSize?: number;
}

export interface TimeFilteredExecutionResult {
  data: any[];
  total: number;
  estimated: boolean;
}

function sessionHint(baseUrl: string): string {
  return `Run \`n8n-helper login --url ${baseUrl} --email <email>\` to save an n8n browser session.`;
}

function noSessionError(baseUrl: string): CliError {
  return new CliError(
    "no-session",
    "Execution time filters require an authenticated n8n browser session.",
    undefined,
    sessionHint(baseUrl),
  );
}

function withSessionHint(error: unknown, baseUrl: string): CliError {
  if (error instanceof CliError) {
    return new CliError(
      error.code,
      error.message,
      error.details,
      error.hint ?? sessionHint(baseUrl),
    );
  }
  return new CliError(
    "unauthorized",
    `n8n session authentication failed: ${(error as Error).message}`,
    undefined,
    sessionHint(baseUrl),
  );
}

export async function collectTimeFilteredExecutions(
  input: CollectTimeFilteredExecutionsInput,
): Promise<TimeFilteredExecutionResult> {
  const { session, instance } = input;
  if (!session.hasSession()) throw noSessionError(instance.baseUrl);

  let cookie: string | null;
  try {
    cookie = await session.getCookie();
  } catch (error) {
    throw withSessionHint(error, instance.baseUrl);
  }
  let browserId = session.getBrowserId();
  if ((!cookie || !browserId) && session.hasCredentials()) {
    try {
      cookie = await session.refreshCookie();
      browserId = session.getBrowserId();
    } catch (error) {
      throw withSessionHint(error, instance.baseUrl);
    }
  }
  if (!cookie || !browserId) throw noSessionError(instance.baseUrl);

  const data: any[] = [];
  let total = 0;
  let estimated = false;
  let lastId: string | undefined;
  let refreshed = false;
  const configuredPageSize = Math.max(1, Math.min(input.pageSize ?? 100, 100));

  while (data.length < input.maxResults) {
    const limit = Math.min(configuredPageSize, input.maxResults - data.length);
    let page;
    try {
      page = await input.client.listExecutionsInternal(
        {
          workflowId: input.workflowId,
          status: input.status,
          startedAfter: input.window.from,
          startedBefore: input.window.to,
          limit,
          lastId,
        },
        { cookie, browserId },
      );
    } catch (error) {
      if (
        !refreshed &&
        error instanceof CliError &&
        error.code === "unauthorized" &&
        session.hasCredentials()
      ) {
        refreshed = true;
        try {
          const fresh = await session.refreshCookie();
          const freshBrowserId = session.getBrowserId();
          if (!fresh || !freshBrowserId) {
            throw withSessionHint(error, instance.baseUrl);
          }
          cookie = fresh;
          browserId = freshBrowserId;
          continue;
        } catch (refreshError) {
          throw withSessionHint(refreshError, instance.baseUrl);
        }
      }
      if (error instanceof CliError && error.code === "unauthorized") {
        throw withSessionHint(error, instance.baseUrl);
      }
      throw error;
    }

    total = page.count;
    estimated = page.estimated;
    if (page.results.length === 0) break;
    data.push(...page.results.slice(0, input.maxResults - data.length));
    const nextLastId = String(page.results.at(-1)?.id ?? "");
    if (!nextLastId || nextLastId === lastId || page.results.length < limit) break;
    lastId = nextLastId;
  }

  return { data, total, estimated };
}
