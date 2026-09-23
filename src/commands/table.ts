import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import {
  parseJsonOption,
  requireColumns,
  type DataTable,
  type DataTableColumnInput,
} from "../data-table";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { pageLimitFor, requireIntOption } from "../options";
import type { ResolvedInstance } from "../types";

// Public output contract exercised by the staged tests (JSON mode):
//   list   -> { instance, tables: DataTable[], count: number, nextCursor: string | null }
//   get    -> { instance, table: DataTable }
//   create -> preview: { preview: true, operation: "create-table", request: { name, columns }, hint }
//             write:   { instance, operation: "create-table", created: true, table: DataTable }
//   rename -> preview: { preview: true, operation: "rename-table", request: { tableId, name }, hint }
//             write:   { instance, operation: "rename-table", renamed: true, table: DataTable }
//   delete -> preview: { preview: true, operation: "delete-table", request: { tableId }, hint }
//             write:   { instance, operation: "delete-table", deleted: true, tableId }
// Preview envelopes never issue a client call; the write booleans require --yes.

/** A single `--all` run never returns more than this many records. */
const ALL_RESULT_CAP = 1000;

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export interface CommonOpts {
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

export interface TableListOpts extends CommonOpts {
  limit?: string;
  cursor?: string;
  all?: boolean;
  name?: string;
  sort?: string;
}

export interface TableCreateOpts extends CommonOpts {
  columnsInline?: string;
  columnsFile?: string;
  yes?: boolean;
}

export type WriteOpts = CommonOpts & { yes?: boolean };

export async function runTableList(
  opts: TableListOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);
    const limit =
      opts.limit === undefined
        ? undefined
        : requireIntOption("limit", opts.limit);

    const tables: DataTable[] = [];
    let cursor = opts.cursor;
    let nextCursor: string | null = null;

    for (;;) {
      // `--all` must never ask for more than the remaining capacity, otherwise an
      // oversized page would be truncated after the request and its cursor would
      // skip the dropped records. Clamping the requested limit keeps the returned
      // cursor pointing at the very next unemitted row.
      const remaining = ALL_RESULT_CAP - tables.length;
      const pageLimit = pageLimitFor(limit, opts.all, remaining);

      const page = await client.listDataTables({
        name: opts.name,
        sortBy: opts.sort,
        limit: pageLimit,
        cursor,
      });
      tables.push(...page.data);
      nextCursor = page.nextCursor;
      // A plain list is a single page: report the cursor but never follow it.
      if (!opts.all) break;
      // An empty page terminates the run even when the backend advertises a
      // cursor; following it would spin forever.
      if (page.data.length === 0) break;
      if (nextCursor === null) break;
      // Stop at the cap but keep the cursor that would fetch the next record.
      if (tables.length >= ALL_RESULT_CAP) break;
      cursor = nextCursor;
    }

    // Never surface more than the cap, even if one page overshoots it.
    if (tables.length > ALL_RESULT_CAP) tables.length = ALL_RESULT_CAP;

    emitJson({
      instance: instance.host,
      tables,
      count: tables.length,
      nextCursor,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export async function runTableGet(
  tableId: string,
  opts: CommonOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);
    const table = await client.getDataTable(tableId);
    emitJson({ instance: instance.host, table });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export async function runTableCreate(
  name: string,
  opts: TableCreateOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    // Validate column input at the command boundary: no API call on bad input.
    const parsed = parseJsonOption({
      file: opts.columnsFile,
      inline: opts.columnsInline,
      label: "columns",
      required: false,
    });
    const columns: DataTableColumnInput[] =
      parsed === undefined ? [] : requireColumns(parsed, "columns");
    const request = { name, columns };

    // Safe no-op: never write without an explicit --yes.
    if (!opts.yes) {
      emitJson({
        instance: instance.host,
        preview: true,
        operation: "create-table",
        request,
        hint: "Preview only — nothing was created. Re-run with --yes to create the data table.",
      });
      return 0;
    }

    const table = await client.createDataTable({ name, columns });
    emitJson({
      instance: instance.host,
      operation: "create-table",
      created: true,
      table,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export async function runTableRename(
  tableId: string,
  name: string,
  opts: WriteOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);
    const request = { tableId, name };

    if (!opts.yes) {
      emitJson({
        instance: instance.host,
        preview: true,
        operation: "rename-table",
        request,
        hint: "Preview only — nothing was renamed. Re-run with --yes to rename the data table.",
      });
      return 0;
    }

    const table = await client.renameDataTable(tableId, name);
    emitJson({
      instance: instance.host,
      operation: "rename-table",
      renamed: true,
      table,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export async function runTableDelete(
  tableId: string,
  opts: WriteOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);
    const request = { tableId };

    if (!opts.yes) {
      emitJson({
        instance: instance.host,
        preview: true,
        operation: "delete-table",
        request,
        hint: "Preview only — nothing was deleted. Re-run with --yes to delete the data table.",
      });
      return 0;
    }

    await client.deleteDataTable(tableId);
    emitJson({
      instance: instance.host,
      operation: "delete-table",
      deleted: true,
      tableId,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}
