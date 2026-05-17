import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  upsertInstance,
  resolveInstance,
  catalogPaths,
  execCachePath,
} from "../src/config";
import { CliError } from "../src/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-"));
  process.env.N8N_HELPER_HOME = home;
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_BASE_URL;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.N8N_HELPER_HOME;
});

test("loadConfig returns an empty config when no file exists", () => {
  expect(loadConfig()).toEqual({ instances: {} });
});

test("upsertInstance writes and the first instance becomes default", () => {
  upsertInstance("h.co", { baseUrl: "https://h.co", apiKey: "K" }, false);
  const cfg = loadConfig();
  expect(cfg.defaultInstance).toBe("h.co");
  expect(cfg.instances["h.co"].apiKey).toBe("K");
});

test("saveConfig writes the file with 0600 permissions", () => {
  saveConfig({ instances: {} });
  const mode = statSync(join(home, "config.json")).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("resolveInstance reads the host entry from config", () => {
  upsertInstance("h.co", { baseUrl: "https://h.co", apiKey: "K" }, true);
  expect(resolveInstance({ host: "h.co" })).toEqual({
    host: "h.co",
    baseUrl: "https://h.co",
    apiKey: "K",
  });
});

test("resolveInstance lets N8N_API_KEY override the stored key", () => {
  upsertInstance("h.co", { baseUrl: "https://h.co", apiKey: "OLD" }, true);
  process.env.N8N_API_KEY = "ENVKEY";
  expect(resolveInstance({ host: "h.co" }).apiKey).toBe("ENVKEY");
});

test("resolveInstance throws no-credentials when nothing resolves", () => {
  try {
    resolveInstance({});
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("no-credentials");
  }
});

test("catalogPaths and execCachePath are under the home dir", () => {
  expect(catalogPaths("h.co").workflowsPath).toBe(
    join(home, "catalog", "h.co", "workflows.jsonl"),
  );
  expect(execCachePath("h.co", "99")).toBe(
    join(home, "cache", "h.co", "executions", "99.json"),
  );
});
