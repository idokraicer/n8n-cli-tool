import { test, expect } from "bun:test";
import { resolveOutputMode, toCliError } from "../src/format";
import { CliError } from "../src/types";

test("--json forces json mode", () => {
  expect(resolveOutputMode({ json: true })).toBe("json");
});

test("--text forces text mode", () => {
  expect(resolveOutputMode({ text: true })).toBe("text");
});

test("toCliError passes a CliError through unchanged", () => {
  const err = new CliError("not-found", "missing");
  expect(toCliError(err)).toBe(err);
});

test("toCliError wraps an unknown error with code n8n-error", () => {
  const wrapped = toCliError(new Error("boom"));
  expect(wrapped).toBeInstanceOf(CliError);
  expect(wrapped.code).toBe("n8n-error");
  expect(wrapped.message).toBe("boom");
});
