import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-cli-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, N8N_HELPER_HOME: home, N8N_API_KEY: "", N8N_BASE_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test("--help lists all six commands", async () => {
  const { stdout, exitCode } = await run(["--help"]);
  expect(exitCode).toBe(0);
  for (const cmd of ["login", "sync", "workflows", "executions", "search", "get"]) {
    expect(stdout).toContain(cmd);
  }
});

test("a missing-credentials error exits 2 with a JSON envelope", async () => {
  const { stdout, exitCode } = await run(["workflows", "--json", "--no-sync"]);
  expect(exitCode).toBe(2);
  const parsed = JSON.parse(stdout);
  expect(parsed.error.code).toBe("no-credentials");
});
