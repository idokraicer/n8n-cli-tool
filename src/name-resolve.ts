import { searchCatalog, type CatalogQuery } from "./catalog";
import type { N8nClient } from "./client";
import { CliError, type WorkflowRow } from "./types";
import { parseN8nUrl } from "./url";

type CatalogSearch = (
  host: string,
  q: CatalogQuery,
) => Promise<{ rows: WorkflowRow[]; totalMatches: number }>;

interface ResolveWorkflowRefOptions {
  host: string;
  client: N8nClient;
  catalogSearch?: CatalogSearch;
}

interface WorkflowMatch {
  id: string;
  name: string;
  url: string;
}

function workflowUrl(host: string, id: string): string {
  const baseUrl = /^https?:\/\//.test(host) ? host : `https://${host}`;
  return `${baseUrl.replace(/\/+$/, "")}/workflow/${id}`;
}

function collisionError(ref: string, matches: WorkflowMatch[]): CliError {
  const descriptions = matches
    .map((match) => `${match.id} (${match.url})`)
    .join(", ");
  return new CliError(
    "bad-arguments",
    `Multiple workflows named '${ref}': ${descriptions}`,
    { candidates: matches },
    "The name is ambiguous — re-run with one of the listed ids or a full workflow URL instead of the name.",
  );
}

export async function resolveWorkflowRef(
  ref: string,
  opts: ResolveWorkflowRefOptions,
): Promise<{ id: string; name: string }> {
  const parsed = parseN8nUrl(ref);
  if (parsed?.kind === "workflow") {
    return { id: parsed.workflowId, name: ref };
  }

  const catalogSearch = opts.catalogSearch ?? searchCatalog;
  // field:"name" is substring-based, so exact-name duplicates can span more
  // than one page — walk every page or a collision past the first window is
  // silently reported as a single match.
  const CATALOG_PAGE = 1000;
  const catalogRows: WorkflowRow[] = [];
  let offset = 0;
  for (;;) {
    const page = await catalogSearch(opts.host, {
      query: ref,
      field: "name",
      limit: CATALOG_PAGE,
      offset,
    });
    catalogRows.push(...page.rows);
    offset += CATALOG_PAGE;
    if (page.rows.length === 0 || offset >= page.totalMatches) break;
  }
  const catalogMatches = catalogRows
    .filter((row) => row.name === ref)
    .map((row) => ({ id: row.id, name: row.name, url: row.url }));

  if (catalogMatches.length === 1) {
    const [match] = catalogMatches;
    return { id: match.id, name: match.name };
  }
  if (catalogMatches.length > 1) {
    throw collisionError(ref, catalogMatches);
  }

  const liveMatches: WorkflowMatch[] = [];
  let cursor: string | undefined;
  do {
    const page = await opts.client.listWorkflows({ limit: 250, cursor });
    for (const workflow of page.data) {
      const name = String(workflow.name ?? "");
      if (name !== ref) continue;
      const id = String(workflow.id);
      liveMatches.push({
        id,
        name,
        url: String(workflow.url ?? workflowUrl(opts.host, id)),
      });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  if (liveMatches.length === 1) {
    const [match] = liveMatches;
    return { id: match.id, name: match.name };
  }
  if (liveMatches.length > 1) {
    throw collisionError(ref, liveMatches);
  }

  return { id: ref, name: ref };
}
