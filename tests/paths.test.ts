import { test, expect } from "bun:test";
import { formatPath, parsePath, resolvePath } from "../src/paths";

test("formats segments rooted at json", () => {
  expect(formatPath(["order", "items", 2, "id"])).toBe(
    "json.order.items[2].id",
  );
});

test("formats non-identifier keys with bracket-quote notation", () => {
  expect(formatPath(["weird key"])).toBe('json["weird key"]');
});

test("formats an empty segment list as the root", () => {
  expect(formatPath([])).toBe("json");
});

test("parses a path back into segments", () => {
  expect(parsePath("json.order.items[2].id")).toEqual([
    "order",
    "items",
    2,
    "id",
  ]);
});

test("parses bracket-quote keys", () => {
  expect(parsePath('json["weird key"]')).toEqual(["weird key"]);
});

test("resolves a path against nested data", () => {
  const data = { order: { items: [{ id: "A" }, { id: "B" }] } };
  expect(resolvePath(data, ["order", "items", 1, "id"])).toEqual({
    found: true,
    value: "B",
  });
});

test("reports a missing path as not found", () => {
  expect(resolvePath({ a: 1 }, ["a", "b"])).toEqual({
    found: false,
    value: undefined,
  });
});

test("round-trips a key containing a closing bracket", () => {
  const segments = ["key]broken"];
  expect(parsePath(formatPath(segments))).toEqual(segments);
});

test("throws on an unclosed bracket", () => {
  expect(() => parsePath("json[unclosed")).toThrow();
});

test("parses the root path back to an empty segment list", () => {
  expect(parsePath("json")).toEqual([]);
});
