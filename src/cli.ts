#!/usr/bin/env bun
import { Command } from "commander";
import { emitError, resolveOutputMode, toCliError } from "./format";
import { runLogin } from "./commands/login";
import { runSync } from "./commands/sync";
import { runWorkflows } from "./commands/workflows";
import { runExecutions } from "./commands/executions";
import { runSearch } from "./commands/search";
import { runGet } from "./commands/get";
import { runRetry } from "./commands/retry";

async function execute(
  opts: { json?: boolean; text?: boolean },
  fn: () => Promise<number>,
): Promise<never> {
  try {
    const code = await fn();
    process.exit(code);
  } catch (err) {
    const cliErr = toCliError(err);
    emitError(cliErr, resolveOutputMode(opts));
    process.exit(2);
  }
}

const program = new Command();

program
  .name("n8n-helper")
  .description("Locate n8n workflows and execution data via the n8n public API")
  .version("0.1.0")
  .option("--json", "force JSON output")
  .option("--text", "force human-readable output")
  .option("--instance <host>", "n8n instance host to target")
  .option("--quiet", "suppress progress messages");

program
  .command("login")
  .description("Save an n8n instance's API key to the global config")
  .requiredOption("--url <base-url>", "n8n instance base URL")
  .option("--key <api-key>", "API key (prompts if omitted)")
  .option(
    "--email <email>",
    "n8n login email; enables session auth for /rest endpoints (e.g. retry)",
  )
  .option("--password <password>", "n8n login password (prompts if omitted)")
  .option("--default", "make this the default instance")
  .action(async (_options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runLogin(opts));
  });

program
  .command("sync")
  .description("Rebuild the workflow catalog for the instance")
  .action(async (_options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runSync(opts));
  });

program
  .command("workflows")
  .description("Search workflows by id, name, webhook, or tag")
  .argument("[query]", "case-insensitive substring to match")
  .option("--field <field>", "restrict to one field: id | name | webhook | tag")
  .option("--active", "only active workflows")
  .option("--limit <n>", "max results", "50")
  .option("--offset <n>", "result offset", "0")
  .option("--refresh", "sync the catalog before searching")
  .option("--no-sync", "do not auto-sync when the catalog is missing")
  .action(async (query, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runWorkflows(query, opts));
  });

program
  .command("executions")
  .description("List a workflow's executions")
  .argument("<workflow>", "workflow URL or id")
  .option("--status <status>", "filter: success | error | waiting")
  .option("--limit <n>", "page size", "20")
  .option("--cursor <cursor>", "pagination cursor")
  .option("--all", "auto-paginate up to 1000 executions")
  .action(async (workflow, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runExecutions(workflow, opts));
  });

program
  .command("search")
  .description("Locate a value inside execution data")
  .argument("<value>", "value to locate")
  .argument("<target>", "execution or workflow URL/id")
  .option("--node <name>", "restrict to one node")
  .option("--exact", "match a whole string value")
  .option("--regex", "treat value as a regular expression")
  .option("--case-sensitive", "case-sensitive matching")
  .option("--limit <n>", "workflow target: executions to search", "20")
  .option("--status <status>", "workflow target: execution status filter")
  .option("--max-matches <n>", "stop after this many matches", "100")
  .option("--context", "include each match's parent object")
  .option("--truncate <n>", "max characters per matched value", "200")
  .option("--no-truncate", "do not truncate matched values")
  .option("--refresh", "re-fetch executions, bypassing the cache")
  .option("--no-cache", "do not read or write the execution cache")
  .option("--out <file>", "write JSON results to a file")
  .action(async (value, target, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runSearch(value, target, opts));
  });

program
  .command("retry")
  .description(
    "Re-run failed executions of a workflow (uses /rest/executions/:id/retry; logs in with saved email/password, or pass --cookie)",
  )
  .argument("<workflow>", "workflow URL or id")
  .option("--status <status>", "filter: success | error | waiting | crashed")
  .option("--started-after <iso>", "only retry executions started at/after this ISO timestamp")
  .option("--started-before <iso>", "only retry executions started at/before this ISO timestamp")
  .option("--ids <list>", "comma/space-separated execution ids to retry (overrides filters)")
  .option("--exclude <list>", "comma/space-separated execution ids to skip")
  .option("--limit <n>", "page size when listing executions", "200")
  .option("--load-workflow", "retry using the original execution's workflow snapshot")
  .option("--concurrency <n>", "parallel retry requests", "5")
  .option("--dry-run", "list matching executions without retrying")
  .option(
    "--cookie <cookie>",
    "n8n session cookie override (or set N8N_SESSION_COOKIE); defaults to the saved session",
  )
  .action(async (workflow, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runRetry(workflow, opts));
  });

program
  .command("get")
  .description("Inspect an execution or drill into a node/path")
  .argument("<execution>", "execution URL or id")
  .option("--node <name>", "show one node's items")
  .option("--path <path>", "resolve a JSON path (e.g. json.order.id)")
  .option("--run <n>", "narrow to a run index")
  .option("--output <n>", "narrow to an output branch index")
  .option("--item <n>", "narrow to an item index")
  .option("--refresh", "re-fetch the execution, bypassing the cache")
  .option("--no-cache", "do not read or write the execution cache")
  .option("--out <file>", "write JSON output to a file")
  .action(async (execution, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runGet(execution, opts));
  });

program.parseAsync().catch((err) => {
  const cliErr = toCliError(err);
  emitError(cliErr, resolveOutputMode(program.opts()));
  process.exit(2);
});
