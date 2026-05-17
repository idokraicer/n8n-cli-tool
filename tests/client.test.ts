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
