import { test, expect } from "bun:test";
import { searchUnits, type SearchOptions } from "../src/search";
import type { SearchUnit } from "../src/types";

const ctx = { executionId: "1", url: "https://h.co/x" };

function units(json: unknown): SearchUnit[] {
  return [{ node: "N", runIndex: 0, outputIndex: 0, itemIndex: 0, json, binary: undefined }];
}

const base: SearchOptions = {
  mode: "substring",
  caseSensitive: false,
  maxMatches: 100,
  context: false,
  truncate: 200,
};

test("finds a substring match and records its path", () => {
  const r = searchUnits(units({ order: { id: "500857721" } }), "5008", base, ctx);
  expect(r.matches.length).toBe(1);
  expect(r.matches[0].path).toBe("json.order.id");
  expect(r.matches[0].value).toBe("500857721");
  expect(r.matches[0].valueType).toBe("string");
});

test("matches numeric values by string form", () => {
  const r = searchUnits(units({ n: 42 }), "42", base, ctx);
  expect(r.matches.length).toBe(1);
  expect(r.matches[0].valueType).toBe("number");
});

test("exact mode rejects a substring", () => {
  const r = searchUnits(units({ a: "hello world" }), "hello", { ...base, mode: "exact" }, ctx);
  expect(r.matches.length).toBe(0);
});

test("regex mode matches a pattern", () => {
  const r = searchUnits(units({ a: "abc123" }), "[0-9]+", { ...base, mode: "regex" }, ctx);
  expect(r.matches.length).toBe(1);
});

test("case-sensitive mode respects case", () => {
  const r = searchUnits(units({ a: "HELLO" }), "hello", { ...base, caseSensitive: true }, ctx);
  expect(r.matches.length).toBe(0);
});

test("the node filter excludes other nodes", () => {
  const us: SearchUnit[] = [
    { node: "A", runIndex: 0, outputIndex: 0, itemIndex: 0, json: { v: "x" }, binary: undefined },
    { node: "B", runIndex: 0, outputIndex: 0, itemIndex: 0, json: { v: "x" }, binary: undefined },
  ];
  const r = searchUnits(us, "x", { ...base, node: "B" }, ctx);
  expect(r.matches.length).toBe(1);
  expect(r.matches[0].node).toBe("B");
});

test("max-matches caps results and flags truncation", () => {
  const r = searchUnits(units({ a: "x", b: "x", c: "x" }), "x", { ...base, maxMatches: 2 }, ctx);
  expect(r.matches.length).toBe(2);
  expect(r.truncated).toBe(true);
});

test("truncate shortens long values", () => {
  const long = "y".repeat(50);
  const r = searchUnits(units({ a: long }), "y", { ...base, truncate: 10 }, ctx);
  expect(r.matches[0].value).toBe("yyyyyyyyyy…");
});

test("context captures the parent container", () => {
  const r = searchUnits(units({ order: { id: "A", status: "paid" } }), "A", { ...base, context: true }, ctx);
  expect(r.matches[0].context).toEqual({ id: "A", status: "paid" });
});

test("searches binary metadata fields", () => {
  const us: SearchUnit[] = [{
    node: "N", runIndex: 0, outputIndex: 0, itemIndex: 0,
    json: {}, binary: { data0: { fileName: "invoice.pdf", mimeType: "application/pdf" } },
  }];
  const r = searchUnits(us, "invoice", base, ctx);
  expect(r.matches.length).toBe(1);
  expect(r.matches[0].path).toBe("binary.data0.fileName");
});
