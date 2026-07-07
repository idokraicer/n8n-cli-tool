import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { readWorkflowFile } from "../workflow-store";
import {
  validateWorkflow,
  type ValidationResult,
} from "../workflow-validate";
import { stripForPut } from "../workflow-merge";
import { CliError, type ResolvedInstance } from "../types";

export interface CreateOpts {
  name?: string;
  yes?: boolean;
  force?: boolean;
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

export async function runCreate(
  fileRef: string,
  opts: CreateOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  try {
    const file = resolve(fileRef);
    if (!existsSync(file)) {
      throw new CliError(
        "no-local-file",
        `No workflow file at ${file}. Pass a path to a workflow JSON (e.g. workflows/tools/my-tool.json).`,
      );
    }

    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);

    const local = readWorkflowFile(file);
    if (opts.name) local.name = opts.name;
    if (!local.name || !String(local.name).trim()) {
      throw new CliError(
        "invalid-workflow",
        "Workflow has no name. Add a \"name\" field to the file or pass --name.",
      );
    }

    // No live counterpart yet — local reference checks only.
    const validation = validateWorkflow(local, null);
    // The public API rejects unknown/read-only fields on POST; start from the
    // PUT whitelist (name/nodes/connections/settings[/staticData]).
    const { body, strippedFields } = stripForPut(local);
    // ...but the public-API v1 *create* schema also accepts description,
    // nodeGroups, and pinData as writable — stripForPut drops them because it
    // targets UPDATE. Re-add any the local file has so pulled/exported
    // workflows keep their description, canvas groups, and pinned data.
    // (projectId is NOT in the public v1 schema and would be rejected.)
    const createWritable = ["description", "nodeGroups", "pinData"] as const;
    const reAdded: string[] = [];
    for (const field of createWritable) {
      if (
        Object.prototype.hasOwnProperty.call(local, field) &&
        local[field] !== undefined
      ) {
        (body as Record<string, unknown>)[field] = local[field];
        reAdded.push(field);
      }
    }
    const effectiveStripped = strippedFields.filter(
      (field) => !reAdded.includes(field),
    );

    const basePayload = {
      instance: instance.host,
      file,
      workflow: { name: local.name },
      nodeCount: (local.nodes ?? []).length,
      strippedFields: effectiveStripped,
      validation: validationSummary(validation),
    };

    if (!validation.valid && !opts.force) {
      emitJson({
        ...basePayload,
        created: false,
        hint: `Refused: validation found ${validation.summary.errorCount} hard error(s). Fix them, then create again — or re-run with --force to create anyway.`,
      });
      return 1;
    }

    // Safe no-op: never write without an explicit --yes.
    if (!opts.yes) {
      emitJson({
        ...basePayload,
        created: false,
        hint: "Preview only — nothing was created. Re-run with --yes to create the workflow.",
      });
      return 0;
    }

    const created = await client.createWorkflow(body);
    const createdId = String(created.id ?? "");
    emitJson({
      ...basePayload,
      created: true,
      workflow: {
        id: createdId,
        name: created.name,
        url: workflowUrl(instance.baseUrl, createdId),
      },
      active: created.active ?? false,
      note: "Created inactive (public-API behavior). Activate it in the n8n UI if it needs a live trigger; executeWorkflowTrigger tools run when called regardless.",
    });
    return 0;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}
