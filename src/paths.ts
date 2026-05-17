const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function formatPath(segments: Array<string | number>): string {
  let out = "json";
  for (const seg of segments) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else if (IDENTIFIER_RE.test(seg)) {
      out += `.${seg}`;
    } else {
      out += `[${JSON.stringify(seg)}]`;
    }
  }
  return out;
}

export function parsePath(path: string): Array<string | number> {
  let rest = path.trim();
  if (rest !== "json" && !rest.startsWith("json.") && !rest.startsWith("json["))
    throw new Error(`Path must be rooted at "json": ${path}`);
  rest = rest.slice("json".length);
  const segments: Array<string | number> = [];
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const m = rest.match(/^\.([A-Za-z_$][\w$]*)/);
      if (!m) throw new Error(`Invalid path segment near: ${rest}`);
      segments.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end === -1) throw new Error(`Unclosed bracket in path: ${path}`);
      const inner = rest.slice(1, end);
      if (/^\d+$/.test(inner)) {
        segments.push(Number(inner));
      } else {
        segments.push(JSON.parse(inner) as string);
      }
      rest = rest.slice(end + 1);
    } else {
      throw new Error(`Invalid path near: ${rest}`);
    }
  }
  return segments;
}

export function resolvePath(
  root: unknown,
  segments: Array<string | number>,
): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (typeof seg === "number") {
      if (!Array.isArray(current) || seg >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[seg];
    } else {
      if (!(seg in (current as Record<string, unknown>))) {
        return { found: false, value: undefined };
      }
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return { found: true, value: current };
}
