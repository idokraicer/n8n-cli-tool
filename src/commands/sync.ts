import type { ResolvedInstance } from "../types";
import { resolveInstance, catalogPaths } from "../config";
import { N8nClient } from "../client";
import { buildCatalog } from "../catalog";
import { emitJson, progress } from "../format";

export interface SyncOpts {
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export async function runSync(
  opts: SyncOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const instance = resolveInstance({ host: opts.instance });
  const client = clientFactory(instance);

  progress(`Syncing workflows from ${instance.host}...`, opts.quiet ?? false);
  const manifest = await buildCatalog(
    client,
    instance.host,
    instance.baseUrl,
    (count) => progress(`  fetched ${count} workflows`, opts.quiet ?? false),
  );

  emitJson({
    instance: instance.host,
    baseUrl: instance.baseUrl,
    workflowCount: manifest.workflowCount,
    syncedAt: manifest.syncedAt,
    catalogPath: catalogPaths(instance.host).workflowsPath,
  });
  return 0;
}
