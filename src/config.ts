import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CliError,
  type Config,
  type InstanceConfig,
  type ResolvedInstance,
} from "./types";

export function getHome(): string {
  return process.env.N8N_HELPER_HOME ?? join(homedir(), ".n8n-helper");
}

function configPath(): string {
  return join(getHome(), "config.json");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return { instances: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    return { defaultInstance: raw.defaultInstance, instances: raw.instances ?? {} };
  } catch {
    return { instances: {} };
  }
}

export function saveConfig(config: Config): void {
  const home = getHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function upsertInstance(
  host: string,
  instance: InstanceConfig,
  makeDefault: boolean,
): void {
  const config = loadConfig();
  config.instances[host] = instance;
  if (makeDefault || !config.defaultInstance) {
    config.defaultInstance = host;
  }
  saveConfig(config);
}

export function resolveInstance(input: {
  host?: string;
  baseUrl?: string;
}): ResolvedInstance {
  const config = loadConfig();
  const envBaseUrl = process.env.N8N_BASE_URL;
  let envHost: string | undefined;
  if (envBaseUrl) {
    try {
      envHost = new URL(envBaseUrl).host;
    } catch {
      envHost = undefined;
    }
  }
  const host = input.host ?? envHost ?? config.defaultInstance;
  if (!host) {
    throw new CliError(
      "no-credentials",
      "No n8n instance specified. Run `n8n-helper login` or pass a workflow/execution URL.",
    );
  }
  const stored = config.instances[host];
  const apiKey = process.env.N8N_API_KEY ?? stored?.apiKey;
  if (!apiKey) {
    throw new CliError(
      "no-credentials",
      `No API key for ${host}. Run \`n8n-helper login --url https://${host}\` or set N8N_API_KEY.`,
    );
  }
  const baseUrl =
    input.baseUrl ??
    stored?.baseUrl ??
    (envHost === host ? envBaseUrl : undefined);
  if (!baseUrl) {
    throw new CliError(
      "no-credentials",
      `No base URL for ${host}. Run \`n8n-helper login --url https://${host}\`.`,
    );
  }
  return { host, baseUrl, apiKey };
}

export function catalogPaths(host: string): {
  dir: string;
  manifestPath: string;
  workflowsPath: string;
} {
  const dir = join(getHome(), "catalog", encodeURIComponent(host));
  return {
    dir,
    manifestPath: join(dir, "manifest.json"),
    workflowsPath: join(dir, "workflows.jsonl"),
  };
}

export function execCachePath(host: string, executionId: string): string {
  return join(
    getHome(),
    "cache",
    encodeURIComponent(host),
    "executions",
    `${executionId}.json`,
  );
}
