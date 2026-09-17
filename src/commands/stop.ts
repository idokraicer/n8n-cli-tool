import { CliError, type ResolvedInstance } from "../types";
import { resolveInstance } from "../config";
import { N8nClient } from "../client";
import { parseN8nUrl, buildExecutionUrl } from "../url";
import { emitJson, progress } from "../format";
import { requireIntOption } from "../options";

export interface StopOpts {
  yes?: boolean;
  concurrency?: string;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;
const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

type Candidate = { id: string; workflowId?: string };

function resolveCandidates(targets: string[]): {
  host?: string;
  baseUrl?: string;
  candidates: Candidate[];
} {
  if (targets.length === 0) {
    throw new CliError("bad-arguments", "Pass at least one execution id or URL.");
  }

  let host: string | undefined;
  let baseUrl: string | undefined;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const parsed = parseN8nUrl(target);
    if (parsed?.kind === "workflow") {
      throw new CliError(
        "bad-arguments",
        `Pass an execution URL or numeric execution id, not workflow URL "${target}".`,
      );
    }
    if (parsed?.kind === "execution") {
      if (host && host !== parsed.host) {
        throw new CliError("bad-arguments", "All execution URLs must use the same n8n instance.");
      }
      host = parsed.host;
      baseUrl = parsed.baseUrl;
      if (!seen.has(parsed.executionId!)) {
        seen.add(parsed.executionId!);
        candidates.push({ id: parsed.executionId!, workflowId: parsed.workflowId });
      }
      continue;
    }

    const id = target.trim();
    if (!/^\d+$/.test(id)) {
      throw new CliError(
        "bad-arguments",
        `Invalid execution target "${target}"; expected a numeric id or execution URL.`,
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      candidates.push({ id });
    }
  }

  return { host, baseUrl, candidates };
}

export async function runStop(
  targets: string[],
  opts: StopOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  const { host, baseUrl, candidates } = resolveCandidates(targets);
  const instance = resolveInstance({ host, baseUrl });
  const quiet = opts.quiet ?? false;

  const executionRows = candidates.map((candidate) => ({
    id: candidate.id,
    ...(candidate.workflowId
      ? { url: buildExecutionUrl(instance.baseUrl, candidate.workflowId, candidate.id) }
      : {}),
  }));

  if (!opts.yes) {
    emitJson({
      instance: instance.host,
      preview: true,
      count: candidates.length,
      executions: executionRows,
      hint: "Preview only — re-run with --yes to stop these executions.",
    });
    return 0;
  }

  const concurrency = requireIntOption("concurrency", opts.concurrency ?? "5");
  if (concurrency === 0) {
    throw new CliError("bad-arguments", "--concurrency must be at least 1.");
  }

  const client = clientFactory(instance);
  type Result = {
    id: string;
    url?: string;
    ok: boolean;
    status?: number;
    response?: unknown;
    error?: { code: string; message: string };
  };
  const results: Result[] = [];

  progress(`Stopping ${candidates.length} execution(s)...`, quiet);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, candidates.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= candidates.length) return;
        const candidate = candidates[index];
        const url = candidate.workflowId
          ? buildExecutionUrl(instance.baseUrl, candidate.workflowId, candidate.id)
          : undefined;
        try {
          const response = await client.stopExecution(candidate.id);
          results.push({
            id: candidate.id,
            ...(url ? { url } : {}),
            ok: true,
            status: response.status,
            response: response.body,
          });
          progress(`  stopped ${candidate.id} (HTTP ${response.status})`, quiet);
        } catch (err) {
          const cliErr =
            err instanceof CliError
              ? err
              : new CliError("n8n-error", (err as Error).message);
          results.push({
            id: candidate.id,
            ...(url ? { url } : {}),
            ok: false,
            error: { code: cliErr.code, message: cliErr.message },
          });
          progress(`  FAILED ${candidate.id}: ${cliErr.message}`, quiet);
        }
      }
    },
  );
  await Promise.all(workers);

  const succeeded = results.filter((result) => result.ok).length;
  const failed = results.length - succeeded;
  emitJson({
    instance: instance.host,
    summary: { attempted: results.length, succeeded, failed },
    results: results.sort((a, b) => Number(a.id) - Number(b.id)),
  });
  return failed === 0 ? 0 : 1;
}
