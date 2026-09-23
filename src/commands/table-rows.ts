import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import {
  parseJsonOption,
  requireFilter,
  requireRecord,
  requireRows,
  type DataTableFilter,
} from "../data-table";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { pageLimitFor, requireIntOption } from "../options";
import { CliError, type ResolvedInstance } from "../types";

// Public output contract exercised by the staged tests (JSON mode):
//   list   -> { instance, rows: Record<string, unknown>[], count, nextCursor }
//   insert -> preview: { preview: true, operation, request: { data, returnType }, hint }
//             write:   { instance, operation, inserted: true, result }
//   update -> preview: { preview: true, operation, request: { filter, data }, hint }
//             dryRun:  { instance, operation, dryRun: true,  persisted: false, result }
//             write:   { instance, operation, dryRun: false, persisted: true,  result }
//   upsert -> same envelope as update, backed by upsertDataTableRow only.
//   delete -> preview: { preview: true, operation, request: { filter }, hint }
//             dryRun:  { instance, operation, dryRun: true,  persisted: false, result }
//             write:   { instance, operation, dryRun: false, persisted: true,  result }
//   clear  -> preview: { preview: true, operation, request: { tableId }, hint }
//             write:   { instance, operation, cleared: true, result }
// Preview envelopes never issue a client call. A real n8n request runs when
// --dry-run or --yes is supplied; unsupported flag combinations are rejected
// (bad-arguments) before a client is resolved.

/** A single `--all` run never returns more than this many rows. */
const ALL_RESULT_CAP = 1000;

export type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

const ROW_RETURN_TYPES = ["count", "id", "all"] as const;
export type RowReturnType = (typeof ROW_RETURN_TYPES)[number];

const DEFAULT_ROW_RETURN_TYPE: RowReturnType = "count";

