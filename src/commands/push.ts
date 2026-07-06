import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { resolveWorkflowRef } from "../name-resolve";
import { parseN8nUrl } from "../url";
import {
  findLocalFile,
  readWorkflowFile,
  resolveWorkflowsDir,
} from "../workflow-store";
import { parseWorkflow } from "../workflow-data";
import { preparePush, validationSummary } from "../workflow-push";
import { CliError, type ResolvedInstance } from "../types";

export interface PushOpts {
  whole?: boolean;
  node?: string[];
  yes?: boolean;
  force?: boolean;
  dir?: string;
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

export async function runPush(
  ref: string,
  opts: PushOpts,
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

    // Fetch live first so we can locate the local file by the workflow's real
    // name even when the ref was a bare id or URL (resolved.name is then the
    // ref string, not the name).
    const live = await client.getWorkflow(resolved.id);
    const dir = resolveWorkflowsDir(opts);
    const file =
      findLocalFile(dir, live.name) ??
      findLocalFile(dir, resolved.name) ??
      findLocalFile(dir, resolved.id);
    if (!file) {
      throw new CliError(
        "no-local-file",
        `No local workflow file for ${live.name}. Run \`n8n-helper pull\` first.`,
      );
    }

    const local = parseWorkflow(readWorkflowFile(file));

    const {
      pushDef,
      mode: pushMode,
      nodesUpdated,
      nodesExcluded,
      validation,
      diff,
      body,
      strippedFields,
      strippedSettingsKeys,
    } = preparePush(live, local, { whole: opts.whole, node: opts.node ?? null });

    const basePayload = {
      instance: instance.host,
      workflow: {
        id: resolved.id,
        name: pushDef.name,
        url: workflowUrl(instance.baseUrl, resolved.id),
      },
      file,
      mode: pushMode,
      nodesUpdated,
      nodesExcluded,
      strippedFields,
      strippedSettingsKeys,
      validation: validationSummary(validation),
      diff,
    };

    // Validation hard errors block the push unless --force.
    if (!validation.valid && !opts.force) {
      emitJson({
        ...basePayload,
        pushed: false,
        hint: `Refused: validation found ${validation.summary.errorCount} hard error(s). Fix them (e.g. n8n-helper edit / pull the latest), then push again — or re-run with --force to push anyway.`,
      });
      return 1;
    }

    // Safe no-op: never write without an explicit --yes.
    if (!opts.yes) {
      emitJson({
        ...basePayload,
        pushed: false,
        hint: "Preview only — nothing was pushed. Review the diff, then re-run with --yes to apply it.",
      });
      return 0;
    }

    await client.updateWorkflow(resolved.id, body);
    emitJson({ ...basePayload, pushed: true });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}
