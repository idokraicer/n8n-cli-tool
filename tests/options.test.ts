import { test, expect } from "bun:test";
import { requireIntOption, optionalIntOption } from "../src/options";
import { CliError } from "../src/types";

test("requireIntOption parses a valid integer", () => {
  expect(requireIntOption("limit", "20")).toBe(20);
});

test("requireIntOption rejects a non-numeric value", () => {
  expect(() => requireIntOption("limit", "abc")).toThrow(CliError);
});

test("requireIntOption rejects a negative value", () => {
  expect(() => requireIntOption("limit", "-1")).toThrow(CliError);
});

test("requireIntOption rejects a fractional value", () => {
  expect(() => requireIntOption("limit", "1.5")).toThrow(CliError);
});

test("optionalIntOption returns undefined for a missing value", () => {
  expect(optionalIntOption("run", undefined)).toBeUndefined();
});

test("optionalIntOption parses a present value", () => {
  expect(optionalIntOption("run", "3")).toBe(3);
});

test("the thrown error has code bad-arguments", () => {
  try {
    requireIntOption("limit", "abc");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as CliError).code).toBe("bad-arguments");
  }
});
