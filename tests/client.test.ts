import { test, expect } from "bun:test";
import { N8nClient } from "../src/client";
import { CliError } from "../src/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): N8nClient {
  return new N8nClient({
    baseUrl: "https://h.co",
    apiKey: "K",
    fetchImpl,
  });
}

test("getExecution requests the right URL with the API key header", async () => {
  let seenUrl = "";
  let seenKey = "";
  const client = clientWith(async (url, init) => {
    seenUrl = String(url);
    seenKey = (init?.headers as Record<string, string>)["X-N8N-API-KEY"];
    return jsonResponse({ id: 5 });
  });
  const result = await client.getExecution("5");
  expect(seenUrl).toBe("https://h.co/api/v1/executions/5?includeData=true");
  expect(seenKey).toBe("K");
  expect(result).toEqual({ id: 5 });
});

test("listWorkflows returns data and nextCursor", async () => {
  const client = clientWith(async () =>
    jsonResponse({ data: [{ id: "A" }], nextCursor: "C" }),
  );
  expect(await client.listWorkflows({ limit: 10 })).toEqual({
    data: [{ id: "A" }],
    nextCursor: "C",
  });
});

test("a 401 maps to a CliError with code unauthorized", async () => {
  const client = clientWith(async () => jsonResponse({}, 401));
  try {
    await client.getExecution("5");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("unauthorized");
  }
});

test("a 404 maps to code not-found", async () => {
  const client = clientWith(async () => jsonResponse({}, 404));
  try {
    await client.getExecution("5");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("not-found");
  }
});

test("a 429 is retried then succeeds", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls++;
    return calls < 2 ? jsonResponse({}, 429) : jsonResponse({ id: 5 });
  });
  const result = await client.getExecution("5");
  expect(calls).toBe(2);
  expect(result).toEqual({ id: 5 });
});

test("429s past the retry limit throw rate-limited", async () => {
  const client = new N8nClient({
    baseUrl: "https://h.co",
    apiKey: "K",
    fetchImpl: async () => jsonResponse({}, 429),
    maxRetries: 2,
    retryBaseMs: 1,
  });
  try {
    await client.getExecution("5");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("rate-limited");
  }
});

test("a 403 maps to code forbidden", async () => {
  const client = clientWith(async () => jsonResponse({}, 403));
  try {
    await client.getExecution("5");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("forbidden");
  }
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  return async (url: string, init?: RequestInit) => handler(url, init);
}

test("getWorkflow GETs /api/v1/workflows/:id and returns the body", async () => {
  let seenUrl = "";
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch((url) => { seenUrl = url; return new Response(JSON.stringify({ id: "W1", name: "Foo", nodes: [], connections: {} }), { status: 200 }); }),
  });
  const wf = await client.getWorkflow("W1");
  expect(seenUrl).toBe("https://n8n.test/api/v1/workflows/W1");
  expect(wf.name).toBe("Foo");
});

test("updateWorkflow PUTs the body with the api key header", async () => {
  let method = ""; let body = ""; let key = "";
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch((url, init) => { void url; method = init!.method!; body = init!.body as string; key = (init!.headers as any)["X-N8N-API-KEY"]; return new Response(JSON.stringify({ id: "W1", name: "Foo", nodes: [], connections: {} }), { status: 200 }); }),
  });
  await client.updateWorkflow("W1", { name: "Foo", nodes: [], connections: {}, settings: {} });
  expect(method).toBe("PUT");
  expect(key).toBe("k");
  expect(JSON.parse(body).name).toBe("Foo");
});

test("runWorkflow POSTs to /rest/workflows/:id/run with the session cookie", async () => {
  let url = ""; let cookie = "";
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch((u, init) => { url = u; cookie = (init!.headers as any).Cookie; return new Response(JSON.stringify({ data: { executionId: "42" } }), { status: 200 }); }),
  });
  const res = await client.runWorkflow("W1", { workflowData: {} }, { cookie: "n8n-auth=abc" });
  expect(url).toBe("https://n8n.test/rest/workflows/W1/run");
  expect(cookie).toBe("n8n-auth=abc");
  expect(res.status).toBe(200);
});

test("runWorkflow sends the browser-id header when provided (required by /rest run)", async () => {
  let browserId: string | undefined;
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch((_u, init) => { browserId = (init!.headers as any)["browser-id"]; return new Response(JSON.stringify({ data: { executionId: "42" } }), { status: 200 }); }),
  });
  await client.runWorkflow("W1", {}, { cookie: "n8n-auth=abc", browserId: "bid-123" });
  expect(browserId).toBe("bid-123");
});

test("postWebhook POSTs the given url and returns parsed body", async () => {
  const client = new N8nClient({
    baseUrl: "https://n8n.test", apiKey: "k",
    fetchImpl: stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  });
  const res = await client.postWebhook("https://n8n.test/webhook/abc", { a: 1 });
  expect(res.status).toBe(200);
  expect((res.body as any).ok).toBe(true);
});
