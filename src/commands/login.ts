import { CliError } from "../types";
import { upsertInstance } from "../config";
import { N8nClient } from "../client";
import { emitJson, progress } from "../format";

export interface LoginOpts {
  url: string;
  key?: string;
  default?: boolean;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

async function defaultValidate(baseUrl: string, key: string): Promise<boolean> {
  const client = new N8nClient({ baseUrl, apiKey: key });
  try {
    await client.listWorkflows({ limit: 1 });
    return true;
  } catch (err) {
    if (err instanceof CliError && err.code === "unauthorized") return false;
    throw err;
  }
}

async function promptForKey(promptText: string): Promise<string> {
  process.stderr.write(promptText);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

export async function runLogin(
  opts: LoginOpts,
  validate: (baseUrl: string, key: string) => Promise<boolean> = defaultValidate,
): Promise<number> {
  let host: string;
  try {
    host = new URL(opts.url).host;
  } catch {
    throw new CliError("bad-url", `Invalid instance URL: ${opts.url}`);
  }
  const baseUrl = opts.url.replace(/\/+$/, "");

  const key = opts.key ?? (await promptForKey("Enter your n8n API key: "));
  if (!key) throw new CliError("bad-arguments", "No API key provided.");

  progress(`Validating key against ${host}...`, opts.quiet ?? false);
  const ok = await validate(baseUrl, key);
  if (!ok) {
    throw new CliError("unauthorized", `The API key was rejected by ${host}.`);
  }

  upsertInstance(host, { baseUrl, apiKey: key }, opts.default ?? false);
  progress(`Saved credentials for ${host}.`, opts.quiet ?? false);
  emitJson({ instance: host, baseUrl, saved: true });
  return 0;
}
