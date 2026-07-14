import { expect, test } from "bun:test";
import { hasTimeWindow, parseTimeWindow } from "../src/time-window";

const NOW = new Date("2026-07-14T08:00:00.000Z");

test("hasTimeWindow detects each supported option", () => {
  expect(hasTimeWindow({})).toBe(false);
  expect(hasTimeWindow({ from: "2026-07-14" })).toBe(true);
  expect(hasTimeWindow({ to: "2026-07-14" })).toBe(true);
  expect(hasTimeWindow({ since: "2h" })).toBe(true);
});

test("parseTimeWindow resolves a relative duration and defaults to now", () => {
  expect(parseTimeWindow({ since: "2h" }, NOW)).toEqual({
    from: "2026-07-14T06:00:00.000Z",
    to: "2026-07-14T08:00:00.000Z",
  });
});

test("parseTimeWindow accepts absolute bounds and normalizes them", () => {
  expect(
    parseTimeWindow(
      {
        from: "2026-07-14T09:00:00+03:00",
        to: "2026-07-14T10:30:00+03:00",
      },
      NOW,
    ),
  ).toEqual({
    from: "2026-07-14T06:00:00.000Z",
    to: "2026-07-14T07:30:00.000Z",
  });
});

test("parseTimeWindow uses local-time Date parsing for unzoned values", () => {
  const raw = "2026-07-14 09:00";
  const later = new Date("2026-07-14T12:00:00.000Z");
  expect(parseTimeWindow({ from: raw }, later)).toEqual({
    from: new Date(raw).toISOString(),
    to: later.toISOString(),
  });
});

test("parseTimeWindow accepts --to without a lower bound", () => {
  expect(parseTimeWindow({ to: "2026-07-14T07:30:00Z" }, NOW)).toEqual({
    to: "2026-07-14T07:30:00.000Z",
  });
});

test("parseTimeWindow accepts an absolute --since value", () => {
  expect(
    parseTimeWindow({ since: "2026-07-14T06:00:00Z" }, NOW),
  ).toEqual({
    from: "2026-07-14T06:00:00.000Z",
    to: NOW.toISOString(),
  });
});

test("parseTimeWindow rejects --from with --since", () => {
  expect(() =>
    parseTimeWindow({ from: "2026-07-14", since: "2h" }, NOW),
  ).toThrow("Use only one of --from or --since");
});

test("parseTimeWindow rejects invalid values", () => {
  expect(() => parseTimeWindow({ since: "two hours" }, NOW)).toThrow(
    "--since must be",
  );
  expect(() => parseTimeWindow({ from: "not-a-date" }, NOW)).toThrow(
    "--from must be",
  );
  expect(() =>
    parseTimeWindow({ since: "999999999999999999999999h" }, NOW),
  ).toThrow("--since must be");
});

test("parseTimeWindow rejects a reversed range", () => {
  expect(() =>
    parseTimeWindow(
      {
        from: "2026-07-14T08:00:00Z",
        to: "2026-07-14T07:00:00Z",
      },
      NOW,
    ),
  ).toThrow("must not be after");
});

test("parseTimeWindow returns undefined when no filter is present", () => {
  expect(parseTimeWindow({}, NOW)).toBeUndefined();
});