export interface CommonOpts {
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

export interface WriteOpts extends CommonOpts {
  yes?: boolean;
  dryRun?: boolean;
}

export interface RowsListOpts extends CommonOpts {
  filterInline?: string;
  filterFile?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  sortBy?: string;
  search?: string;
  /** Not supported by list; accepted so the CLI can be rejected loudly. */
  yes?: boolean;
  dryRun?: boolean;
}

export interface RowsInsertOpts extends CommonOpts {
  dataInline?: string;
  dataFile?: string;
  returnType?: string;
  yes?: boolean;
  /** Not supported by insert; accepted so the CLI can be rejected loudly. */
  dryRun?: boolean;
}

export interface RowsWriteOpts extends CommonOpts {
  dataInline?: string;
  dataFile?: string;
  filterInline?: string;
  filterFile?: string;
  returnData?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

export interface RowsDeleteOpts extends CommonOpts {
  filterInline?: string;
  filterFile?: string;
  returnData?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

function requireReturnType(raw: string | undefined): RowReturnType {
  if (raw === undefined) return DEFAULT_ROW_RETURN_TYPE;
  if (!(ROW_RETURN_TYPES as readonly string[]).includes(raw)) {
    throw new CliError(
      "bad-arguments",
      `--return must be one of ${ROW_RETURN_TYPES.join(", ")}.`,
    );
  }
  return raw as RowReturnType;
}

/** `what` is a full clause ending in a period, e.g. "nothing was inserted." */
function previewHint(what: string): string {
  return `Preview only — ${what} Re-run with --yes to apply the change.`;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function runTableRowsList(
  tableId: string,
  opts: RowsListOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    // List is read-only: reject write flags before resolving an instance/client.
    if (opts.yes) {
      throw new CliError(
        "bad-arguments",
        "--yes is not supported by table rows list; list is read-only.",
      );
    }
    if (opts.dryRun) {
      throw new CliError(
        "bad-arguments",
        "--dry-run is not supported by table rows list; list is read-only.",
      );
    }

    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    const limit =
      opts.limit === undefined
        ? undefined
        : requireIntOption("limit", opts.limit);

    const rawFilter = parseJsonOption({
      file: opts.filterFile,
      inline: opts.filterInline,
      label: "filter",
      required: false,
    });
    const filter =
      rawFilter === undefined ? undefined : requireFilter(rawFilter, "filter");

    const rows: Record<string, unknown>[] = [];
    let cursor = opts.cursor;
    let nextCursor: string | null = null;

    for (;;) {
      // `--all` must never over-ask: clamping the requested limit to the
      // remaining capacity keeps the returned cursor pointing at the very next
      // unemitted row instead of skipping records dropped after the request.
      const remaining = ALL_RESULT_CAP - rows.length;
      const pageLimit = pageLimitFor(limit, opts.all, remaining);

      const page = await client.listDataTableRows({
        tableId,
        limit: pageLimit,
        cursor,
        sortBy: opts.sortBy,
        search: opts.search,
        filter,
      });
      rows.push(...page.data);
      nextCursor = page.nextCursor;
      // A plain list is a single page: report the cursor but never follow it.
      if (!opts.all) break;
      // An empty page terminates the run even when the backend advertises a
      // cursor; following it would spin forever.
      if (page.data.length === 0) break;
      if (nextCursor === null) break;
      // Stop at the cap but keep the cursor that would fetch the next row.
      if (rows.length >= ALL_RESULT_CAP) break;
      cursor = nextCursor;
    }

    // Never surface more than the cap, even if one page overshoots it.
    if (rows.length > ALL_RESULT_CAP) rows.length = ALL_RESULT_CAP;

    emitJson({
      instance: instance.host,
      rows,
      count: rows.length,
      nextCursor,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

export async function runTableRowsInsert(
  tableId: string,
  opts: RowsInsertOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    // Insert has no dry-run: reject it (and any --yes combination) up front.
    if (opts.dryRun) {
      throw new CliError(
        "bad-arguments",
        "--dry-run is not supported by table rows insert.",
      );
    }

    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    // Parse all JSON at the command boundary: no API call on bad input.
    const parsed = parseJsonOption({
      file: opts.dataFile,
      inline: opts.dataInline,
      label: "data",
      required: true,
    });
    const data = requireRows(parsed, "data");
    const returnType = requireReturnType(opts.returnType);
    const request = { data, returnType };

    // Safe no-op: never write without an explicit --yes.
    if (!opts.yes) {
      emitJson({
        instance: instance.host,
        preview: true,
        operation: "insert-rows",
        request,
        hint: previewHint("nothing was inserted."),
      });
      return 0;
    }

    const result = await client.insertDataTableRows(tableId, {
      data,
      returnType,
    });
    emitJson({
      instance: instance.host,
      operation: "insert-rows",
      inserted: true,
      result,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// update / upsert
// ---------------------------------------------------------------------------

interface RowsWriteBody {
  filter: DataTableFilter;
  data: Record<string, unknown>;
  returnData: boolean;
  dryRun: boolean;
}

type RowsWriteCall = (
  client: N8nClient,
  tableId: string,
  body: RowsWriteBody,
) => Promise<unknown>;

interface RowsWriteOperation {
  operation: string;
  hint: string;
  call: RowsWriteCall;
}

async function runRowsWrite(
  tableId: string,
  opts: RowsWriteOpts,
  clientFactory: ClientFactory,
  { operation, hint, call }: RowsWriteOperation,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    // Combining the confirmation and the dry-run switch is ambiguous: reject it
    // before resolving an instance/client so no credential or network work runs.
    if (opts.yes && opts.dryRun) {
      throw new CliError(
        "bad-arguments",
        `--yes and --dry-run cannot be combined for table rows ${operation}.`,
      );
    }

    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    // Parse all JSON at the command boundary: no API call on bad input.
    const rawData = parseJsonOption({
      file: opts.dataFile,
      inline: opts.dataInline,
      label: "data",
      required: true,
    });
    const data = requireRecord(rawData, "data");
    const rawFilter = parseJsonOption({
      file: opts.filterFile,
      inline: opts.filterInline,
      label: "filter",
      required: true,
    });
    const filter = requireFilter(rawFilter, "filter");

    const dryRun = Boolean(opts.dryRun);
    const request = { filter, data };

    // Neither --yes nor --dry-run: a safe local preview, no API call.
    if (!opts.yes && !dryRun) {
      emitJson({ instance: instance.host, preview: true, operation, request, hint });
      return 0;
    }

    // A dry-run is a real n8n request that always asks for the returned rows;
    // a live write only returns them when --return-data was requested.
    const body: RowsWriteBody = {
      filter,
      data,
      returnData: dryRun ? true : Boolean(opts.returnData),
      dryRun,
    };

    const result = await call(client, tableId, body);
    emitJson({
      instance: instance.host,
      operation,
      dryRun,
      persisted: !dryRun,
      result,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export function runTableRowsUpdate(
  tableId: string,
  opts: RowsWriteOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  return runRowsWrite(tableId, opts, clientFactory, {
    operation: "update-rows",
    hint: previewHint("nothing was updated."),
    call: (client, id, body) => client.updateDataTableRows(id, body),
  });
}

export function runTableRowsUpsert(
  tableId: string,
  opts: RowsWriteOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  // Atomic: exactly one upsert request, no client-side list/insert/update
  // lookup, no retry fallback.
  return runRowsWrite(tableId, opts, clientFactory, {
    operation: "upsert-rows",
    hint: previewHint("nothing was upserted."),
    call: (client, id, body) => client.upsertDataTableRow(id, body),
  });
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export async function runTableRowsDelete(
  tableId: string,
  opts: RowsDeleteOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    if (opts.yes && opts.dryRun) {
      throw new CliError(
        "bad-arguments",
        "--yes and --dry-run cannot be combined for table rows delete.",
      );
    }

    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    const rawFilter = parseJsonOption({
      file: opts.filterFile,
      inline: opts.filterInline,
      label: "filter",
      required: true,
    });
    const filter = requireFilter(rawFilter, "filter");
    const request = { filter };

    if (!opts.yes && !opts.dryRun) {
      emitJson({
        instance: instance.host,
        preview: true,
        operation: "delete-rows",
        request,
        hint: previewHint("nothing was deleted."),
      });
      return 0;
    }

    const dryRun = Boolean(opts.dryRun);
    const result = await client.deleteDataTableRows(tableId, {
      filter,
      returnData: dryRun ? true : Boolean(opts.returnData),
      dryRun,
    });
    emitJson({
      instance: instance.host,
      operation: "delete-rows",
      dryRun,
      persisted: !dryRun,
      result,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

export async function runTableRowsClear(
  tableId: string,
  opts: WriteOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    // Clear does not support dry-run: reject it before resolving a client.
    if (opts.dryRun) {
      throw new CliError(
        "bad-arguments",
        "--dry-run is not supported by table rows clear.",
      );
    }

    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);
    const request = { tableId };

    if (!opts.yes) {
      emitJson({
        instance: instance.host,
        preview: true,
        operation: "clear-rows",
        request,
        hint: previewHint("nothing was cleared."),
      });
      return 0;
    }

    const result = await client.clearDataTableRows(tableId);
    emitJson({
      instance: instance.host,
      operation: "clear-rows",
      cleared: true,
      result,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}
