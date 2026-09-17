import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_UPDATE_INTERVAL_MS,
  maybeAutoUpdate,
  restartUpdatedCli,
  type GitResult,
} from "../src/auto-update";

const NOW = Date.UTC(2026, 8, 17, 9, 0, 0);

let root: string;
let homeDir: string;
let repoDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "n8n-helper-auto-update-"));
  homeDir = join(root, "home");
  repoDir = join(root, "repo");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function gitSequence(
  steps: Array<{ args: string[]; result: Partial<GitResult> }>,
): (args: string[]) => Promise<GitResult> {
  return async (args) => {
    const step = steps.shift();
    expect(step?.args).toEqual(args);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      ...step?.result,
    };
  };
}

function readState(): { lastCheckedAt: number } {
  return JSON.parse(
    readFileSync(join(homeDir, "update-check.json"), "utf8"),
  );
}

test("--no-update skips this check and starts a fresh six-hour window", async () => {
  let calls = 0;
  const deferred = await maybeAutoUpdate({
    args: ["--no-update", "workflows"],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW,
    runGit: async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  expect(deferred.status).toBe("deferred");
  expect(calls).toBe(0);
  expect(readState().lastCheckedAt).toBe(NOW);

  const cached = await maybeAutoUpdate({
    args: ["workflows"],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW + AUTO_UPDATE_INTERVAL_MS - 1,
    runGit: async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  expect(cached.status).toBe("cached");
  expect(calls).toBe(0);
});

test("N8N_HELPER_AUTO_UPDATE=0 disables updates without changing the window", async () => {
  const result = await maybeAutoUpdate({
    args: [],
    env: { N8N_HELPER_AUTO_UPDATE: "0" },
    homeDir,
    repoDir,
    now: () => NOW,
    runGit: async () => {
      throw new Error("git must not run");
    },
  });

  expect(result.status).toBe("disabled");
  expect(existsSync(join(homeDir, "update-check.json"))).toBe(false);
});

test("a cached check avoids Git until the six-hour boundary", async () => {
  await maybeAutoUpdate({
    args: ["--no-update"],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW,
  });

  let calls = 0;
  const result = await maybeAutoUpdate({
    args: [],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW + AUTO_UPDATE_INTERVAL_MS,
    runGit: async () => {
      calls += 1;
      return { exitCode: 1, stdout: "", stderr: "not a checkout" };
    },
  });

  expect(result.status).toBe("not-git");
  expect(calls).toBe(1);
  expect(readState().lastCheckedAt).toBe(NOW + AUTO_UPDATE_INTERVAL_MS);
});

test("a clean behind checkout fast-forwards and requests one restart", async () => {
  const runGit = gitSequence([
    {
      args: ["rev-parse", "--show-toplevel"],
      result: { stdout: `${repoDir}\n` },
    },
    { args: ["status", "--porcelain"], result: { stdout: "" } },
    {
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      result: { stdout: "origin/main\n" },
    },
    { args: ["fetch", "--quiet"], result: {} },
    {
      args: ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
      result: { stdout: "0\t2\n" },
    },
    { args: ["pull", "--ff-only"], result: { stdout: "Updating\n" } },
  ]);

  const result = await maybeAutoUpdate({
    args: ["workflows"],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW,
    runGit,
  });

  expect(result).toMatchObject({
    status: "updated",
    updated: true,
    shouldRestart: true,
    behind: 2,
  });
});

test("a dirty checkout is never fetched or modified", async () => {
  const runGit = gitSequence([
    {
      args: ["rev-parse", "--show-toplevel"],
      result: { stdout: `${repoDir}\n` },
    },
    {
      args: ["status", "--porcelain"],
      result: { stdout: " M src/cli.ts\n" },
    },
  ]);

  const result = await maybeAutoUpdate({
    args: [],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW,
    runGit,
  });

  expect(result.status).toBe("dirty");
  expect(result.updated).toBe(false);
  expect(readState().lastCheckedAt).toBe(NOW);
});

test("offline fetch errors never block the requested command", async () => {
  const runGit = gitSequence([
    {
      args: ["rev-parse", "--show-toplevel"],
      result: { stdout: `${repoDir}\n` },
    },
    { args: ["status", "--porcelain"], result: { stdout: "" } },
    {
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      result: { stdout: "origin/main\n" },
    },
    {
      args: ["fetch", "--quiet"],
      result: { exitCode: 1, stderr: "offline" },
    },
  ]);

  const result = await maybeAutoUpdate({
    args: [],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW,
    runGit,
  });

  expect(result.status).toBe("error");
  expect(result.updated).toBe(false);
  expect(result.message).toContain("offline");
  expect(readState().lastCheckedAt).toBe(NOW);
});

test("diverged checkouts are left untouched", async () => {
  const runGit = gitSequence([
    {
      args: ["rev-parse", "--show-toplevel"],
      result: { stdout: `${repoDir}\n` },
    },
    { args: ["status", "--porcelain"], result: { stdout: "" } },
    {
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      result: { stdout: "origin/main\n" },
    },
    { args: ["fetch", "--quiet"], result: {} },
    {
      args: ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
      result: { stdout: "1\t2\n" },
    },
  ]);

  const result = await maybeAutoUpdate({
    args: [],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW,
    runGit,
  });

  expect(result.status).toBe("diverged");
  expect(result.updated).toBe(false);
});

test("concurrent launches perform only one Git check", async () => {
  let releaseFirst!: () => void;
  const paused = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const runGit = async (): Promise<GitResult> => {
    calls += 1;
    await paused;
    return { exitCode: 1, stdout: "", stderr: "not a checkout" };
  };

  const first = maybeAutoUpdate({
    args: [],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW,
    runGit,
  });
  await Bun.sleep(10);
  const second = await maybeAutoUpdate({
    args: [],
    env: {},
    homeDir,
    repoDir,
    now: () => NOW,
    runGit,
  });
  releaseFirst();
  const firstResult = await first;

  expect(firstResult.status).toBe("not-git");
  expect(["cached", "locked"]).toContain(second.status);
  expect(calls).toBe(1);
});

test("restart re-runs the same command once with the update sentinel", async () => {
  let received:
    | { command: string[]; env: Record<string, string | undefined> }
    | undefined;

  const exitCode = await restartUpdatedCli({
    argv: ["/bin/bun", "/repo/src/cli.ts", "workflows", "--json"],
    env: { EXISTING: "value" },
    spawn: async (command, env) => {
      received = { command, env };
      return 7;
    },
  });

  expect(exitCode).toBe(7);
  expect(received).toEqual({
    command: ["/bin/bun", "/repo/src/cli.ts", "workflows", "--json"],
    env: {
      EXISTING: "value",
      N8N_HELPER_UPDATE_RESTARTED: "1",
    },
  });
});
