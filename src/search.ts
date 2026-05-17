import type { Match, MatchMode, SearchUnit } from "./types";
import { formatPath } from "./paths";

export interface SearchOptions {
  mode: MatchMode;
  caseSensitive: boolean;
  node?: string;
  maxMatches: number;
  context: boolean;
  truncate: number | null;
}

export interface SearchResult {
  matches: Match[];
  truncated: boolean;
  itemsSearched: number;
}

const BINARY_META_FIELDS = ["fileName", "mimeType", "fileExtension"];

function makeMatcher(
  value: string,
  mode: MatchMode,
  caseSensitive: boolean,
): (haystack: string) => boolean {
  if (mode === "regex") {
    const re = new RegExp(value, caseSensitive ? "" : "i");
    return (h) => re.test(h);
  }
  const needle = caseSensitive ? value : value.toLowerCase();
  return (raw) => {
    const h = caseSensitive ? raw : raw.toLowerCase();
    return mode === "exact" ? h === needle : h.includes(needle);
  };
}

function truncateValue(text: string, limit: number | null): string {
  if (limit === null || text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

export function searchUnits(
  units: SearchUnit[],
  value: string,
  options: SearchOptions,
  ctx: { executionId: string; url: string },
): SearchResult {
  const matches: Match[] = [];
  const matcher = makeMatcher(value, options.mode, options.caseSensitive);
  let itemsSearched = 0;
  let truncated = false;

  const scalar = (node: unknown): node is string | number | boolean =>
    node === null ||
    ["string", "number", "boolean"].includes(typeof node);

  for (const unit of units) {
    if (options.node && unit.node !== options.node) continue;
    if (matches.length >= options.maxMatches) {
      truncated = true;
      break;
    }
    itemsSearched++;

    const record = (
      path: string,
      raw: unknown,
      parent: unknown,
    ): boolean => {
      if (raw === null || raw === undefined) return false;
      const text = String(raw);
      if (!matcher(text)) return false;
      matches.push({
        executionId: ctx.executionId,
        node: unit.node,
        runIndex: unit.runIndex,
        outputIndex: unit.outputIndex,
        itemIndex: unit.itemIndex,
        path,
        value: truncateValue(text, options.truncate),
        valueType: typeof raw,
        url: ctx.url,
        ...(options.context ? { context: parent } : {}),
      });
      if (matches.length >= options.maxMatches) {
        truncated = true;
        return true;
      }
      return false;
    };

    const walk = (
      node: unknown,
      segments: Array<string | number>,
      parent: unknown,
    ): boolean => {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (walk(node[i], [...segments, i], node)) return true;
        }
        return false;
      }
      if (node !== null && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          if (walk(child, [...segments, key], node)) return true;
        }
        return false;
      }
      if (scalar(node)) {
        return record(formatPath(segments), node, parent);
      }
      return false;
    };

    if (walk(unit.json, [], unit.json)) break;

    if (unit.binary) {
      let stop = false;
      for (const [key, meta] of Object.entries(unit.binary)) {
        if (meta === null || typeof meta !== "object") continue;
        for (const field of BINARY_META_FIELDS) {
          const raw = (meta as Record<string, unknown>)[field];
          if (raw === undefined) continue;
          if (record(`binary.${key}.${field}`, raw, meta)) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
      if (stop) break;
    }
  }

  return { matches, truncated, itemsSearched };
}
