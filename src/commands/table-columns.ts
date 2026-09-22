import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import {
  requireColumnType,
  type DataTableColumnInput,
} from "../data-table";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { requireIntOption } from "../options";
import { CliError, type ResolvedInstance } from "../types";
import type { CommonOpts, WriteOpts } from "./table";

// Public output contract exercised by the staged tests (JSON mode):
//   list   -> { instance, columns: DataTableColumn[], count: number }
//             The columns endpoint returns a bare array, not a cursor page.
//   add    -> preview: { preview: true, operation: "add-column", request: { tableId, name, type, index? }, hint }
//             write:   { instance, operation: "add-column", added: true, column: DataTableColumn }
//   update -> preview: { preview: true, operation: "update-column", request: { tableId, columnId, name?, index? }, hint }
//             write:   { instance, operation: "update-column", updated: true, column: DataTableColumn }
//   delete -> preview: { preview: true, operation: "delete-column", request: { tableId, columnId }, hint }
//             write:   { instance, operation: "delete-column", deleted: true, tableId, columnId }
// Preview envelopes never issue a client call; the write booleans require --yes.
// `--type` is validated against the supported column types and `--index` must be
// a non-negative integer, both rejected before any client call is made.

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export interface ColumnAddOpts extends CommonOpts {
  index?: string;
  yes?: boolean;
}

export interface ColumnUpdateOpts extends CommonOpts {
  name?: string;
  index?: string;
  yes?: boolean;
}

export async function runTableColumnsList(
  tableId: string,
  opts: CommonOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);
    // The columns endpoint returns a bare array, not a cursor page.
    const columns = await client.listDataTableColumns(tableId);
    emitJson({ instance: instance.host, columns, count: columns.length });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export async function runTableColumnsAdd(
  tableId: string,
  name: string,
  type: string,
  opts: ColumnAddOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    // Validate at the command boundary: no API call on bad input.
    const columnType = requireColumnType(type);
    const index =
      opts.index === undefined
        ? undefined
        : requireIntOption("index", opts.index);
    const body: DataTableColumnInput =
      index === undefined
        ? { name, type: columnType }
        : { name, type: columnType, index };

    // Safe no-op: never write without an explicit --yes.
    if (!opts.yes) {
      emitJson({
        preview: true,
        operation: "add-column",
        request: { tableId, ...body },
        hint: "Preview only - nothing was added. Re-run with --yes to add the column.",
      });
      return 0;
    }

    const column = await client.addDataTableColumn(tableId, body);
    emitJson({
      instance: instance.host,
      operation: "add-column",
      added: true,
      column,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export async function runTableColumnsUpdate(
  tableId: string,
  columnId: string,
  opts: ColumnUpdateOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    // Validate at the command boundary: no API call on bad input.
    const name = opts.name;
    const index =
      opts.index === undefined
        ? undefined
        : requireIntOption("index", opts.index);

    // At least one field is required; supplying both in one request is allowed.
    if (name === undefined && index === undefined) {
      throw new CliError(
        "bad-arguments",
        "Provide --name and/or --index to update a column.",
      );
    }

    const body: { name?: string; index?: number } = {};
    if (name !== undefined) body.name = name;
    if (index !== undefined) body.index = index;

    // Safe no-op: never write without an explicit --yes.
    if (!opts.yes) {
      emitJson({
        preview: true,
        operation: "update-column",
        request: { tableId, columnId, ...body },
        hint: "Preview only - nothing was updated. Re-run with --yes to update the column.",
      });
      return 0;
    }

    const column = await client.updateDataTableColumn(tableId, columnId, body);
    emitJson({
      instance: instance.host,
      operation: "update-column",
      updated: true,
      column,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export async function runTableColumnsDelete(
  tableId: string,
  columnId: string,
  opts: WriteOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    // Safe no-op: never write without an explicit --yes.
    if (!opts.yes) {
      emitJson({
        preview: true,
        operation: "delete-column",
        request: { tableId, columnId },
        hint: "Preview only - nothing was deleted. Re-run with --yes to delete the column.",
      });
      return 0;
    }

    await client.deleteDataTableColumn(tableId, columnId);
    emitJson({
      instance: instance.host,
      operation: "delete-column",
      deleted: true,
      tableId,
      columnId,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}
