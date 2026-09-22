import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseJsonOption, requireColumnType, requireColumns, requireFilter, requireRecord, requireRows } from "../src/data-table";

let dir = "";
let jsonPath = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "n8n-table-test-"));
  jsonPath = join(dir, "input.json");
  writeFileSync(jsonPath, JSON.stringify({ value: 1 }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("parseJsonOption reads file or inline JSON and rejects conflicts", () => {
  expect(parseJsonOption({ file: jsonPath, label: "data", required: true })).toEqual({ value: 1 });
  expect(parseJsonOption({ inline: "{\"value\":2}", label: "data", required: true })).toEqual({ value: 2 });
  expect(() => parseJsonOption({ file: jsonPath, inline: "{}", label: "data", required: true })).toThrow(/only one/i);
  expect(() => parseJsonOption({ label: "data", required: true })).toThrow(/required/i);
  expect(parseJsonOption({ label: "filter", required: false })).toBeUndefined();
});

test("validators construct only supported records, rows, filters, columns, and types", () => {
  expect(requireRecord({ status: "active" }, "data")).toEqual({ status: "active" });
  expect(requireRows({ status: "active" }, "data")).toEqual([{ status: "active" }]);
  expect(requireRows([{ status: "active" }], "data")).toEqual([{ status: "active" }]);
  expect(requireFilter({ type: "and", filters: [{ columnName: "id", condition: "gte", value: 1 }] }, "filter").filters).toHaveLength(1);
  expect(requireColumns([{ name: "email", type: "string" }], "columns")).toEqual([{ name: "email", type: "string" }]);
  expect(requireColumnType("date")).toBe("date");
  expect(() => requireRecord([], "data")).toThrow(/object/i);
  expect(() => requireRows([], "data")).toThrow(/at least one/i);
  expect(() => requireFilter({ type: "and", filters: [] }, "filter")).toThrow(/at least one/i);
  expect(() => requireColumns([{ name: "payload", type: "json" }], "columns")).toThrow(/string.*number.*boolean.*date/i);
  expect(() => requireColumnType("json")).toThrow(/string.*number.*boolean.*date/i);
});
