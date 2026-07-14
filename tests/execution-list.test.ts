import { expect, test } from "bun:test";
import { collectTimeFilteredExecutions } from "../src/execution-list";
import { CliError } from "../src/types";

const instance = {
  host: "h.co",
  baseUrl: "https://h.co",
  apiKey: "K",
};

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    hasSession: () => true,
    hasCredentials: () => false,
    getCookie: async () => "n8n-auth=saved",
    getBrowserId: () => "bid",
    refreshCookie: async () => null,
    ...overrides,
  } as any;
}

test("collectTimeFilteredExecutions explains how to add a missing session", async () => {
  const client = { listExecutionsInternal: async () => ({}) };
  try {
    await collectTimeFilteredExecutions({
      client: client as any,
      session: fakeSession({ hasSession: () => false }),
      instance,
      workflowId: "WF",
      window: { from: "2026-07-14T06:00:00.000Z" },
      maxResults: 20,
    });
    throw new Error("should have thrown");
  } catch (error) {
    const err = error as CliError;
    expect(err.code).toBe("no-session");
    expect(err.hint).toContain(
      "n8n-helper login --url https://h.co --email <email>",
    );
  }
});

test("collectTimeFilteredExecutions paginates with lastId and respects the result limit", async () => {
  const calls: any[] = [];
  const pages = [
    [{ id: "30" }, { id: "29" }],
    [{ id: "28" }, { id: "27" }],
  ];
  const client = {
    listExecutionsInternal: async (params: any, auth: any) => {
      calls.push({ params, auth });
      return { results: pages[calls.length - 1], count: 4, estimated: false };
    },
  };

  const result = await collectTimeFilteredExecutions({
    client: client as any,
    session: fakeSession(),
    instance,
    workflowId: "WF",
    status: "error",
    window: {
      from: "2026-07-14T06:00:00.000Z",
      to: "2026-07-14T07:00:00.000Z",
    },
    maxResults: 3,
    pageSize: 2,
  });

  expect(result.data.map((row) => row.id)).toEqual(["30", "29", "28"]);
  expect(result.total).toBe(4);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({
    params: {
      workflowId: "WF",
      status: "error",
      startedAfter: "2026-07-14T06:00:00.000Z",
      startedBefore: "2026-07-14T07:00:00.000Z",
      limit: 2,
      lastId: undefined,
    },
    auth: { cookie: "n8n-auth=saved", browserId: "bid" },
  });
  expect(calls[1].params.lastId).toBe("29");
});

test("collectTimeFilteredExecutions refreshes once after a 401", async () => {
  let calls = 0;
  let refreshes = 0;
  let currentCookie = "n8n-auth=stale";
  const client = {
    listExecutionsInternal: async (_params: any, auth: any) => {
      calls++;
      if (auth.cookie === "n8n-auth=stale") {
        throw new CliError("unauthorized", "expired");
      }
      return { results: [{ id: "1" }], count: 1, estimated: false };
    },
  };
  const session = fakeSession({
    hasCredentials: () => true,
    getCookie: async () => currentCookie,
    refreshCookie: async () => {
      refreshes++;
      currentCookie = "n8n-auth=fresh";
      return currentCookie;
    },
  });

  const result = await collectTimeFilteredExecutions({
    client: client as any,
    session,
    instance,
    workflowId: "WF",
    window: { from: "2026-07-14T06:00:00.000Z" },
    maxResults: 20,
  });

  expect(result.data.map((row) => row.id)).toEqual(["1"]);
  expect(calls).toBe(2);
  expect(refreshes).toBe(1);
});

test("collectTimeFilteredExecutions adds setup guidance when refresh fails", async () => {
  const client = {
    listExecutionsInternal: async () => {
      throw new CliError("unauthorized", "expired");
    },
  };
  const session = fakeSession({
    hasCredentials: () => true,
    refreshCookie: async () => null,
  });
  try {
    await collectTimeFilteredExecutions({
      client: client as any,
      session,
      instance,
      workflowId: "WF",
      window: { to: "2026-07-14T07:00:00.000Z" },
      maxResults: 20,
    });
    throw new Error("should have thrown");
  } catch (error) {
    const err = error as CliError;
    expect(err.code).toBe("unauthorized");
    expect(err.hint).toContain("n8n-helper login");
  }
});

test("collectTimeFilteredExecutions adds setup guidance when initial login fails", async () => {
  const client = { listExecutionsInternal: async () => ({}) };
  const session = fakeSession({
    hasCredentials: () => true,
    getCookie: async () => {
      throw new CliError("unauthorized", "bad login");
    },
  });
  try {
    await collectTimeFilteredExecutions({
      client: client as any,
      session,
      instance,
      workflowId: "WF",
      window: { from: "2026-07-14T06:00:00.000Z" },
      maxResults: 20,
    });
    throw new Error("should have thrown");
  } catch (error) {
    const err = error as CliError;
    expect(err.code).toBe("unauthorized");
    expect(err.message).toBe("bad login");
    expect(err.hint).toContain("n8n-helper login");
  }
});

test("collectTimeFilteredExecutions does not add login guidance to server errors", async () => {
  const client = {
    listExecutionsInternal: async () => {
      throw new CliError("n8n-error", "HTTP 500");
    },
  };
  try {
    await collectTimeFilteredExecutions({
      client: client as any,
      session: fakeSession(),
      instance,
      workflowId: "WF",
      window: { from: "2026-07-14T06:00:00.000Z" },
      maxResults: 20,
    });
    throw new Error("should have thrown");
  } catch (error) {
    const err = error as CliError;
    expect(err.code).toBe("n8n-error");
    expect(err.hint).toBeUndefined();
  }
});
