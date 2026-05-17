import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { N8nClient } from "./client";
import { execCachePath } from "./config";

export async function getExecutionCached(
  client: N8nClient,
  host: string,
  executionId: string,
  opts: { refresh: boolean; noCache: boolean },
): Promise<any> {
  const path = execCachePath(host, executionId);

  if (!opts.refresh && !opts.noCache && existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt cache entry — fall through to a fresh fetch.
    }
  }

  const execution = await client.getExecution(executionId);

  if (!opts.noCache && execution?.finished === true) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(execution));
  }

  return execution;
}
