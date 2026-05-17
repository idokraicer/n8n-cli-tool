import { CliError, type CatalogManifest, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import {
  buildCatalog,
  catalogExists,
  readManifest,
  searchCatalog,
} from "../catalog";
import { emitJson, progress } from "../format";
import { requireIntOption } from "../options";

export interface WorkflowsOpts {
  field?: "id" | "name" | "webhook" | "tag";
  active?: boolean;
  limit?: string;
  offset?: string;
  refresh?: boolean;
  sync?: boolean;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export async function runWorkflows(
  query: string | undefined,
  opts: WorkflowsOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const instance = resolveInstance({ host: opts.instance });
  const quiet = opts.quiet ?? false;

  const needsSync = opts.refresh || !catalogExists(instance.host);
  let manifest: CatalogManifest | null;
  if (needsSync) {
    if (opts.sync === false) {
      throw new CliError(
        "no-catalog",
        `No workflow catalog for ${instance.host}. Run \`n8n-helper sync\` first.`,
      );
    }
    progress(`Syncing workflow catalog for ${instance.host}...`, quiet);
    manifest = await buildCatalog(
      clientFactory(instance),
      instance.host,
      instance.baseUrl,
    );
  } else {
    manifest = readManifest(instance.host);
  }

  const ageSeconds = manifest
    ? Math.round((Date.now() - new Date(manifest.syncedAt).getTime()) / 1000)
    : null;
  if (manifest) {
    progress(
      `Catalog: ${manifest.workflowCount} workflows, synced ${ageSeconds}s ago.`,
      quiet,
    );
  }

  const limit = requireIntOption("limit", opts.limit ?? "50");
  const offset = requireIntOption("offset", opts.offset ?? "0");
  const result = await searchCatalog(instance.host, {
    query,
    field: opts.field,
    active: opts.active,
    limit,
    offset,
  });

  emitJson({
    instance: instance.host,
    catalog: manifest
      ? {
          syncedAt: manifest.syncedAt,
          workflowCount: manifest.workflowCount,
          ageSeconds,
        }
      : null,
    workflows: result.rows,
    summary: {
      totalMatches: result.totalMatches,
      returned: result.rows.length,
      offset,
    },
  });
  return 0;
}
