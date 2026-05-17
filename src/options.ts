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
