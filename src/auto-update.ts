import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHome } from "./config";

export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_LOCK_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 5_000;

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AutoUpdateStatus =
  | "disabled"
  | "deferred"
  | "restarted"
  | "cached"
  | "locked"
  | "not-git"
  | "dirty"
  | "no-upstream"
  | "up-to-date"
  | "diverged"
  | "updated"
  | "error";

export interface AutoUpdateResult {
  status: AutoUpdateStatus;
  updated: boolean;
  shouldRestart: boolean;
  message?: string;
  behind?: number;
}

type RunGit = (args: string[], cwd: string) => Promise<GitResult>;

interface AutoUpdateOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
  homeDir?: string;
  repoDir?: string;
  now?: () => number;
  runGit?: RunGit;
}

type SpawnUpdatedCli = (
  command: string[],
  env: Record<string, string | undefined>,
) => Promise<number>;

interface RestartOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  spawn?: SpawnUpdatedCli;
}

interface UpdateState {
  lastCheckedAt: number;
}

const defaultRepoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function result(
  status: AutoUpdateStatus,
  extra: Partial<AutoUpdateResult> = {},
): AutoUpdateResult {
  return {
    status,
    updated: false,
    shouldRestart: false,
    ...extra,
  };
}

function autoUpdateDisabled(value: string | undefined): boolean {
  return ["0", "false", "off", "disabled"].includes(
    value?.trim().toLowerCase() ?? "",
  );
}

function readState(path: string): UpdateState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateState>;
    if (Number.isFinite(parsed.lastCheckedAt)) {
      return { lastCheckedAt: parsed.lastCheckedAt as number };
    }
  } catch {
    // A missing or malformed cache should trigger a fresh check.
  }
  return undefined;
}

function writeState(path: string, state: UpdateState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function isFresh(state: UpdateState | undefined, now: number): boolean {
  if (!state) return false;
  const age = now - state.lastCheckedAt;
  return age >= 0 && age < AUTO_UPDATE_INTERVAL_MS;
}

function acquireLock(path: string, now: number): number | undefined {
  mkdirSync(dirname(path), { recursive: true });
  try {
    return openSync(path, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    try {
      if (now - statSync(path).mtimeMs >= STALE_LOCK_MS) {
        rmSync(path, { force: true });
        return openSync(path, "wx", 0o600);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}

async function runGitCommand(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, GIT_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout: await stdoutPromise,
    stderr: timedOut ? "Git update check timed out" : await stderrPromise,
  };
}

function gitFailure(command: string, git: GitResult): AutoUpdateResult {
  const detail = git.stderr.trim() || git.stdout.trim() || `exit ${git.exitCode}`;
  return result("error", {
    message: `Auto-update ${command} failed: ${detail}`,
  });
}

export async function maybeAutoUpdate(
  options: AutoUpdateOptions = {},
): Promise<AutoUpdateResult> {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? getHome();
  const repoDir = options.repoDir ?? defaultRepoDir;
  const now = (options.now ?? Date.now)();
  const runGit = options.runGit ?? runGitCommand;
  const statePath = join(homeDir, "update-check.json");
  const lockPath = join(homeDir, "update-check.lock");

  if (autoUpdateDisabled(env.N8N_HELPER_AUTO_UPDATE)) {
    return result("disabled");
  }
  if (env.N8N_HELPER_UPDATE_RESTARTED === "1") {
    return result("restarted");
  }
  if (args.includes("--no-update")) {
    writeState(statePath, { lastCheckedAt: now });
    return result("deferred");
  }
  if (isFresh(readState(statePath), now)) {
    return result("cached");
  }

  const lock = acquireLock(lockPath, now);
  if (lock === undefined) return result("locked");
  try {
    if (isFresh(readState(statePath), now)) return result("cached");
    writeState(statePath, { lastCheckedAt: now });

    const root = await runGit(["rev-parse", "--show-toplevel"], repoDir);
    if (root.exitCode !== 0 || resolve(root.stdout.trim()) !== resolve(repoDir)) {
      return result("not-git");
    }

    const workingTree = await runGit(["status", "--porcelain"], repoDir);
    if (workingTree.exitCode !== 0) return gitFailure("status", workingTree);
    if (workingTree.stdout.trim() !== "") {
      return result("dirty", {
        message: "Auto-update skipped because the n8n-helper checkout has local changes.",
      });
    }

    const upstream = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      repoDir,
    );
    if (upstream.exitCode !== 0 || upstream.stdout.trim() === "") {
      return result("no-upstream", {
        message: "Auto-update skipped because the checkout has no upstream branch.",
      });
    }

    const fetched = await runGit(["fetch", "--quiet"], repoDir);
    if (fetched.exitCode !== 0) return gitFailure("fetch", fetched);

    const counts = await runGit(
      ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
      repoDir,
    );
    if (counts.exitCode !== 0) return gitFailure("comparison", counts);
    const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
      return result("error", {
        message: `Auto-update comparison returned an invalid result: ${counts.stdout.trim()}`,
      });
    }
    if (ahead > 0) {
      return result("diverged", {
        behind,
        message:
          "Auto-update skipped because the local branch is ahead of or diverged from its upstream.",
      });
    }
    if (behind === 0) return result("up-to-date", { behind: 0 });

    const pulled = await runGit(["pull", "--ff-only"], repoDir);
    if (pulled.exitCode !== 0) return gitFailure("pull", pulled);
    return result("updated", {
      updated: true,
      shouldRestart: true,
      behind,
      message: `n8n-helper updated by ${behind} commit${behind === 1 ? "" : "s"}.`,
    });
  } catch (error) {
    return result("error", {
      message: `Auto-update failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

async function spawnUpdatedCli(
  command: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  const child = Bun.spawn(command, {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

export async function restartUpdatedCli(
  options: RestartOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? spawnUpdatedCli;
  return spawn([...argv], {
    ...env,
    N8N_HELPER_UPDATE_RESTARTED: "1",
  });
}
