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
import { runPull } from "./commands/pull";
import { runEdit, type EditSubcommand } from "./commands/edit";
import { runValidate } from "./commands/validate";
import { runPush } from "./commands/push";
import { runCreate } from "./commands/create";
import { runRun } from "./commands/run";

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
  .option(
    "--trace",
    "walk the parent-execution chain to show what triggered this execution",
  )
  .option("--refresh", "re-fetch the execution, bypassing the cache")
  .option("--no-cache", "do not read or write the execution cache")
  .option("--out <file>", "write JSON output to a file")
  .action(async (execution, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runGet(execution, opts));
  });

program
  .command("pull")
  .description("Fetch a workflow's full definition to a local file (diff-gated)")
  .argument("<workflow>", "exact workflow name, id, or URL")
  .option("--dir <path>", "workflows directory (or N8N_WORKFLOWS_DIR)")
  .option("--out <path>", "destination file for a new workflow")
  .option("--yes", "overwrite a differing local file without prompting")
  .action(async (workflow, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runPull(workflow, opts));
  });

program
  .command("edit")
  .description("Edit a workflow: set-code | set-prompt | replace-node")
  .argument(
    "<workflow>",
    "workflow name (local file), or name/id/URL with --remote",
  )
  .argument("<op>", "set-code | set-prompt | replace-node")
  .option("--node <name>", "target node name")
  .option("--code <str>", "inline code (set-code); '-' reads stdin")
  .option("--code-file <path>", "code from a file (set-code); '-' reads stdin")
  .option("--lang <lang>", "js | python (set-code)")
  .option("--system <str>", "inline system prompt (set-prompt); '-' reads stdin")
  .option("--system-file <path>", "system prompt from a file; '-' reads stdin")
  .option("--user <str>", "inline user prompt (set-prompt); '-' reads stdin")
  .option("--user-file <path>", "user prompt from a file; '-' reads stdin")
  .option("--system-path <path>", "override system field path (set-prompt)")
  .option("--user-path <path>", "override user field path (set-prompt)")
  .option("--literal", "store prompt as a plain string, not an expression")
  .option("--file <path>", "replacement node JSON (replace-node); '-' reads stdin")
  .option(
    "--remote",
    "edit the live workflow directly (fetch, apply, preview; --yes to push)",
  )
  .option("--whole", "push the whole workflow, not just the edited node (--remote)")
  .option("--yes", "apply the edit to the live workflow (--remote)")
  .option("--force", "push even if validation finds errors (--remote)")
  .option("--dir <path>", "workflows directory (or N8N_WORKFLOWS_DIR)")
  .action(async (workflow, op, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runEdit(workflow, op as EditSubcommand, opts));
  });

program
  .command("validate")
  .description("Validate a local workflow: references, diff vs live, stale $json")
  .argument("<workflow>", "exact workflow name, id, or URL")
  .option("--local", "local checks only; no live fetch or diff")
  .option("--dir <path>", "workflows directory (or N8N_WORKFLOWS_DIR)")
  .action(async (workflow, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runValidate(workflow, opts));
  });

program
  .command("push")
  .description("Push a local workflow to n8n: merge changed nodes (default) or --whole")
  .argument("<workflow>", "exact workflow name, id, or URL")
  .option("--whole", "replace the entire workflow with the local file")
  .option("--node <name...>", "restrict merge to these node(s)")
  .option("--yes", "apply the push (required to write; otherwise a diff-only no-op)")
  .option("--force", "push despite validation hard errors")
  .option("--dir <path>", "workflows directory (or N8N_WORKFLOWS_DIR)")
  .action(async (workflow, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runPush(workflow, opts));
  });

program
  .command("create")
  .description("Create a NEW workflow on n8n from a local JSON file (created inactive)")
  .argument("<file>", "path to a workflow JSON file")
  .option("--name <name>", "override the workflow name from the file")
  .option("--yes", "apply the create (required to write; otherwise a preview no-op)")
  .option("--force", "create despite validation hard errors")
  .action(async (file, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runCreate(file, opts));
  });

program
  .command("run")
  .description("Test-run a workflow with sample data (webhook or internal /rest)")
  .argument("<workflow>", "exact workflow name, id, or URL")
  .option("--data <path>", "sample input JSON file")
  .option("--data-inline <json>", "sample input as an inline JSON string")
  .option("--node <name>", "trigger node to fire")
  .option("--poll", "fetch and summarize the resulting execution")
  .option("--dir <path>", "workflows directory (or N8N_WORKFLOWS_DIR)")
  .action(async (workflow, _options, command) => {
    const opts = command.optsWithGlobals();
    await execute(opts, () => runRun(workflow, opts));
  });

program.parseAsync().catch((err) => {
  const cliErr = toCliError(err);
  emitError(cliErr, resolveOutputMode(program.opts()));
  process.exit(2);
});
