import { Command } from "commander";
import {
  runTableCreate,
  runTableDelete,
  runTableGet,
  runTableList,
  runTableRename,
} from "./table";

export type ExecuteCommand = (
  opts: { json?: boolean; text?: boolean },
  fn: () => Promise<number>,
) => Promise<never>;

/**
 * Register the singular `table` command and its metadata subcommands. Rows and
 * columns are created as empty parent commands so Task 3 can attach children
 * without changing the top-level contract.
 */
export function registerTable(
  program: Command,
  executeCommand: ExecuteCommand,
): void {
  const table = program
    .command("table")
    .description("Manage n8n data tables: metadata, rows, and columns");

  table
    .command("list")
    .description("List data tables")
    .option("--limit <n>", "page size")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--all", "auto-paginate up to 1000 tables")
    .option("--name <name>", "filter by exact table name")
    .option("--sort <field>", "sort field (name | createdAt | updatedAt)")
    .action(async (_options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () => runTableList(opts));
    });

  table
    .command("get")
    .description("Fetch one data table's metadata")
    .argument("<tableId>", "data table id")
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () => runTableGet(tableId, opts));
    });

  table
    .command("create")
    .description("Create a data table")
    .argument("<name>", "data table name")
    .option("--columns-json <json>", "inline JSON array of column definitions")
    .option("--columns-file <path>", "path to a JSON file of column definitions")
    .option(
      "--yes",
      "apply the create (required to write; otherwise a preview no-op)",
    )
    .action(async (name, _options, command) => {
      const opts = command.optsWithGlobals();
      // Commander camelCases `--columns-json`; the handler expects `columnsInline`.
      const { columnsJson, ...rest } = opts;
      await executeCommand(opts, () =>
        runTableCreate(name, { ...rest, columnsInline: columnsJson }),
      );
    });

  table
    .command("rename")
    .description("Rename a data table")
    .argument("<tableId>", "data table id")
    .argument("<name>", "new data table name")
    .option(
      "--yes",
      "apply the rename (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, name, _options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () => runTableRename(tableId, name, opts));
    });

  table
    .command("delete")
    .description("Delete a data table")
    .argument("<tableId>", "data table id")
    .option(
      "--yes",
      "apply the delete (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () => runTableDelete(tableId, opts));
    });

  // Task 3 attaches row commands here.
  table.command("rows").description("Manage a data table's rows");
  // Task 3 attaches column commands here.
  table.command("columns").description("Manage a data table's columns");
}
