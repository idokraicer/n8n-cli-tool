import { CliError, type WorkflowDefinition } from "./types";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  maxRetries?: number;
  retryBaseMs?: number;
}

interface ListResponse {
  data: any[];
  nextCursor: string | null;
}

export interface InternalExecutionListParams {
  workflowId: string;
  status?: string;
  startedAfter?: string;
  startedBefore?: string;
  limit: number;
  lastId?: string;
}

export interface InternalExecutionListResponse {
  results: any[];
  count: number;
  estimated: boolean;
}

interface RequestOptions {
  query?: Record<string, string | undefined>;
  method?: string;
  body?: unknown;
}

function statusToCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "n8n-error";
}

// n8n error responses carry the real reason in a `message` field (e.g.
// "request/body/settings must NOT have additional properties"). Pull it out so
// the CLI surfaces it instead of a bare status code.
function extractApiMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim() || undefined;
  if (body && typeof body === "object") {
    const message = (body as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
}

function apiErrorHint(
  code: string,
  status: number,
  detail: string | undefined,
): string | undefined {
  if (code === "unauthorized")
    return "n8n rejected the API key — check N8N_API_KEY or re-run `n8n-helper login`.";
  if (code === "forbidden")
    return "The API key lacks permission for this resource on this instance.";
  if (code === "not-found")
    return "No workflow/resource with that id on this instance — verify the id (or run a search/list first).";
  if (code === "rate-limited")
    return "n8n rate-limited the request; retry in a moment.";
  if (status === 400)
    return detail
      ? `n8n rejected the request body: ${detail}. Fix that field (or, on push, it may need stripping before PUT).`
      : "n8n rejected the request body (400); see `details` for the exact field it objected to.";
  return undefined;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class N8nClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
  }

  private async request<T>(
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      "X-N8N-API-KEY": this.apiKey,
      Accept: "application/json",
    };
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: opts.method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        throw new CliError(
          "network-error",
          `Request to ${url.pathname} failed: ${(err as Error).message}`,
        );
      }
      clearTimeout(timer);

      if (response.status === 429 && attempt < this.maxRetries) {
        await new Promise((r) =>
          setTimeout(r, this.retryBaseMs * 2 ** attempt),
        );
        continue;
      }

      if (!response.ok) {
        const errorBody = await parseResponseBody(response);
        const detail = extractApiMessage(errorBody);
        const code = statusToCode(response.status);
        throw new CliError(
          code,
          `n8n API error ${response.status} on ${url.pathname}${detail ? `: ${detail}` : ""}`,
          errorBody ?? undefined,
          apiErrorHint(code, response.status, detail),
        );
      }

      return (await response.json()) as T;
    }
  }

  getExecution(id: string): Promise<any> {
    return this.request<any>(`/executions/${encodeURIComponent(id)}`, {
      query: { includeData: "true" },
    });
  }

  listExecutions(params: {
    workflowId?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListResponse> {
    return this.request<ListResponse>("/executions", {
      query: {
        workflowId: params.workflowId,
        status: params.status,
        limit: params.limit ? String(params.limit) : undefined,
        cursor: params.cursor,
      },
    });
  }

  async listExecutionsInternal(
    params: InternalExecutionListParams,
    auth: { cookie: string; browserId: string },
  ): Promise<InternalExecutionListResponse> {
    const url = new URL(`${this.baseUrl}/rest/executions`);
    url.searchParams.set(
      "filter",
      JSON.stringify({
        workflowId: params.workflowId,
        ...(params.status ? { status: [params.status] } : {}),
        ...(params.startedAfter
          ? { startedAfter: params.startedAfter }
          : {}),
        ...(params.startedBefore
          ? { startedBefore: params.startedBefore }
          : {}),
      }),
    );
    url.searchParams.set("limit", String(params.limit));
    if (params.lastId) url.searchParams.set("lastId", params.lastId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: {
          Accept: "application/json",
          Cookie: auth.cookie,
          "browser-id": auth.browserId,
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new CliError(
        "network-error",
        `Request to ${url.pathname} failed: ${(err as Error).message}`,
      );
    }
    clearTimeout(timer);

    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new CliError(
        statusToCode(response.status),
        `n8n execution list failed: HTTP ${response.status}`,
        body ?? undefined,
      );
    }
    const data = (body as any)?.data;
    if (!data || !Array.isArray(data.results)) {
      throw new CliError(
        "n8n-error",
        "n8n returned an invalid response from /rest/executions.",
        body ?? undefined,
      );
    }
    return {
      results: data.results,
      count: Number(data.count ?? data.results.length),
      estimated: Boolean(data.estimated),
    };
  }

  async retryExecution(
    id: string,
    opts: { loadWorkflow?: boolean; cookie?: string } = {},
  ): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}/rest/executions/${encodeURIComponent(id)}/retry`;
    const headers: Record<string, string> = {
      "X-N8N-API-KEY": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.cookie) headers.Cookie = opts.cookie;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ loadWorkflow: opts.loadWorkflow ?? false }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new CliError(
        "network-error",
        `Retry request for execution ${id} failed: ${(err as Error).message}`,
      );
    }
    clearTimeout(timer);
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new CliError(
        statusToCode(response.status),
        `n8n retry failed for execution ${id}: HTTP ${response.status}`,
        body,
      );
    }
    return { status: response.status, body };
  }

  listWorkflows(params: {
    limit?: number;
    cursor?: string;
    active?: boolean;
  }): Promise<ListResponse> {
    return this.request<ListResponse>("/workflows", {
      query: {
        limit: params.limit ? String(params.limit) : undefined,
        cursor: params.cursor,
        active: params.active === undefined ? undefined : String(params.active),
      },
    });
  }

  getWorkflow(id: string): Promise<WorkflowDefinition> {
    return this.request<WorkflowDefinition>(
      `/workflows/${encodeURIComponent(id)}`,
      {},
    );
  }

  updateWorkflow(
    id: string,
    body: Partial<WorkflowDefinition>,
  ): Promise<WorkflowDefinition> {
    return this.request<WorkflowDefinition>(
      `/workflows/${encodeURIComponent(id)}`,
      { method: "PUT", body },
    );
  }

  createWorkflow(
    body: Partial<WorkflowDefinition>,
  ): Promise<WorkflowDefinition> {
    return this.request<WorkflowDefinition>("/workflows", {
      method: "POST",
      body,
    });
  }

  async runWorkflow(
    id: string,
    payload: unknown,
    opts: { cookie: string; browserId?: string },
  ): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}/rest/workflows/${encodeURIComponent(id)}/run`;
    const headers: Record<string, string> = {
      "X-N8N-API-KEY": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: opts.cookie,
    };
    // /rest/workflows/:id/run binds the session to the login browser-id and
    // rejects the request (401) without this header.
    if (opts.browserId) headers["browser-id"] = opts.browserId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new CliError(
        "network-error",
        `Run request for workflow ${id} failed: ${(err as Error).message}`,
      );
    }
    clearTimeout(timer);
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new CliError(
        statusToCode(response.status),
        `n8n workflow run failed for workflow ${id}: HTTP ${response.status}`,
        body,
      );
    }
    return { status: response.status, body };
  }

  async sendWebhook(
    url: string,
    opts: { method: string; body?: unknown },
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const hasBody = opts.body !== undefined;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (hasBody) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new CliError(
        "network-error",
        `Webhook request to ${url} failed: ${(err as Error).message}`,
      );
    }
    clearTimeout(timer);
    const parsedBody = await parseResponseBody(response);
    if (!response.ok) {
      throw new CliError(
        statusToCode(response.status),
        `Webhook request failed: HTTP ${response.status}`,
        parsedBody,
      );
    }
    return { status: response.status, body: parsedBody };
  }
}
