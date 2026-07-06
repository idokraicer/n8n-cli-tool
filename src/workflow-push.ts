import { mergeNodes, stripForPut } from "./workflow-merge";
import {
  diffWorkflows,
  validateWorkflow,
  type ValidationResult,
} from "./workflow-validate";
import type { WorkflowDefinition } from "./types";

export interface PushPreparation {
  pushDef: WorkflowDefinition;
  mode: "merge" | "whole";
  nodesUpdated: string[];
  nodesExcluded: {
    addedNodes: string[];
    removedNodes: string[];
    connectionsChanged: boolean;
  };
  validation: ValidationResult;
  diff: ReturnType<typeof diffWorkflows>;
  body: Partial<WorkflowDefinition>;
  strippedFields: string[];
  strippedSettingsKeys: string[];
}

// The shared compute path for every write to a live workflow: pick merge vs
// whole, validate, diff, and build the PUT body. Both `push` (local file) and
// `edit --remote` (in-memory edit) run through this so their behavior can't
// drift apart.
export function preparePush(
  live: WorkflowDefinition,
  desired: WorkflowDefinition,
  opts: { whole?: boolean; node?: string[] | null },
): PushPreparation {
  const mode: "merge" | "whole" = opts.whole ? "whole" : "merge";
  let pushDef: WorkflowDefinition;
  let nodesUpdated: string[];
  let nodesExcluded: PushPreparation["nodesExcluded"];

  if (mode === "whole") {
    pushDef = desired;
    nodesUpdated = (desired.nodes ?? []).map((node) => node.name);
    nodesExcluded = {
      addedNodes: [],
      removedNodes: [],
      connectionsChanged: false,
    };
  } else {
    const plan = mergeNodes(live, desired, opts.node ?? null);
    pushDef = plan.merged;
    nodesUpdated = plan.updated;
    nodesExcluded = plan.excluded;
  }

  const validation = validateWorkflow(pushDef, live);
  const diff = diffWorkflows(pushDef, live);
  const { body, strippedFields, strippedSettingsKeys } = stripForPut(pushDef);

  return {
    pushDef,
    mode,
    nodesUpdated,
    nodesExcluded,
    validation,
    diff,
    body,
    strippedFields,
    strippedSettingsKeys,
  };
}

export function validationSummary(validation: ValidationResult): {
  valid: boolean;
  errorCount: number;
  warningCount: number;
} {
  return {
    valid: validation.valid,
    errorCount: validation.summary.errorCount,
    warningCount: validation.summary.warningCount,
  };
}
