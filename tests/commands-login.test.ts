import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin } from "../src/commands/login";
import { loadConfig } from "../src/config";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-locate-login-"));
  process.env.N8N_LOCATE_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_LOCATE_HOME;
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

test("runLogin throws when validation fails", async () => {
  const validate = async () => false;
  await expect(
    runLogin({ url: "https://n8n.h.co", key: "BAD", json: true, quiet: true }, validate),
  ).rejects.toMatchObject({ code: "unauthorized" });
});
