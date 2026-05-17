import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import type { CatalogManifest, WorkflowRow } from "./types";
import type { N8nClient } from "./client";
import { catalogPaths } from "./config";
import { extractWebhooks } from "./webhooks";
import { buildWorkflowUrl } from "./url";

const SCHEMA_VERSION = 1;

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t: any) => (typeof t === "string" ? t : String(t?.name ?? ""))).filter(Boolean);
}

export function projectWorkflow(raw: any, baseUrl: string): WorkflowRow {
  const id = String(raw.id);
  return {
    id,
    name: String(raw.name ?? ""),
    active: Boolean(raw.active),
    isArchived: Boolean(raw.isArchived),
    tags: normalizeTags(raw.tags),
    triggerCount: Number(raw.triggerCount ?? 0),
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
    webhooks: extractWebhooks(raw.nodes, baseUrl),
    url: buildWorkflowUrl(baseUrl, id),
  };
}

export async function buildCatalog(
  client: N8nClient,
  host: string,
  baseUrl: string,
  onProgress?: (count: number) => void,
): Promise<CatalogManifest> {
  const paths = catalogPaths(host);
  mkdirSync(paths.dir, { recursive: true });
  const tmpWorkflows = `${paths.workflowsPath}.tmp`;
  const tmpManifest = `${paths.manifestPath}.tmp`;
  writeFileSync(tmpWorkflows, "");

  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await client.listWorkflows({ limit: 250, cursor });
    const lines = page.data
      .map((raw) => JSON.stringify(projectWorkflow(raw, baseUrl)))
      .join("\n");
    if (lines.length > 0) appendFileSync(tmpWorkflows, lines + "\n");
    count += page.data.length;
    onProgress?.(count);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const manifest: CatalogManifest = {
    schemaVersion: SCHEMA_VERSION,
    instance: host,
    baseUrl,
    syncedAt: new Date().toISOString(),
    workflowCount: count,
  };
  writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmpWorkflows, paths.workflowsPath);
  renameSync(tmpManifest, paths.manifestPath);
  return manifest;
}

export function catalogExists(host: string): boolean {
  const paths = catalogPaths(host);
  return existsSync(paths.manifestPath) && existsSync(paths.workflowsPath);
}

export function readManifest(host: string): CatalogManifest | null {
  const paths = catalogPaths(host);
  if (!existsSync(paths.manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(paths.manifestPath, "utf8")) as CatalogManifest;
  } catch {
    return null;
  }
}

export async function* streamCatalog(host: string): AsyncGenerator<WorkflowRow> {
  const paths = catalogPaths(host);
  if (!existsSync(paths.workflowsPath)) return;
  const rl = createInterface({
    input: createReadStream(paths.workflowsPath, "utf8"),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      yield JSON.parse(trimmed) as WorkflowRow;
    }
  } finally {
    rl.close();
  }
}

export interface CatalogQuery {
  query?: string;
  field?: "id" | "name" | "webhook" | "tag";
  active?: boolean;
  limit: number;
  offset: number;
}

function rowMatches(row: WorkflowRow, query: string, field?: string): boolean {
  const q = query.toLowerCase();
  const inId = () => row.id.toLowerCase().includes(q);
  const inName = () => row.name.toLowerCase().includes(q);
  const inTag = () => row.tags.some((t) => t.toLowerCase().includes(q));
  const inWebhook = () =>
    row.webhooks.some(
      (w) =>
        w.path.toLowerCase().includes(q) ||
        w.productionUrl.toLowerCase().includes(q) ||
        w.testUrl.toLowerCase().includes(q),
    );
  if (field === "id") return inId();
  if (field === "name") return inName();
  if (field === "tag") return inTag();
  if (field === "webhook") return inWebhook();
  return inId() || inName() || inTag() || inWebhook();
}

export async function searchCatalog(
  host: string,
  q: CatalogQuery,
): Promise<{ rows: WorkflowRow[]; totalMatches: number }> {
  const window: WorkflowRow[] = [];
  const windowEnd = q.offset + q.limit;
  let totalMatches = 0;
  for await (const row of streamCatalog(host)) {
    if (q.active !== undefined && row.active !== q.active) continue;
    if (q.query && !rowMatches(row, q.query, q.field)) continue;
    if (totalMatches >= q.offset && totalMatches < windowEnd) {
      window.push(row);
    }
    totalMatches++;
  }
  return { rows: window, totalMatches };
}
