import { readFileSync } from "node:fs";
import { CliError } from "./types";

export const DATA_TABLE_COLUMN_TYPES = [
  "string",
  "number",
  "boolean",
  "date",
] as const;

export type DataTableColumnType = (typeof DATA_TABLE_COLUMN_TYPES)[number];

export type DataTableFilterCondition =
  | "eq"
  | "neq"
  | "like"
  | "ilike"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

const DATA_TABLE_FILTER_CONDITIONS: readonly DataTableFilterCondition[] = [
  "eq",
  "neq",
  "like",
  "ilike",
  "gt",
  "gte",
  "lt",
  "lte",
];

const COLUMN_TYPE_SET: ReadonlySet<string> = new Set(DATA_TABLE_COLUMN_TYPES);
const FILTER_CONDITION_SET: ReadonlySet<string> = new Set(
  DATA_TABLE_FILTER_CONDITIONS,
);

export interface DataTableFilterRule {
  columnName: string;
  condition: DataTableFilterCondition;
  value: unknown;
}

export interface DataTableFilter {
  type: "and" | "or";
  filters: DataTableFilterRule[];
}

export interface DataTableColumn {
  id: string;
  name: string;
  type: DataTableColumnType;
  index: number;
  dataTableId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DataTableColumnInput {
  name: string;
  type: DataTableColumnType;
  index?: number;
}

export interface DataTable {
  id: string;
  name: string;
  projectId: string;
  columns: DataTableColumn[];
  createdAt: string;
  updatedAt: string;
  sizeBytes?: number;
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColumnType(value: string): value is DataTableColumnType {
  return COLUMN_TYPE_SET.has(value);
}

function isFilterCondition(value: unknown): value is DataTableFilterCondition {
  return typeof value === "string" && FILTER_CONDITION_SET.has(value);
}

function parseJsonText(text: string, label: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(
      "bad-arguments",
      `Invalid JSON in ${label} ${source}: ${errorMessage(err)}`,
    );
  }
}

export function parseJsonOption(input: {
  file?: string;
  inline?: string;
  label: string;
  required: boolean;
}): unknown | undefined {
  const { file, inline, label, required } = input;
  if (file !== undefined && inline !== undefined) {
    throw new CliError(
      "bad-arguments",
      `Provide only one of --${label}-file or --${label}-json.`,
    );
  }
  if (file !== undefined) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new CliError(
        "bad-arguments",
        `Could not read ${label} file ${file}: ${errorMessage(err)}`,
      );
    }
    return parseJsonText(text, label, `file ${file}`);
  }
  if (inline !== undefined) {
    return parseJsonText(inline, label, "inline value");
  }
  if (required) {
    throw new CliError(
      "bad-arguments",
      `${label} is required; provide --${label}-file or --${label}-json.`,
    );
  }
  return undefined;
}

export function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CliError("bad-arguments", `${label} must be a JSON object.`);
  }
  return value;
}

export function requireRows(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new CliError(
        "bad-arguments",
        `${label} must contain at least one row.`,
      );
    }
    return value.map((row, index) => requireRecord(row, `${label}[${index}]`));
  }
  if (isRecord(value)) {
    return [value];
  }
  throw new CliError(
    "bad-arguments",
    `${label} must be a JSON object or an array of objects.`,
  );
}

function requireFilterRule(value: unknown, label: string): DataTableFilterRule {
  const record = requireRecord(value, label);
  const columnName = record.columnName;
  if (typeof columnName !== "string" || columnName.length === 0) {
    throw new CliError(
      "bad-arguments",
      `${label}.columnName must be a non-empty string.`,
    );
  }
  const condition = record.condition;
  if (!isFilterCondition(condition)) {
    throw new CliError(
      "bad-arguments",
      `${label}.condition must be one of eq, neq, like, ilike, gt, gte, lt, lte.`,
    );
  }
  if (!("value" in record)) {
    throw new CliError("bad-arguments", `${label}.value is required.`);
  }
  return { columnName, condition, value: record.value };
}

export function requireFilter(value: unknown, label: string): DataTableFilter {
  const record = requireRecord(value, label);
  const type = record.type;
  if (type !== "and" && type !== "or") {
    throw new CliError("bad-arguments", `${label}.type must be "and" or "or".`);
  }
  const rawFilters = record.filters;
  if (!Array.isArray(rawFilters)) {
    throw new CliError(
      "bad-arguments",
      `${label}.filters must be an array of rules.`,
    );
  }
  if (rawFilters.length === 0) {
    throw new CliError(
      "bad-arguments",
      `${label}.filters must contain at least one rule.`,
    );
  }
  const filters = rawFilters.map((raw, index) =>
    requireFilterRule(raw, `${label}.filters[${index}]`),
  );
  return { type, filters };
}

function requireColumnInput(
  value: unknown,
  label: string,
): DataTableColumnInput {
  const record = requireRecord(value, label);
  const name = record.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new CliError(
      "bad-arguments",
      `${label}.name must be a non-empty string.`,
    );
  }
  const rawType = record.type;
  if (typeof rawType !== "string") {
    throw new CliError(
      "bad-arguments",
      `${label}.type must be one of ${DATA_TABLE_COLUMN_TYPES.join(", ")}.`,
    );
  }
  const type = requireColumnType(rawType);
  const index = record.index;
  if (index === undefined) {
    return { name, type };
  }
  if (typeof index !== "number" || !Number.isInteger(index)) {
    throw new CliError("bad-arguments", `${label}.index must be an integer.`);
  }
  return { name, type, index };
}

export function requireColumns(
  value: unknown,
  label: string,
): DataTableColumnInput[] {
  if (!Array.isArray(value)) {
    throw new CliError(
      "bad-arguments",
      `${label} must be an array of column definitions.`,
    );
  }
  return value.map((raw, index) =>
    requireColumnInput(raw, `${label}[${index}]`),
  );
}

export function requireColumnType(value: string): DataTableColumnType {
  if (!isColumnType(value)) {
    throw new CliError(
      "bad-arguments",
      `Unsupported column type "${value}"; expected one of ${DATA_TABLE_COLUMN_TYPES.join(", ")}.`,
    );
  }
  return value;
}
