import { CliError } from "./types";

export interface TimeWindowOpts {
  from?: string;
  to?: string;
  since?: string;
}

export interface TimeWindow {
  from?: string;
  to?: string;
}

const DURATION_RE = /^(\d+)(m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  w: 7 * 24 * 60 * 60_000,
};

export function hasTimeWindow(opts: TimeWindowOpts): boolean {
  return opts.from !== undefined || opts.to !== undefined || opts.since !== undefined;
}

function parseDateOption(name: "from" | "to" | "since", raw: string): number {
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    const expected =
      name === "since"
        ? "a duration such as 2h or a valid date/time"
        : "a valid date/time";
    throw new CliError(
      "bad-arguments",
      `--${name} must be ${expected} (got "${raw}").`,
    );
  }
  return parsed;
}

function toIso(name: "from" | "to" | "since", value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) {
    const expected =
      name === "since"
        ? "a duration such as 2h or a valid date/time"
        : "a valid date/time";
    throw new CliError(
      "bad-arguments",
      `--${name} must be ${expected}.`,
    );
  }
  return new Date(value).toISOString();
}

export function parseTimeWindow(
  opts: TimeWindowOpts,
  now: Date = new Date(),
): TimeWindow | undefined {
  if (!hasTimeWindow(opts)) return undefined;
  if (opts.from !== undefined && opts.since !== undefined) {
    throw new CliError(
      "bad-arguments",
      "Use only one of --from or --since.",
    );
  }

  const nowMs = now.getTime();
  let fromMs: number | undefined;
  if (opts.from !== undefined) {
    fromMs = parseDateOption("from", opts.from);
  } else if (opts.since !== undefined) {
    const duration = DURATION_RE.exec(opts.since);
    if (duration) {
      const durationMs =
        Number(duration[1]) * UNIT_MS[duration[2].toLowerCase()];
      fromMs = nowMs - durationMs;
      toIso("since", fromMs);
    } else {
      fromMs = parseDateOption("since", opts.since);
    }
  }

  const toMs =
    opts.to !== undefined
      ? parseDateOption("to", opts.to)
      : fromMs !== undefined
        ? nowMs
        : undefined;

  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new CliError(
      "bad-arguments",
      "The execution time lower bound must not be after the upper bound.",
    );
  }

  return {
    ...(fromMs === undefined ? {} : { from: toIso("from", fromMs) }),
    ...(toMs === undefined ? {} : { to: toIso("to", toMs) }),
  };
}
