import { readFileSync } from "node:fs";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import {
  findLocalFile,
  readWorkflowFile,
  resolveWorkflowsDir,
  writeWorkflowFile,
} from "../workflow-store";
import { setCode, setPrompt, replaceNode } from "../workflow-edit";
import { CliError, type EditResult } from "../types";

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
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = unknown;

function requireNodeName(opts: EditOpts): string {
  if (!opts.node) {
    throw new CliError("bad-arguments", "Missing required --node option.");
  }
  return opts.node;
}

function oneOfInlineOrFile(
  label: string,
  inline: string | undefined,
  file: string | undefined,
): string {
  const count = (inline !== undefined ? 1 : 0) + (file !== undefined ? 1 : 0);
  if (count !== 1) {
    throw new CliError(
      "bad-arguments",
      `Provide exactly one of --${label} or --${label}-file.`,
    );
  }
  return file !== undefined ? readFileSync(file, "utf8") : inline!;
}

function optionalInlineOrFile(
  label: string,
  inline: string | undefined,
  file: string | undefined,
): string | undefined {
  if (inline === undefined && file === undefined) return undefined;
  return oneOfInlineOrFile(label, inline, file);
}

function loadReplacementNode(file: string | undefined): Record<string, unknown> {
  if (!file) {
    throw new CliError("bad-arguments", "Provide --file for replace-node.");
  }
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

export async function runEdit(
  ref: string,
  sub: EditSubcommand,
  opts: EditOpts,
  clientFactory?: ClientFactory,
): Promise<number> {
  void clientFactory;

  try {
    const dir = resolveWorkflowsDir(opts);
    const file = findLocalFile(dir, ref);
    if (!file) {
      throw new CliError(
        "no-local-file",
        `No local workflow file for '${ref}' in ${dir}.`,
        undefined,
        `Run \`n8n-helper pull "${ref}"\` to fetch it locally first (edit works on the local file, by exact name).`,
      );
    }

    if (
      sub !== "set-code" &&
      sub !== "set-prompt" &&
      sub !== "replace-node"
    ) {
      throw new CliError(
        "bad-arguments",
        `Unknown edit operation '${sub}'. Use set-code, set-prompt, or replace-node.`,
      );
    }

    const def = readWorkflowFile(file);
    const nodeName = requireNodeName(opts);
    let result: unknown;

    if (sub === "set-code") {
      const lang = opts.lang ?? "js";
      if (lang !== "js" && lang !== "python") {
        throw new CliError(
          "bad-arguments",
          "--lang must be either 'js' or 'python'.",
        );
      }
      result = setCode(
        def,
        nodeName,
        oneOfInlineOrFile("code", opts.code, opts.codeFile),
        lang,
      );
    } else if (sub === "set-prompt") {
      const system = optionalInlineOrFile(
        "system",
        opts.system,
        opts.systemFile,
      );
      const user = optionalInlineOrFile("user", opts.user, opts.userFile);
      result = setPrompt(def, nodeName, {
        system,
        user,
        systemPath: opts.systemPath,
        userPath: opts.userPath,
        literal: opts.literal,
      });
    } else if (sub === "replace-node") {
      result = replaceNode(def, nodeName, loadReplacementNode(opts.file));
    } else {
      throw new CliError("bad-arguments", `Unknown edit operation '${sub}'.`);
    }

    writeWorkflowFile(file, def);
    if (resolveOutputMode(opts) === "json") {
      emitJson(result);
    } else {
      const edits = Array.isArray(result)
        ? (result as EditResult[])
        : [result as EditResult];
      for (const edit of edits) {
        process.stdout.write(
          `${edit.action} ${edit.node} ${edit.field} (${edit.beforeChars}->${edit.afterChars} chars)\n`,
        );
        if (edit.warning) process.stderr.write(`warning: ${edit.warning}\n`);
      }
    }
    return 0;
  } catch (err) {
    const cliErr = toCliError(err);
    emitError(cliErr, resolveOutputMode(opts));
    return 2;
  }
}
