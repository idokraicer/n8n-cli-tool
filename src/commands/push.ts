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
import {
  diffWorkflows,
  validateWorkflow,
  type ValidationResult,
} from "../workflow-validate";
import { mergeNodes, stripForPut } from "../workflow-merge";
import {
  CliError,
  type ResolvedInstance,
  type WorkflowDefinition,
} from "../types";

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

function validationSummary(validation: ValidationResult): {
  valid: boolean;
  errorCount: number;
  warningCount: number;
} {
  return {
    valid: validation.valid,
    errorCount: validation.summary.errorCount,
    warningCount: validation.summary.warningCount,
  };
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

    const dir = resolveWorkflowsDir(opts);
    const file =
      findLocalFile(dir, resolved.name) ?? findLocalFile(dir, resolved.id);
    if (!file) {
      throw new CliError(
        "no-local-file",
        `No local workflow file for ${resolved.name}. Run \`n8n-helper pull\` first.`,
      );
    }

    const local = parseWorkflow(readWorkflowFile(file));
    const live = await client.getWorkflow(resolved.id);

    const pushMode: "merge" | "whole" = opts.whole ? "whole" : "merge";
    let pushDef: WorkflowDefinition;
    let nodesUpdated: string[];
    let nodesExcluded: {
      addedNodes: string[];
      removedNodes: string[];
      connectionsChanged: boolean;
    };

    if (pushMode === "whole") {
      pushDef = local;
      nodesUpdated = (local.nodes ?? []).map((node) => node.name);
      nodesExcluded = {
        addedNodes: [],
        removedNodes: [],
        connectionsChanged: false,
      };
    } else {
      const plan = mergeNodes(live, local, opts.node ?? null);
      pushDef = plan.merged;
      nodesUpdated = plan.updated;
      nodesExcluded = plan.excluded;
    }

    const validation = validateWorkflow(pushDef, live);
    const diff = diffWorkflows(pushDef, live);
    const { body, strippedFields } = stripForPut(pushDef);

    const basePayload = {
      instance: instance.host,
      workflow: {
        id: resolved.id,
        name: local.name,
        url: workflowUrl(instance.baseUrl, resolved.id),
      },
      file,
      mode: pushMode,
      nodesUpdated,
      nodesExcluded,
      strippedFields,
      validation: validationSummary(validation),
      diff,
    };

    // Validation hard errors block the push unless --force.
    if (!validation.valid && !opts.force) {
      emitJson({ ...basePayload, pushed: false });
      return 1;
    }

    // Safe no-op: never write without an explicit --yes.
    if (!opts.yes) {
      emitJson({ ...basePayload, pushed: false });
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
