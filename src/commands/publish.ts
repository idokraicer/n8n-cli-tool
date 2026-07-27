import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { resolveWorkflowRef } from "../name-resolve";
import type { ResolvedInstance } from "../types";
import { parseN8nUrl } from "../url";

export interface PublishOpts {
  yes?: boolean;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

function workflowUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/workflow/${encodeURIComponent(id)}`;
}

export async function runPublish(
  ref: string,
  opts: PublishOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const parsed = parseN8nUrl(ref);
    const instance = resolveInstance({
      host: opts.instance ?? parsed?.host,
      baseUrl: parsed?.baseUrl,
    });
    const client = clientFactory(instance);
    const resolved = await resolveWorkflowRef(ref, {
      host: instance.host,
      client,
    });
    const workflow = await client.getWorkflow(resolved.id);
    const id = String(workflow.id ?? resolved.id);
    const basePayload = {
      instance: instance.host,
      workflow: {
        id,
        name: workflow.name,
        url: workflowUrl(instance.baseUrl, id),
      },
    };

    if (workflow.active) {
      emitJson({
        ...basePayload,
        published: false,
        alreadyPublished: true,
        wasActive: true,
        active: true,
      });
      return 0;
    }

    if (!opts.yes) {
      emitJson({
        ...basePayload,
        published: false,
        alreadyPublished: false,
        wasActive: false,
        active: false,
        hint:
          "Preview only — nothing was published. Re-run with --yes to publish the workflow.",
      });
      return 0;
    }

    const published = await client.publishWorkflow(id);
    emitJson({
      ...basePayload,
      published: true,
      alreadyPublished: false,
      wasActive: false,
      active: published.active ?? true,
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}
