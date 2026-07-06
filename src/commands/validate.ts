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

// Instance details are only needed to decorate the output (host + workflow URL)
// and, for remote validation, to fetch. Under --local we must never *require*
// credentials, so resolve best-effort and tolerate a missing instance.
function tryResolveInstance(input: {
  host?: string;
  baseUrl?: string;
}): ResolvedInstance | null {
  try {
    return resolveInstance(input);
  } catch (err) {
    if (err instanceof CliError && err.code === "no-credentials") return null;
    throw err;
  }
}

async function runLocalValidate(
  ref: string,
  opts: ValidateOpts,
  mode: "json" | "text",
): Promise<number> {
  try {
    const parsed = parseN8nUrl(ref);
    const id = parsed?.kind === "workflow" ? parsed.workflowId : undefined;
    const dir = resolveWorkflowsDir(opts);
    // Locate the file directly — no instance, no API. Try the ref as a name
    // first, then (for URL/id refs) by the workflow id.
    const file = findLocalFile(dir, ref) ?? (id ? findLocalFile(dir, id) : null);

    if (!file) {
      throw new CliError(
        "no-local-file",
        `No local workflow file for ${ref}. Run \`n8n-helper pull\` first.`,
      );
    }

    let local: WorkflowDefinition;
    let validation: ValidationResult | null = null;
    try {
      local = parseWorkflow(readWorkflowFile(file));
    } catch (err) {
      validation = parseFailureResult(err);
      local = { name: ref, nodes: [], connections: {} };
    }

    validation ??= validateWorkflow(local, null);

    const instance = tryResolveInstance({
      host: opts.instance ?? parsed?.host,
      baseUrl: parsed?.baseUrl,
    });
    const workflowId = id ?? local.id ?? ref;
    const payload = {
      ...(instance ? { instance: instance.host } : {}),
      workflow: {
        id: workflowId,
        name: local.name,
        ...(instance ? { url: workflowUrl(instance.baseUrl, workflowId) } : {}),
      },
      file,
      ...validation,
    };

    emitResult(payload, validation, opts, String(workflowId));
    return validation.valid ? 0 : 1;
  } catch (err) {
    emitError(toCliError(err), mode);
    return 2;
  }
}

export async function runValidate(
  ref: string,
  opts: ValidateOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const mode = resolveOutputMode(opts);

  if (opts.local) return runLocalValidate(ref, opts, mode);

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
    // Fetch remote first so we can locate the local file by the workflow's real
    // name even for a bare-id or URL ref. (--local is handled offline above.)
    const remote = await client.getWorkflow(resolved.id);
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
