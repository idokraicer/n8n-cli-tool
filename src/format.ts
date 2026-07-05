import { CliError } from "./types";

export type OutputMode = "json" | "text";

export function resolveOutputMode(opts: {
  json?: boolean;
  text?: boolean;
}): OutputMode {
  if (opts.json) return "json";
  if (opts.text) return "text";
  return process.stdout.isTTY ? "text" : "json";
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("n8n-error", message);
}

export function emitJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

export function progress(message: string, quiet: boolean): void {
  if (!quiet) process.stderr.write(message + "\n");
}

export function emitError(error: CliError, mode: OutputMode): void {
  if (mode === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
            ...(error.hint ? { hint: error.hint } : {}),
          },
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stderr.write(`Error (${error.code}): ${error.message}\n`);
    if (error.hint) process.stderr.write(`  hint: ${error.hint}\n`);
  }
}
