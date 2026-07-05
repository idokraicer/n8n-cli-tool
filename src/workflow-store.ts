import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { CliError, type WorkflowDefinition } from "./types";

export function resolveWorkflowsDir(opts: { dir?: string }): string {
  return opts.dir ?? process.env.N8N_WORKFLOWS_DIR ?? "./workflows";
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function findLocalFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;

  const nameMatches: string[] = [];
  const stemMatches: string[] = [];
  const wantedStem = slugify(name);

  function walk(currentDir: string): void {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const path = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(path);
        continue;
      }

      if (!entry.isFile() || extname(entry.name) !== ".json") continue;

      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed?.name === name) nameMatches.push(path);
      } catch {
        // Invalid JSON files are not workflow candidates by parsed name.
      }

      if (basename(entry.name, ".json") === wantedStem) stemMatches.push(path);
    }
  }

  walk(dir);

  if (nameMatches.length > 1) {
    throw new CliError(
      "bad-arguments",
      `Multiple local workflow files named '${name}': ${nameMatches.join(", ")}`,
      { candidates: nameMatches },
    );
  }

  if (nameMatches.length === 1) return nameMatches[0];
  return stemMatches[0] ?? null;
}

export function newFilePath(dir: string, name: string): string {
  return join(dir, `${slugify(name)}.json`);
}

export function readWorkflowFile(path: string): WorkflowDefinition {
  if (!existsSync(path)) {
    throw new CliError(
      "no-local-file",
      `No local workflow file at ${path}. Run \`n8n-helper pull\` first.`,
    );
  }

  return JSON.parse(readFileSync(path, "utf8")) as WorkflowDefinition;
}

export function writeWorkflowFile(
  path: string,
  def: WorkflowDefinition,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(def, null, 2)}\n`);
}
