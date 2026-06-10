import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performSessionLogin, SessionManager } from "../src/session";
import { loadConfig, upsertInstance } from "../src/config";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-session-"));
  process.env.N8N_HELPER_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
});

function loginResponse(cookie = "n8n-auth=tok123"): Response {
  return new Response("{}", {
    status: 200,
    headers: { "set-cookie": `${cookie}; Path=/; HttpOnly; Secure` },
  });
}

test("performSessionLogin posts credentials and extracts the n8n-auth cookie", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const cookie = await performSessionLogin({
    baseUrl: "https://h.co/",
    email: "a@b.co",
    password: "pw",
    browserId: "bid-1",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return loginResponse();
    },
  });
  expect(cookie).toBe("n8n-auth=tok123");
  expect(captured!.url).toBe("https://h.co/rest/login");
  const headers = captured!.init!.headers as Record<string, string>;
  expect(headers["browser-id"]).toBe("bid-1");
  expect(JSON.parse(String(captured!.init!.body))).toEqual({
    emailOrLdapLoginId: "a@b.co",
    password: "pw",
  });
});

test("performSessionLogin maps 401 to unauthorized", async () => {
  await expect(
    performSessionLogin({
      baseUrl: "https://h.co",
      email: "a@b.co",
      password: "bad",
      browserId: "bid",
      fetchImpl: async () => new Response("{}", { status: 401 }),
    }),
  ).rejects.toMatchObject({ code: "unauthorized" });
});

test("performSessionLogin errors when no auth cookie is returned", async () => {
  await expect(
    performSessionLogin({
      baseUrl: "https://h.co",
      email: "a@b.co",
      password: "pw",
      browserId: "bid",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    }),
  ).rejects.toMatchObject({ code: "n8n-error" });
});

test("SessionManager.getCookie returns the persisted cookie without logging in", async () => {
  upsertInstance(
    "h.co",
    { baseUrl: "https://h.co", apiKey: "K", sessionCookie: "n8n-auth=saved" },
    true,
  );
  const manager = new SessionManager("h.co", "https://h.co", async () => {
    throw new Error("should not fetch");
  });
  expect(await manager.getCookie()).toBe("n8n-auth=saved");
});

test("SessionManager.getCookie logs in with saved credentials and persists cookie + browserId", async () => {
  upsertInstance(
    "h.co",
    { baseUrl: "https://h.co", apiKey: "K", email: "a@b.co", password: "pw" },
    true,
  );
  let logins = 0;
  const manager = new SessionManager("h.co", "https://h.co", async () => {
    logins++;
    return loginResponse("n8n-auth=fresh");
  });
  const [first, second] = await Promise.all([
    manager.getCookie(),
    manager.getCookie(),
  ]);
  expect(first).toBe("n8n-auth=fresh");
  expect(second).toBe("n8n-auth=fresh");
  expect(logins).toBe(1); // concurrent callers share one login
  const stored = loadConfig().instances["h.co"];
  expect(stored.sessionCookie).toBe("n8n-auth=fresh");
  expect(stored.browserId).toBeTruthy();
});

test("SessionManager.getCookie returns null without cookie or credentials", async () => {
  upsertInstance("h.co", { baseUrl: "https://h.co", apiKey: "K" }, true);
  const manager = new SessionManager("h.co", "https://h.co");
  expect(await manager.getCookie()).toBeNull();
  expect(manager.hasCredentials()).toBe(false);
});

test("SessionManager.refreshCookie replaces a stale cookie via re-login", async () => {
  upsertInstance(
    "h.co",
    {
      baseUrl: "https://h.co",
      apiKey: "K",
      email: "a@b.co",
      password: "pw",
      browserId: "bid-keep",
      sessionCookie: "n8n-auth=stale",
    },
    true,
  );
  let sentBrowserId: string | undefined;
  const manager = new SessionManager("h.co", "https://h.co", async (_url, init) => {
    sentBrowserId = (init!.headers as Record<string, string>)["browser-id"];
    return loginResponse("n8n-auth=renewed");
  });
  expect(await manager.getCookie()).toBe("n8n-auth=stale");
  expect(await manager.refreshCookie()).toBe("n8n-auth=renewed");
  expect(sentBrowserId).toBe("bid-keep");
  expect(loadConfig().instances["h.co"].sessionCookie).toBe("n8n-auth=renewed");
});
