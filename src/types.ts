export interface InstanceConfig {
  baseUrl: string;
  apiKey: string;
  email?: string;
  password?: string;
  browserId?: string;
  sessionCookie?: string;
}

export interface Config {
  defaultInstance?: string;
  instances: Record<string, InstanceConfig>;
}

export interface ResolvedInstance {
  host: string;
  baseUrl: string;
  apiKey: string;
}

export interface ParsedN8nUrl {
  kind: "workflow" | "execution";
  host: string;
  baseUrl: string;
  workflowId: string;
  executionId?: string;
}

export interface WebhookEntry {
  node: string;
  method: string;
  path: string;
  productionUrl: string;
  testUrl: string;
}

export interface WorkflowRow {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  tags: string[];
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
  webhooks: WebhookEntry[];
  url: string;
}

export interface CatalogManifest {
  schemaVersion: number;
  instance: string;
  baseUrl: string;
  syncedAt: string;
  workflowCount: number;
}

export interface ExecutionListItem {
  id: string;
  status: string;
  mode: string;
  finished: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  url: string;
}

export interface ExecutionInfo {
  id: string;
  workflowId: string;
  status: string;
  mode: string;
  finished: boolean;
  startedAt: string | null;
  stoppedAt: string | null;
  url: string;
}

export interface SearchUnit {
  node: string;
  runIndex: number;
  outputIndex: number;
  itemIndex: number;
  json: unknown;
  binary: Record<string, unknown> | undefined;
}

export interface NodeSummary {
  name: string;
  runs: number;
  items: number;
  status: string;
}

export type MatchMode = "substring" | "exact" | "regex";

export interface Match {
  executionId: string;
  node: string;
  runIndex: number;
  outputIndex: number;
  itemIndex: number;
  path: string;
  value: string;
  valueType: string;
  url: string;
  context?: unknown;
}

export class CliError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}
