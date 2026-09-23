import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "n8n-helper-cli-table-"));
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

test("table help exposes metadata and nested resource commands", async () => {
  const { stdout, exitCode } = await run(["table", "--help"]);
  expect(exitCode).toBe(0);
  for (const name of [
    "list",
    "get",
    "create",
    "rename",
    "delete",
    "rows",
    "columns",
  ]) {
    expect(stdout).toContain(name);
  }
});

test("the command tree exposes a singular table command, not a plural one", async () => {
  const top = await run(["--help"]);
  expect(top.exitCode).toBe(0);

  // Commander's top-level help lists every registered command with a two-space
  // indent and at least two spaces of padding before the description (or the
  // line ends when a command has no description). Matching that exact shape
  // pins the check to a real command entry: an unknown `tables` invocation is
  // not usable as evidence because Commander prints global help and exits 0
  // when `--help` is present, and a bare `toContain("table")` would also match
  // prose such as the "Manage n8n data tables" description.
  expect(top.stdout).toMatch(/^ {2}table(?= {2,}|$)/m);
  expect(top.stdout).not.toMatch(/^ {2}tables(?= {2,}|$)/m);
});

test("table list help exposes pagination and filter options", async () => {
  const { stdout, exitCode } = await run(["table", "list", "--help"]);
  expect(exitCode).toBe(0);
  for (const flag of ["--limit", "--cursor", "--all", "--name", "--sort"]) {
    expect(stdout).toContain(flag);
  }
  expect(stdout).toContain("--sort <field:direction>");
  expect(stdout).toContain("name:asc");
  expect(stdout).toContain("createdAt:desc");
});

test("table metadata mutation help exposes the --yes write gate", async () => {
  for (const command of ["create", "rename", "delete"]) {
    const { stdout, exitCode } = await run(["table", command, "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--yes");
  }
});

test("table create help exposes inline and file column inputs", async () => {
  const { stdout, exitCode } = await run(["table", "create", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("--columns-file");
  // The inline spelling mirrors the handler's `columnsInline` option.
  expect(
    stdout.includes("--columns-inline") || stdout.includes("--columns-json"),
  ).toBe(true);
});

test("table registers empty rows and columns parent commands", async () => {
  const tableHelp = await run(["table", "--help"]);
  expect(tableHelp.exitCode).toBe(0);
  expect(tableHelp.stdout).toContain("rows");
  expect(tableHelp.stdout).toContain("columns");

  for (const parent of ["rows", "columns"]) {
    const { stdout, exitCode } = await run(["table", parent, "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(parent);
  }
});

test("table get is a read-only command without a write gate", async () => {
  const { stdout, exitCode } = await run(["table", "get", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("--yes");
});

const ROW_COMMANDS = ["list", "insert", "update", "upsert", "delete", "clear"];

test("table rows help exposes all six row subcommands", async () => {
  const { stdout, exitCode } = await run(["table", "rows", "--help"]);
  expect(exitCode).toBe(0);
  for (const name of ROW_COMMANDS) {
    expect(stdout).toContain(name);
  }
});

test("table rows list help exposes pagination, sort, and JSON filter inputs", async () => {
  const { stdout, exitCode } = await run(["table", "rows", "list", "--help"]);
  expect(exitCode).toBe(0);
  for (const flag of [
    "--filter-file",
    "--filter-json",
    "--limit",
    "--cursor",
    "--all",
    "--sort",
  ]) {
    expect(stdout).toContain(flag);
  }

  // Task 3 review finding: `table rows list` must accept a free-text search
  // option alongside the structured JSON filters above. Commander renders an
  // option that takes a value as `--search <placeholder>`, so require
  // `--search` to be followed by an angle-bracketed value placeholder (e.g.
  // `--search <text>` or `--search <query>`) instead of merely a bare prefix
  // that could also match an unrelated flag such as `--search-all`.
  expect(stdout).toMatch(/--search\s+<\S+>/);
});

test("table rows insert help exposes data inputs, --return, and the --yes write gate", async () => {
  const { stdout, exitCode } = await run(["table", "rows", "insert", "--help"]);
  expect(exitCode).toBe(0);
  for (const flag of ["--data-file", "--data-json", "--yes"]) {
    expect(stdout).toContain(flag);
  }
  // `--return` must be the bare return-type flag, not the `--return-data`
  // boolean used by update/upsert.
  expect(stdout).toMatch(/--return(?!-data)/);
});

test("table rows update help exposes data and filter inputs plus the write gate", async () => {
  const { stdout, exitCode } = await run(["table", "rows", "update", "--help"]);
  expect(exitCode).toBe(0);
  for (const flag of [
    "--data-file",
    "--data-json",
    "--filter-file",
    "--filter-json",
    "--return-data",
    "--dry-run",
    "--yes",
  ]) {
    expect(stdout).toContain(flag);
  }
});

test("table rows upsert help exposes data and filter inputs plus the write gate", async () => {
  const { stdout, exitCode } = await run(["table", "rows", "upsert", "--help"]);
  expect(exitCode).toBe(0);
  for (const flag of [
    "--data-file",
    "--data-json",
    "--filter-file",
    "--filter-json",
    "--return-data",
    "--dry-run",
    "--yes",
  ]) {
    expect(stdout).toContain(flag);
  }
});

test("table rows delete help exposes JSON filter inputs and the write gate", async () => {
  const { stdout, exitCode } = await run(["table", "rows", "delete", "--help"]);
  expect(exitCode).toBe(0);
  for (const flag of [
    "--filter-file",
    "--filter-json",
    "--return-data",
    "--dry-run",
    "--yes",
  ]) {
    expect(stdout).toContain(flag);
  }
});

test("table rows clear help exposes the --yes write gate", async () => {
  const { stdout, exitCode } = await run(["table", "rows", "clear", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("--yes");
});

const COLUMN_COMMANDS = ["list", "add", "update", "delete"];

test("table columns help exposes all four column subcommands", async () => {
  const { stdout, exitCode } = await run(["table", "columns", "--help"]);
  expect(exitCode).toBe(0);
  for (const name of COLUMN_COMMANDS) {
    expect(stdout).toContain(name);
  }
});

test("table columns list help stays read-only without a write gate", async () => {
  const { stdout, exitCode } = await run(["table", "columns", "list", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).not.toContain("--yes");
});

test("table columns add help exposes the <type> argument, --index, and --yes", async () => {
  const { stdout, exitCode } = await run(["table", "columns", "add", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("<type>");
  expect(stdout).toContain("--index");
  expect(stdout).toContain("--yes");
});

test("table columns update help exposes optional --name/--index gated by --yes", async () => {
  const { stdout, exitCode } = await run(["table", "columns", "update", "--help"]);
  expect(exitCode).toBe(0);
  for (const flag of ["--name", "--index", "--yes"]) {
    expect(stdout).toContain(flag);
  }
});

test("table columns delete help exposes the --yes write gate", async () => {
  const { stdout, exitCode } = await run(["table", "columns", "delete", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("--yes");
});
