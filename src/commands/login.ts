import { randomUUID } from "node:crypto";
import { CliError, type InstanceConfig } from "../types";
import { loadConfig, upsertInstance } from "../config";
import { N8nClient } from "../client";
import { performSessionLogin } from "../session";
import { emitJson, progress } from "../format";

export interface LoginOpts {
  url: string;
  key?: string;
  email?: string;
  password?: string;
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

export type SessionLoginFn = (
  baseUrl: string,
  email: string,
  password: string,
  browserId: string,
) => Promise<string>;

const defaultSessionLogin: SessionLoginFn = (
  baseUrl,
  email,
  password,
  browserId,
) => performSessionLogin({ baseUrl, email, password, browserId });

async function promptForSecret(promptText: string): Promise<string> {
  process.stderr.write(promptText);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

export async function runLogin(
  opts: LoginOpts,
  validate: (baseUrl: string, key: string) => Promise<boolean> = defaultValidate,
  sessionLogin: SessionLoginFn = defaultSessionLogin,
): Promise<number> {
  let host: string;
  try {
    host = new URL(opts.url).host;
  } catch {
    throw new CliError("bad-url", `Invalid instance URL: ${opts.url}`);
  }
  const baseUrl = opts.url.replace(/\/+$/, "");
  const existing = loadConfig().instances[host];

  // When only adding session credentials, keep the already-validated API key.
  let key = opts.key;
  if (!key && opts.email && existing?.apiKey) {
    key = existing.apiKey;
  } else {
    key ??= await promptForSecret("Enter your n8n API key: ");
    if (!key) throw new CliError("bad-arguments", "No API key provided.");
    progress(`Validating key against ${host}...`, opts.quiet ?? false);
    const ok = await validate(baseUrl, key);
    if (!ok) {
      throw new CliError("unauthorized", `The API key was rejected by ${host}.`);
    }
  }

  let sessionFields: Partial<InstanceConfig> = {};
  if (opts.email) {
    const password =
      opts.password ?? (await promptForSecret("Enter your n8n password: "));
    if (!password) throw new CliError("bad-arguments", "No password provided.");
    const browserId = existing?.browserId ?? randomUUID();
    progress(`Validating session login for ${opts.email}...`, opts.quiet ?? false);
    const sessionCookie = await sessionLogin(
      baseUrl,
      opts.email,
      password,
      browserId,
    );
    sessionFields = { email: opts.email, password, browserId, sessionCookie };
  }

  upsertInstance(
    host,
    { ...existing, baseUrl, apiKey: key, ...sessionFields },
    opts.default ?? false,
  );
  progress(`Saved credentials for ${host}.`, opts.quiet ?? false);
  emitJson({
    instance: host,
    baseUrl,
    saved: true,
    session: opts.email ? true : undefined,
  });
  return 0;
}
