import { CliError } from "./types";

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

function statusToCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "n8n-error";
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
    query: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          headers: {
            "X-N8N-API-KEY": this.apiKey,
            Accept: "application/json",
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

      if (response.status === 429 && attempt < this.maxRetries) {
        await new Promise((r) =>
          setTimeout(r, this.retryBaseMs * 2 ** attempt),
        );
        continue;
      }

      if (!response.ok) {
        throw new CliError(
          statusToCode(response.status),
          `n8n API error ${response.status} on ${url.pathname}`,
        );
      }

      return (await response.json()) as T;
    }
  }

  getExecution(id: string): Promise<any> {
    return this.request<any>(`/executions/${encodeURIComponent(id)}`, {
      includeData: "true",
    });
  }

  listExecutions(params: {
    workflowId?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListResponse> {
    return this.request<ListResponse>("/executions", {
      workflowId: params.workflowId,
      status: params.status,
      limit: params.limit ? String(params.limit) : undefined,
      cursor: params.cursor,
    });
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
    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
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
      limit: params.limit ? String(params.limit) : undefined,
      cursor: params.cursor,
      active: params.active === undefined ? undefined : String(params.active),
    });
  }
}
