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
    env: {
      ...process.env,
      N8N_HELPER_HOME: home,
      N8N_HELPER_AUTO_UPDATE: "0",
      N8N_API_KEY: "",
      N8N_BASE_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test("--help lists the execution control commands", async () => {
  const { stdout, exitCode } = await run(["--help"]);
  expect(exitCode).toBe(0);
  for (const cmd of ["executions", "get", "retry", "stop", "publish"]) {
    expect(stdout).toContain(cmd);
  }
});

test("--help exposes the one-window auto-update opt-out", async () => {
  const { stdout, exitCode } = await run(["--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("--no-update");
});

test("publish help exposes the explicit write gate", async () => {
  const { stdout, exitCode } = await run(["publish", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("<workflow>");
  expect(stdout).toContain("--yes");
});

test("a missing-credentials error exits 2 with a JSON envelope", async () => {
  const { stdout, exitCode } = await run(["workflows", "--json", "--no-sync"]);
  expect(exitCode).toBe(2);
  const parsed = JSON.parse(stdout);
  expect(parsed.error.code).toBe("no-credentials");
});

test("execution-listing commands expose time-window options", async () => {
  for (const command of ["executions", "search"]) {
    const { stdout, exitCode } = await run([command, "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--from <date-time>");
    expect(stdout).toContain("--to <date-time>");
    expect(stdout).toContain("--since <duration-or-date-time>");
  }
});
