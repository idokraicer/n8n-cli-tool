import { isDeepStrictEqual } from "node:util";
import { N8nClient } from "../client";
import { resolveInstance } from "../config";
import { emitError, emitJson, resolveOutputMode, toCliError } from "../format";
import { resolveWorkflowRef } from "../name-resolve";
import type { ResolvedInstance, WorkflowDefinition, WorkflowNode } from "../types";
import { buildWorkflowUrl } from "../url";
import {
  findLocalFile,
  newFilePath,
  readWorkflowFile,
  resolveWorkflowsDir,
  writeWorkflowFile,
} from "../workflow-store";

export interface PullOpts {
  dir?: string;
  out?: string;
  yes?: boolean;
  instance?: string;
  json?: boolean;
  text?: boolean;
  quiet?: boolean;
}

type ClientFactory = (instance: ResolvedInstance) => N8nClient;

interface WorkflowDiff {
  different: boolean;
  // Set when the workflows differ but every node map is identical — i.e. the
  // change is in connections/settings/tags/active, which the node lists can't
  // show. Without it the user sees "different" with empty node arrays.
  otherChanges?: boolean;
  nodes: {
    added: string[];
    removed: string[];
    changed: string[];
  };
}

const defaultClientFactory: ClientFactory = (instance) =>
  new N8nClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

function nodesByName(nodes: WorkflowNode[]): Map<string, WorkflowNode> {
  return new Map(nodes.map((node) => [node.name, node]));
}

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function diffWorkflows(
  local: WorkflowDefinition,
  fetched: WorkflowDefinition,
): WorkflowDiff | undefined {
  // Order-insensitive: a key-order-only difference is not a real change and
  // must not spuriously gate the overwrite behind --yes.
  if (isDeepStrictEqual(local, fetched)) return undefined;

  const localNodes = nodesByName(local.nodes ?? []);
  const fetchedNodes = nodesByName(fetched.nodes ?? []);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name, fetchedNode] of fetchedNodes) {
    const localNode = localNodes.get(name);
    if (!localNode) {
      added.push(name);
      continue;
    }
    if (!isDeepStrictEqual(localNode, fetchedNode)) {
      changed.push(name);
    }
  }

  for (const name of localNodes.keys()) {
    if (!fetchedNodes.has(name)) removed.push(name);
  }

  const otherChanges =
    added.length === 0 && removed.length === 0 && changed.length === 0;

  return {
    different: true,
    ...(otherChanges ? { otherChanges: true } : {}),
    nodes: {
      added: sorted(added),
      removed: sorted(removed),
      changed: sorted(changed),
    },
  };
}

function triggerNodes(workflow: WorkflowDefinition): string[] {
  return (workflow.nodes ?? [])
    .filter(
      (node) =>
        node.type.endsWith("Trigger") ||
        node.type === "n8n-nodes-base.webhook",
    )
    .map((node) => node.name);
}

export async function runPull(
  ref: string,
  opts: PullOpts,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<number> {
  try {
    const instance = resolveInstance({ host: opts.instance });
    const client = clientFactory(instance);
    const resolved = await resolveWorkflowRef(ref, {
      host: instance.host,
      client,
    });
    const fetched = await client.getWorkflow(resolved.id);
    const name = fetched.name;
    const dir = resolveWorkflowsDir(opts);
    const existingFile = findLocalFile(dir, name);
    const dest = existingFile ?? opts.out ?? newFilePath(dir, name);
    const diff = existingFile
      ? diffWorkflows(readWorkflowFile(existingFile), fetched)
      : undefined;
    // Never overwrite a differing local file without an explicit --yes,
    // regardless of TTY (no interactive prompt; --yes is the contract).
    const shouldGate = Boolean(diff && !opts.yes);
    const wrote = !shouldGate;

    if (wrote) {
      writeWorkflowFile(dest, fetched);
    }

    emitJson({
      instance: instance.host,
      workflow: {
        id: String(fetched.id ?? resolved.id),
        name,
        url: buildWorkflowUrl(instance.baseUrl, String(fetched.id ?? resolved.id)),
      },
      file: dest,
      wrote,
      summary: {
        nodeCount: (fetched.nodes ?? []).length,
        active: Boolean(fetched.active),
        triggerNodes: triggerNodes(fetched),
      },
      ...(diff ? { diff } : {}),
      ...(wrote
        ? {}
        : {
            hint: `Local file at ${dest} differs from the live workflow and was NOT overwritten. Re-run with --yes to replace it with the live version, or keep your local edits.`,
          }),
    });

    return 0;
  } catch (err) {
    const cliErr = toCliError(err);
    emitError(cliErr, resolveOutputMode(opts));
    return 2;
  }
}
