import { Command } from "commander";
import {
  runTableCreate,
  runTableDelete,
  runTableGet,
  runTableList,
  runTableRename,
} from "./table";
import {
  runTableColumnsAdd,
  runTableColumnsDelete,
  runTableColumnsList,
  runTableColumnsUpdate,
} from "./table-columns";
import {
  runTableRowsClear,
  runTableRowsDelete,
  runTableRowsInsert,
  runTableRowsList,
  runTableRowsUpdate,
  runTableRowsUpsert,
} from "./table-rows";

export type ExecuteCommand = (
  opts: { json?: boolean; text?: boolean },
  fn: () => Promise<number>,
) => Promise<never>;

/**
 * Register the singular `table` command and its metadata subcommands, then
 * attach the row and column children to their parent commands. Every action
 * reads merged options through `command.optsWithGlobals()` and dispatches to the
 * matching handler through the injected `executeCommand`.
 *
 * Commander camelCases hyphenated flags, so the inline-JSON options arrive as
 * `dataJson`/`filterJson` while the handlers expect `dataInline`/`filterInline`;
 * the user-facing `--sort <column:direction>` and `--return <...>` map to the
 * handler fields `sortBy` and `returnType`.
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

  // ---------------------------------------------------------------------------
  // rows
  // ---------------------------------------------------------------------------
  const rows = table.command("rows").description("Manage a data table's rows");

  rows
    .command("list")
    .description("List a data table's rows")
    .argument("<tableId>", "data table id")
    .option("--filter-file <path>", "path to a JSON file with a row filter")
    .option("--filter-json <json>", "inline JSON row filter")
    .option("--limit <n>", "page size")
    .option("--cursor <cursor>", "pagination cursor")
    .option("--all", "auto-paginate up to 1000 rows")
    .option("--sort <column:direction>", "sort by column and direction")
    .option("--search <text>", "free-text search across row values")
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      // `--filter-json`/`--sort` arrive camelCased; map to the handler fields.
      // `--search` needs no mapping: `opts.search` already matches the handler.
      const { filterJson, sort, ...rest } = opts;
      await executeCommand(opts, () =>
        runTableRowsList(tableId, {
          ...rest,
          filterInline: filterJson,
          sortBy: sort,
        }),
      );
    });

  rows
    .command("insert")
    .description("Insert rows into a data table")
    .argument("<tableId>", "data table id")
    .option("--data-file <path>", "path to a JSON file of rows to insert")
    .option("--data-json <json>", "inline JSON rows to insert")
    .option("--return <count|id|all>", "what the insert should return")
    .option(
      "--yes",
      "apply the insert (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      // `--data-json` and `--return` arrive camelCased; map to handler fields.
      const { dataJson, return: returnType, ...rest } = opts;
      await executeCommand(opts, () =>
        runTableRowsInsert(tableId, {
          ...rest,
          dataInline: dataJson,
          returnType,
        }),
      );
    });

  rows
    .command("update")
    .description("Update rows matching a filter")
    .argument("<tableId>", "data table id")
    .option("--data-file <path>", "path to a JSON file with the record data")
    .option("--data-json <json>", "inline JSON record data")
    .option("--filter-file <path>", "path to a JSON file with a row filter")
    .option("--filter-json <json>", "inline JSON row filter")
    .option("--return-data", "return the affected rows")
    .option("--dry-run", "run the update without persisting changes")
    .option(
      "--yes",
      "apply the update (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      const { dataJson, filterJson, ...rest } = opts;
      await executeCommand(opts, () =>
        runTableRowsUpdate(tableId, {
          ...rest,
          dataInline: dataJson,
          filterInline: filterJson,
        }),
      );
    });

  rows
    .command("upsert")
    .description("Upsert rows matching a filter")
    .argument("<tableId>", "data table id")
    .option("--data-file <path>", "path to a JSON file with the record data")
    .option("--data-json <json>", "inline JSON record data")
    .option("--filter-file <path>", "path to a JSON file with a row filter")
    .option("--filter-json <json>", "inline JSON row filter")
    .option("--return-data", "return the affected rows")
    .option("--dry-run", "run the upsert without persisting changes")
    .option(
      "--yes",
      "apply the upsert (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      const { dataJson, filterJson, ...rest } = opts;
      await executeCommand(opts, () =>
        runTableRowsUpsert(tableId, {
          ...rest,
          dataInline: dataJson,
          filterInline: filterJson,
        }),
      );
    });

  rows
    .command("delete")
    .description("Delete rows matching a filter")
    .argument("<tableId>", "data table id")
    .option("--filter-file <path>", "path to a JSON file with a row filter")
    .option("--filter-json <json>", "inline JSON row filter")
    .option("--return-data", "return the affected rows")
    .option("--dry-run", "run the delete without persisting changes")
    .option(
      "--yes",
      "apply the delete (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      const { filterJson, ...rest } = opts;
      await executeCommand(opts, () =>
        runTableRowsDelete(tableId, { ...rest, filterInline: filterJson }),
      );
    });

  rows
    .command("clear")
    .description("Delete every row from a data table")
    .argument("<tableId>", "data table id")
    .option(
      "--yes",
      "apply the clear (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () => runTableRowsClear(tableId, opts));
    });

  // ---------------------------------------------------------------------------
  // columns
  // ---------------------------------------------------------------------------
  const columns = table
    .command("columns")
    .description("Manage a data table's columns");

  columns
    .command("list")
    .description("List a data table's columns")
    .argument("<tableId>", "data table id")
    .action(async (tableId, _options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () => runTableColumnsList(tableId, opts));
    });

  columns
    .command("add")
    .description("Add a column to a data table")
    .argument("<tableId>", "data table id")
    .argument("<name>", "column name")
    .argument("<type>", "column type")
    .option("--index <n>", "zero-based column position")
    .option(
      "--yes",
      "apply the add (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, name, type, _options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () =>
        runTableColumnsAdd(tableId, name, type, opts),
      );
    });

  columns
    .command("update")
    .description("Rename or move a data table column")
    .argument("<tableId>", "data table id")
    .argument("<columnId>", "column id")
    .option("--name <name>", "new column name")
    .option("--index <n>", "new zero-based column position")
    .option(
      "--yes",
      "apply the update (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, columnId, _options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () =>
        runTableColumnsUpdate(tableId, columnId, opts),
      );
    });

  columns
    .command("delete")
    .description("Delete a data table column")
    .argument("<tableId>", "data table id")
    .argument("<columnId>", "column id")
    .option(
      "--yes",
      "apply the delete (required to write; otherwise a preview no-op)",
    )
    .action(async (tableId, columnId, _options, command) => {
      const opts = command.optsWithGlobals();
      await executeCommand(opts, () =>
        runTableColumnsDelete(tableId, columnId, opts),
      );
    });
}
