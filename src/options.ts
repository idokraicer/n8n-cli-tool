import { CliError } from "./types";

export function requireIntOption(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(
      "bad-arguments",
      `--${name} must be a non-negative integer (got "${raw}").`,
    );
  }
  return value;
}

export function optionalIntOption(
  name: string,
  raw: string | undefined,
): number | undefined {
  return raw === undefined ? undefined : requireIntOption(name, raw);
}

const MAX_API_PAGE_SIZE = 250;

export function pageLimitFor(
  limit: number | undefined,
  all: boolean | undefined,
  remaining: number,
): number | undefined {
  if (limit === 0) {
    throw new CliError("bad-arguments", "--limit must be greater than zero.");
  }
  if (!all) return limit === undefined ? undefined : Math.min(limit, MAX_API_PAGE_SIZE);
  return Math.min(limit ?? MAX_API_PAGE_SIZE, MAX_API_PAGE_SIZE, remaining);
}
