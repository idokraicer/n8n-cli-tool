import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { CliError, type WorkflowDefinition } from "./types";

export function resolveWorkflowsDir(opts: { dir?: string }): string {
  return opts.dir ?? process.env.N8N_WORKFLOWS_DIR ?? "./workflows";
}

export function slugify(name: string): string {
  // Preserve Unicode letters/digits so non-ASCII names (e.g. Hebrew) don't all
  // collapse to the same empty slug and collide on one file.
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (slug) return slug;
  // A name with no letters/digits at all (emoji/punctuation only): fall back to
  // a deterministic per-name suffix so distinct names still get distinct files.
  return `wf-${createHash("sha1").update(name).digest("hex").slice(0, 8)}`;
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

      if (wantedStem && basename(entry.name, ".json") === wantedStem) {
        stemMatches.push(path);
      }
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
  if (stemMatches.length > 1) {
    throw new CliError(
      "bad-arguments",
      `Multiple local files match the name slug '${wantedStem}': ${stemMatches.join(", ")}. Pass an explicit --dir or rename to disambiguate.`,
      { candidates: stemMatches },
    );
  }
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
  // Write-then-rename so a crash/full-disk mid-write can't truncate the target
  // to an empty/partial file (rename is atomic on the same filesystem). Matches
  // the catalog's atomic-write pattern; critical for `edit`, whose content has
  // no remote copy.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(def, null, 2)}\n`);
  renameSync(tmp, path);
}
