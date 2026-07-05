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

export type Session = Pick<SessionManager, "getCookie">;
export type SessionFactory = (instance: ResolvedInstance) => Session;

const defaultSessionFactory: SessionFactory = (instance) =>
  new SessionManager(instance.host, instance.baseUrl);

function parseSampleData(opts: RunOpts): unknown {
  if (opts.data) {
    return JSON.parse(readFileSync(opts.data, "utf8"));
  }
  if (opts.dataInline) {
    return JSON.parse(opts.dataInline);
  }
  return {};
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
      const cookie = await sessionFactory(instance).getCookie();
      if (!cookie) {
        throw new CliError(
          "no-credentials",
          "run --node internal needs a saved session; n8n-helper login --email",
        );
      }
      response = await client.runWorkflow(
        workflow.id,
        buildInternalRunPayload(def, plan.triggerNode, data),
        { cookie },
      );
    }

    let summary = summarizeRun(response.body);
    let result = response.body;
    if (opts.poll && summary.executionId) {
      result = await client.getExecution(summary.executionId);
      summary = { ...summary, ...summarizeRun(result) };
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
      result,
    });
    return 0;
  } catch (err) {
    const cliErr =
      err instanceof CliError
        ? err
        : new CliError("n8n-error", (err as Error).message);
    emitError(cliErr, resolveOutputMode(opts));
    return 2;
  }
}
