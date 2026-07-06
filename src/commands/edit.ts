import { readFileSync } from "node:fs";
import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { resolveWorkflowRef } from "../name-resolve";
import { parseN8nUrl } from "../url";
import {
  findLocalFile,
  readWorkflowFile,
  resolveWorkflowsDir,
  writeWorkflowFile,
} from "../workflow-store";
import { setCode, setPrompt, replaceNode } from "../workflow-edit";
import { preparePush, validationSummary } from "../workflow-push";
import {
  CliError,
  type EditResult,
  type ResolvedInstance,
  type WorkflowDefinition,
} from "../types";

export type EditSubcommand = "set-code" | "set-prompt" | "replace-node";

export interface EditOpts {
  dir?: string;
  node?: string;
  lang?: "js" | "python";
  code?: string;
  codeFile?: string;
  system?: string;
  systemFile?: string;
  user?: string;
  userFile?: string;
  systemPath?: string;
  userPath?: string;
  literal?: boolean;
  file?: string;
  // Remote (fileless) mode: fetch the live workflow, apply the edit in memory,
  // validate/diff, and (with --yes) push — no local file or --dir needed.
  remote?: boolean;
  yes?: boolean;
  force?: boolean;
  whole?: boolean;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

const defaultReadStdin = (): string => readFileSync(0, "utf8");

// A single-use stdin reader: content options set to "-" (inline or file) read
// from stdin, so an agent can heredoc code/prompts straight in with no temp
// file. Stdin is one stream, so only one option may claim it per command.
type StdinReader = () => string;

function makeStdinReader(read: StdinReader): StdinReader {
  let value: string | null = null;
  return () => {
    if (value !== null) {
      throw new CliError(
        "bad-arguments",
        "Only one option can read from stdin ('-') per command; pass the others inline or via a file.",
      );
    }
    value = read();
    return value;
  };
}

function requireNodeName(opts: EditOpts): string {
  if (!opts.node) {
    throw new CliError("bad-arguments", "Missing required --node option.");
  }
  return opts.node;
}

function assertKnownSub(sub: string): asserts sub is EditSubcommand {
  if (sub !== "set-code" && sub !== "set-prompt" && sub !== "replace-node") {
    throw new CliError(
      "bad-arguments",
      `Unknown edit operation '${sub}'. Use set-code, set-prompt, or replace-node.`,
    );
  }
}

function isStdin(value: string | undefined): boolean {
  return value === "-";
}

function oneOfInlineOrFile(
  label: string,
  inline: string | undefined,
  file: string | undefined,
  readStdin: StdinReader,
): string {
  const count = (inline !== undefined ? 1 : 0) + (file !== undefined ? 1 : 0);
  if (count !== 1) {
    throw new CliError(
      "bad-arguments",
      `Provide exactly one of --${label} or --${label}-file.`,
    );
  }
  if (isStdin(inline) || isStdin(file)) return readStdin();
  return file !== undefined ? readFileSync(file, "utf8") : inline!;
}

function optionalInlineOrFile(
  label: string,
  inline: string | undefined,
  file: string | undefined,
  readStdin: StdinReader,
): string | undefined {
  if (inline === undefined && file === undefined) return undefined;
  return oneOfInlineOrFile(label, inline, file, readStdin);
}

function loadReplacementNode(
  file: string | undefined,
  readStdin: StdinReader,
): Record<string, unknown> {
  if (!file) {
    throw new CliError("bad-arguments", "Provide --file for replace-node.");
  }
  const raw = isStdin(file) ? readStdin() : readFileSync(file, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// Applies one edit operation to a definition in place and returns the
// EditResult(s). Shared by local (writes the file) and --remote (pushes).
function applyEdit(
  def: WorkflowDefinition,
  sub: EditSubcommand,
  nodeName: string,
  opts: EditOpts,
  readStdin: StdinReader,
): EditResult | EditResult[] {
  if (sub === "set-code") {
    const lang = opts.lang ?? "js";
    if (lang !== "js" && lang !== "python") {
      throw new CliError(
        "bad-arguments",
        "--lang must be either 'js' or 'python'.",
      );
    }
    return setCode(
      def,
      nodeName,
      oneOfInlineOrFile("code", opts.code, opts.codeFile, readStdin),
      lang,
    );
  }
  if (sub === "set-prompt") {
    const system = optionalInlineOrFile(
      "system",
      opts.system,
      opts.systemFile,
      readStdin,
    );
    const user = optionalInlineOrFile("user", opts.user, opts.userFile, readStdin);
    return setPrompt(def, nodeName, {
      system,
      user,
      systemPath: opts.systemPath,
      userPath: opts.userPath,
      literal: opts.literal,
    });
  }
  return replaceNode(def, nodeName, loadReplacementNode(opts.file, readStdin));
}

function workflowUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/workflow/${encodeURIComponent(id)}`;
}

// n8n workflow ids are compact tokens with no spaces; URLs parse cleanly. Used
// to give a sharper hint when someone runs a local edit against an id/URL.
function looksLikeIdOrUrl(ref: string): boolean {
  if (parseN8nUrl(ref)) return true;
  return !ref.includes(" ") && /^[A-Za-z0-9_-]{10,}$/.test(ref);
}

function emitEditResultText(result: EditResult | EditResult[]): void {
  const edits = Array.isArray(result) ? result : [result];
  for (const edit of edits) {
    process.stdout.write(
      `${edit.action} ${edit.node} ${edit.field} (${edit.beforeChars}->${edit.afterChars} chars)\n`,
    );
    if (edit.warning) process.stderr.write(`warning: ${edit.warning}\n`);
  }
}

async function runRemoteEdit(
  ref: string,
  sub: EditSubcommand,
  nodeName: string,
  opts: EditOpts,
  readStdin: StdinReader,
  clientFactory: ClientFactory,
): Promise<number> {
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
  const live = await client.getWorkflow(resolved.id);

  const edited = structuredClone(live);
  const result = applyEdit(edited, sub, nodeName, opts, readStdin);

  const prep = preparePush(live, edited, {
    whole: opts.whole,
    node: opts.whole ? null : [nodeName],
  });

  const basePayload = {
    instance: instance.host,
    workflow: {
      id: resolved.id,
      name: prep.pushDef.name,
      url: workflowUrl(instance.baseUrl, resolved.id),
    },
    mode: prep.mode,
    edit: result,
    nodesUpdated: prep.nodesUpdated,
    nodesExcluded: prep.nodesExcluded,
    strippedFields: prep.strippedFields,
    strippedSettingsKeys: prep.strippedSettingsKeys,
    validation: validationSummary(prep.validation),
    diff: prep.diff,
  };

  if (!prep.validation.valid && !opts.force) {
    emitJson({
      ...basePayload,
      pushed: false,
      hint: `Refused: the edited workflow has ${prep.validation.summary.errorCount} validation error(s). Fix the edit, or re-run with --force to push anyway.`,
    });
    return 1;
  }

  if (!opts.yes) {
    emitJson({
      ...basePayload,
      pushed: false,
      hint: "Preview only — nothing was pushed. Review the diff, then re-run with --yes to apply it live.",
    });
    return 0;
  }

  await client.updateWorkflow(resolved.id, prep.body);
  emitJson({ ...basePayload, pushed: true });
  return 0;
}

export async function runEdit(
  ref: string,
  sub: EditSubcommand,
  opts: EditOpts,
  clientFactory: ClientFactory = defaultClientFactory,
  readStdinImpl: StdinReader = defaultReadStdin,
): Promise<number> {
  try {
    assertKnownSub(sub);
    const readStdin = makeStdinReader(readStdinImpl);
    const nodeName = requireNodeName(opts);

    if (opts.remote) {
      return await runRemoteEdit(
        ref,
        sub,
        nodeName,
        opts,
        readStdin,
        clientFactory,
      );
    }

    const dir = resolveWorkflowsDir(opts);
    const file = findLocalFile(dir, ref);
    if (!file) {
      throw new CliError(
        "no-local-file",
        `No local workflow file for '${ref}' in ${dir}.`,
        undefined,
        looksLikeIdOrUrl(ref)
          ? `'${ref}' looks like an id or URL, but local edit resolves the file by exact workflow name. Either run \`n8n-helper pull "${ref}"\` first, or add --remote to edit the live workflow directly (id, URL, or name all work).`
          : `Run \`n8n-helper pull "${ref}"\` to fetch it locally first, or add --remote to edit the live workflow directly (no local file needed).`,
      );
    }

    const def = readWorkflowFile(file);
    const result = applyEdit(def, sub, nodeName, opts, readStdin);

    writeWorkflowFile(file, def);
    if (resolveOutputMode(opts) === "json") {
      emitJson(result);
    } else {
      emitEditResultText(result);
    }
    return 0;
  } catch (err) {
    const cliErr = toCliError(err);
    emitError(cliErr, resolveOutputMode(opts));
    return 2;
  }
}
