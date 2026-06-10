import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "../src/commands/login";
import { loadConfig } from "../src/config";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-login-"));
  process.env.N8N_HELPER_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
});

test("runLogin validates the key and stores the instance", async () => {
  const validate = async (_baseUrl: string, _key: string) => true;
  const code = await runLogin(
    { url: "https://n8n.h.co", key: "K", json: true, quiet: true },
    validate,
  );
  expect(code).toBe(0);
  const cfg = loadConfig();
  expect(cfg.instances["n8n.h.co"].apiKey).toBe("K");
  expect(cfg.defaultInstance).toBe("n8n.h.co");
});

test("runLogin with --email validates the session and stores credentials + cookie", async () => {
  const validate = async () => true;
  const sessionLogin = async (
    _baseUrl: string,
    email: string,
    _password: string,
    browserId: string,
  ) => {
    expect(email).toBe("a@b.co");
    expect(browserId).toBeTruthy();
    return "n8n-auth=tok";
  };
  const code = await runLogin(
    {
      url: "https://n8n.h.co",
      key: "K",
      email: "a@b.co",
      password: "pw",
      json: true,
      quiet: true,
    },
    validate,
    sessionLogin,
  );
  expect(code).toBe(0);
  const stored = loadConfig().instances["n8n.h.co"];
  expect(stored.email).toBe("a@b.co");
  expect(stored.password).toBe("pw");
  expect(stored.sessionCookie).toBe("n8n-auth=tok");
  expect(stored.browserId).toBeTruthy();
});

test("runLogin with --email reuses the stored API key when --key is omitted", async () => {
  await runLogin(
    { url: "https://n8n.h.co", key: "K", json: true, quiet: true },
    async () => true,
  );
  let validated = 0;
  const code = await runLogin(
    {
      url: "https://n8n.h.co",
      email: "a@b.co",
      password: "pw",
      json: true,
      quiet: true,
    },
    async () => {
      validated++;
      return true;
    },
    async () => "n8n-auth=tok",
  );
  expect(code).toBe(0);
  expect(validated).toBe(0); // stored key kept without re-validation
  expect(loadConfig().instances["n8n.h.co"].apiKey).toBe("K");
});

test("runLogin surfaces a rejected session login", async () => {
  await expect(
    runLogin(
      {
        url: "https://n8n.h.co",
        key: "K",
        email: "a@b.co",
        password: "bad",
        json: true,
        quiet: true,
      },
      async () => true,
      async () => {
        throw Object.assign(new Error("HTTP 401"), { code: "unauthorized" });
      },
    ),
  ).rejects.toMatchObject({ code: "unauthorized" });
});

test("runLogin throws when validation fails", async () => {
  const validate = async () => false;
  await expect(
    runLogin({ url: "https://n8n.h.co", key: "BAD", json: true, quiet: true }, validate),
  ).rejects.toMatchObject({ code: "unauthorized" });
});
