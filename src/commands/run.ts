import { readFileSync } from "node:fs";
import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import { emitError, emitJson, resolveOutputMode } from "../format";
import { resolveWorkflowRef } from "../name-resolve";
import { SessionManager } from "../session";
import {
  CliError,
  type ResolvedInstance,
  type WorkflowDefinition,
} from "../types";
import { buildExecutionUrl, buildWorkflowUrl, parseN8nUrl } from "../url";
import {
  buildInternalRunPayload,
  buildWebhookRequest,
  detectTrigger,
  summarizeRun,
} from "../workflow-run";

export interface RunOpts {
  data?: string;
  dataInline?: string;
  node?: string;
  poll?: boolean;
  dir?: string;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type RunClient = Pick<
  N8nClient,
  | "getWorkflow"
  | "listWorkflows"
  | "postWebhook"
  | "runWorkflow"
  | "getExecution"
>;

type ClientFactory = (instance: ResolvedInstance) => RunClient;

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

export type Session = {
  getCookie: SessionManager["getCookie"];
  refreshCookie?: SessionManager["refreshCookie"];
  getBrowserId?: SessionManager["getBrowserId"];
};
export type SessionFactory = (instance: ResolvedInstance) => Session;

const defaultSessionFactory: SessionFactory = (instance) =>
  new SessionManager(instance.host, instance.baseUrl);

function parseSampleData(opts: RunOpts): unknown {
  try {
    if (opts.data) {
      return JSON.parse(readFileSync(opts.data, "utf8"));
    }
    if (opts.dataInline) {
      return JSON.parse(opts.dataInline);
    }
    return {};
  } catch (err) {
    throw new CliError(
      "bad-arguments",
      `Could not read sample data from ${opts.data ? `--data ${opts.data}` : "--data-inline"}: ${(err as Error).message}`,
    );
  }
}

function workflowName(refName: string, def: WorkflowDefinition): string {
  return def.name || refName;
}

export async function runRun(
  ref: string,
  opts: RunOpts,
  clientFactory: ClientFactory = defaultClientFactory,
  sessionFactory: SessionFactory = defaultSessionFactory,
): Promise<number> {
  try {
    const parsed = parseN8nUrl(ref);
    const instance = resolveInstance({
      host: opts.instance ?? parsed?.host,
      baseUrl: parsed?.baseUrl,
    });
    const client = clientFactory(instance);
    const workflow = await resolveWorkflowRef(ref, {
      host: instance.host,
      client: client as N8nClient,
    });
    const def = await client.getWorkflow(workflow.id);
    const data = parseSampleData(opts);
    const plan = detectTrigger(def, opts.node);
    let response: { status: number; body: unknown };

    if (plan.kind === "webhook") {
      const request = buildWebhookRequest(
        instance.baseUrl,
        def,
        plan.triggerNode,
        data,
      );
      response = await client.postWebhook(request.url, request.body);
    } else {
      const session = sessionFactory(instance);
      const cookie = await session.getCookie();
      if (!cookie) {
        throw new CliError(
          "no-credentials",
          "run --node internal needs a saved session; n8n-helper login --email",
        );
      }
      const payload = buildInternalRunPayload(def, plan.triggerNode, data);
      const browserId = session.getBrowserId?.();
      try {
        response = await client.runWorkflow(workflow.id, payload, {
          cookie,
          browserId,
        });
      } catch (err) {
        // A 401 means the persisted session cookie expired: re-login once and retry.
        if (
          err instanceof CliError &&
          err.code === "unauthorized" &&
          session.refreshCookie
        ) {
          const fresh = await session.refreshCookie();
          if (!fresh) throw err;
          response = await client.runWorkflow(workflow.id, payload, {
            cookie: fresh,
            browserId: session.getBrowserId?.() ?? browserId,
          });
        } else {
          throw err;
        }
      }
    }

    // Only the internal /rest run returns an n8n execution envelope. A webhook
    // response is arbitrary business JSON, so we must NOT read run status/id
    // out of it (that would let a body like {status:"error"} fake a failure or
    // fabricate an execution id).
    let summary: { executionId?: string; status?: string } =
      plan.kind === "internal" ? summarizeRun(response.body) : {};
    let result: unknown = response.body;
    let pollError: { code: string; message: string } | undefined;
    if (opts.poll && summary.executionId) {
      try {
        result = await client.getExecution(summary.executionId);
        summary = { ...summary, ...summarizeRun(result) };
      } catch (err) {
        // "not-found" is expected: the execution may not be persisted yet, or
        // the instance has manual-execution saving off. Any other error is a
        // real poll failure worth surfacing (without failing the started run).
        const cliErr = err instanceof CliError ? err : null;
        if (!cliErr || cliErr.code !== "not-found") {
          pollError = {
            code: cliErr?.code ?? "n8n-error",
            message: (err as Error).message,
          };
        }
      }
    }

    const executionId = summary.executionId;
    emitJson({
      instance: instance.host,
      workflow: {
        id: workflow.id,
        name: workflowName(workflow.name, def),
        url: buildWorkflowUrl(instance.baseUrl, workflow.id),
      },
      mode: plan.kind,
      execution: {
        ...(executionId === undefined ? {} : { id: executionId }),
        ...(executionId === undefined
          ? {}
          : {
              url: buildExecutionUrl(
                instance.baseUrl,
                workflow.id,
                executionId,
              ),
            }),
        ...(summary.status === undefined ? {} : { status: summary.status }),
      },
      ...(pollError ? { pollError } : {}),
      result,
    });
    // A polled terminal failure is a failed test run: exit 1 so agents driving
    // off the exit code don't read a broken flow as success.
    const failedStatuses = new Set(["error", "crashed", "canceled"]);
    return summary.status && failedStatuses.has(summary.status) ? 1 : 0;
  } catch (err) {
    const cliErr =
      err instanceof CliError
        ? err
        : new CliError("n8n-error", (err as Error).message);
    emitError(cliErr, resolveOutputMode(opts));
    return 2;
  }
}
