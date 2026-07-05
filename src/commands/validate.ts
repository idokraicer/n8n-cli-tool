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
  validateWorkflow,
  type ValidationResult,
} from "../workflow-validate";
import {
  CliError,
  type ResolvedInstance,
  type WorkflowDefinition,
} from "../types";

export interface ValidateOpts {
  local?: boolean;
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

function emitValidationText(
  validation: ValidationResult,
  workflowId: string,
): void {
  process.stdout.write(
    `Workflow ${workflowId}: ${validation.valid ? "valid" : "invalid"}\n`,
  );
  for (const error of validation.errors) {
    if (error.type === "parse") {
      process.stdout.write(`error parse: ${error.message}\n`);
      continue;
    }
    process.stdout.write(
      `error ${error.reason}: ${error.node} references ${error.referencedNode}`,
    );
    if (error.hint) process.stdout.write(` (${error.hint})`);
    process.stdout.write("\n");
  }
  for (const warning of validation.warnings) {
    process.stdout.write(
      `warning ${warning.reason}: ${warning.node} $json predecessors changed from ${warning.from.join(", ")} to ${warning.to.join(", ")}\n`,
    );
  }
}

function parseFailureResult(error: unknown): ValidationResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    valid: false,
    errors: [{ type: "parse", reason: "parse", message }],
    warnings: [],
    summary: { errorCount: 1, warningCount: 0 },
  };
}

function emitResult(
  payload: unknown,
  validation: ValidationResult,
  opts: ValidateOpts,
  workflowId: string,
): void {
  if (resolveOutputMode(opts) === "json") {
    emitJson(payload);
  } else {
    emitValidationText(validation, workflowId);
  }
}

export async function runValidate(
  ref: string,
  opts: ValidateOpts,
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
    // Fetch remote first (unless --local) so we can locate the local file by
    // the workflow's real name even for a bare-id or URL ref.
    const remote = opts.local ? null : await client.getWorkflow(resolved.id);
    const dir = resolveWorkflowsDir(opts);
    const file =
      findLocalFile(dir, remote?.name ?? resolved.name) ??
      findLocalFile(dir, resolved.id);

    if (!file) {
      throw new CliError(
        "no-local-file",
        `No local workflow file for ${remote?.name ?? resolved.name}. Run \`n8n-helper pull\` first.`,
      );
    }

    let local: WorkflowDefinition;
    let validation: ValidationResult | null = null;
    try {
      local = parseWorkflow(readWorkflowFile(file));
    } catch (err) {
      validation = parseFailureResult(err);
      local = { name: remote?.name ?? resolved.name, nodes: [], connections: {} };
    }

    validation ??= validateWorkflow(local, remote);

    const payload = {
      instance: instance.host,
      workflow: {
        id: resolved.id,
        name: local.name,
        url: workflowUrl(instance.baseUrl, resolved.id),
      },
      file,
      ...validation,
    };

    emitResult(payload, validation, opts, resolved.id);
    return validation.valid ? 0 : 1;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}
