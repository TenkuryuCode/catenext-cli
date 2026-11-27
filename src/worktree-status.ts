import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findProjectRoot, readConfig, stateFilePath } from "./config.js";
import { loadProjectState } from "./db/project-codec.js";
import { isConsistent, LocalStore } from "./db/store.js";
import { LocalServiceError } from "./errors.js";
import { WorktreeError } from "./worktrees.js";

const MAX_MODIFIED_FILES = 50;

export interface WorktreeStatusLease {
  task_id: string;
  persona: string | null;
}

export interface WorktreeStatusEntry {
  path: string;
  branch: string | null;
  head: string | null;
  prunable: boolean;
  dirty_count: number;
  modified_files: string[];
  lease?: WorktreeStatusLease;
}

export interface WorktreeFileOverlap {
  file: string;
  worktrees: string[];
}

export interface WorktreeStatusResult {
  worktrees: WorktreeStatusEntry[];
  overlaps: WorktreeFileOverlap[];
}

interface RawGitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  prunable: boolean;
}

interface ActiveWorktreeLease {
  task_id: string;
  persona: string | null;
  branch: string | null;
  worktreePaths: string[];
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) {
    delete env[key];
  }
  return env;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd,
    env: cleanGitEnv(),
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent !== abs) {
      try {
        return join(realpathSync(parent), basename(abs));
      } catch {
        return abs;
      }
    }
    return abs;
  }
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === "";
}

export function parseWorktreeListPorcelain(raw: string): RawGitWorktree[] {
  const entries: RawGitWorktree[] = [];
  let current: RawGitWorktree | null = null;

  const flush = () => {
    if (current) {
      entries.push(current);
      current = null;
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice(9),
        head: null,
        branch: null,
        bare: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice(5) || null;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice(7);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref || null;
    } else if (line === "detached") {
      current.branch = null;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}

export function parseGitStatusPorcelain(raw: string): string[] {
  if (!raw) return [];
  const files: string[] = [];
  const seen = new Set<string>();

  if (raw.includes("\0")) {
    const tokens = raw.split("\0");
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i++];
      if (!token || token.length < 4) continue;
      const x = token[0];
      const y = token[1];
      const filePath = token.slice(3);
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        files.push(filePath);
      }
      if (x === "R" || x === "C" || y === "R" || y === "C") {
        i++;
      }
    }
    return files;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let filePath = line.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const arrow = filePath.indexOf(" -> ");
      if (arrow !== -1) filePath = filePath.slice(arrow + 4);
    }
    if (filePath.startsWith('"') && filePath.endsWith('"') && filePath.length >= 2) {
      filePath = filePath.slice(1, -1);
    }
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      files.push(filePath);
    }
  }
  return files;
}

async function readActiveWorktreeLeases(
  cwd: string,
  primaryPath?: string,
): Promise<ActiveWorktreeLease[]> {
  let root = await findProjectRoot(cwd, { managedWorktree: true });
  if (!root && primaryPath) {
    root = await findProjectRoot(primaryPath, { managedWorktree: true });
  }
  if (!root) return [];

  const config = await readConfig(root);
  const dbPath = stateFilePath(root, config);
  if (!existsSync(dbPath)) return [];

  const leases = await new LocalStore(dbPath).inspect((db) => {
    const { exists, project } = loadProjectState(db, config.project_id);
    if (!exists) return [];
    if (!isConsistent(project)) {
      throw new LocalServiceError("corrupt_state", "SQLite state tidak konsisten.");
    }
    const items: ActiveWorktreeLease[] = [];
    for (const task of project.tasks) {
      if (!task.lease) continue;
      const worktreePaths = [task.lease.worktree?.worktree_path, task.branch?.worktree_path]
        .filter((p): p is string => typeof p === "string" && isAbsolute(p))
        .map(canonicalPath);
      const branch = task.branch && task.branch.repo === config.repo_name ? task.branch.name : null;
      if (worktreePaths.length === 0 && !branch) continue;
      items.push({
        task_id: task.id,
        persona: task.lease.alias ?? task.persona ?? null,
        branch,
        worktreePaths,
      });
    }
    return items;
  });

  return leases ?? [];
}

function matchLease(
  wtPath: string,
  wtBranch: string | null,
  leases: ActiveWorktreeLease[],
): WorktreeStatusLease | undefined {
  const byPath = leases.find((lease) => lease.worktreePaths.some((p) => samePath(p, wtPath)));
  if (byPath) return { task_id: byPath.task_id, persona: byPath.persona };
  if (wtBranch) {
    const byBranch = leases.find((lease) => lease.branch !== null && lease.branch === wtBranch);
    if (byBranch) return { task_id: byBranch.task_id, persona: byBranch.persona };
  }
  return undefined;
}

/** Read-only Git worktree status, SQLite lease enrichment, and cross-worktree overlap detection. */
export async function readWorktreeStatus(
  cwd: string = process.cwd(),
): Promise<WorktreeStatusResult> {
  let rawList: string;
  try {
    rawList = runGit(cwd, ["worktree", "list", "--porcelain"]);
  } catch {
    throw new WorktreeError("Tidak bisa membaca daftar worktree Git.");
  }

  const rawTrees = parseWorktreeListPorcelain(rawList);
  if (rawTrees.length === 0 || rawTrees.some((entry) => !isAbsolute(entry.path))) {
    throw new WorktreeError("Daftar worktree Git tidak valid.");
  }

  const primaryPath = rawTrees[0] ? canonicalPath(rawTrees[0].path) : undefined;
  const leases = await readActiveWorktreeLeases(cwd, primaryPath);

  const inspected: Array<WorktreeStatusEntry & { allDirtyFiles: string[] }> = [];
  for (const rawTree of rawTrees) {
    const path = canonicalPath(rawTree.path);
    const missing = !existsSync(path);
    let prunable = rawTree.prunable || missing;
    let allDirtyFiles: string[] = [];

    if (!prunable && !rawTree.bare) {
      try {
        const statusRaw = runGit(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        allDirtyFiles = parseGitStatusPorcelain(statusRaw);
      } catch {
        if (!existsSync(path)) {
          prunable = true;
        }
        allDirtyFiles = [];
      }
    }

    const lease = matchLease(path, rawTree.branch, leases);
    inspected.push({
      path,
      branch: rawTree.branch,
      head: rawTree.head,
      prunable,
      dirty_count: allDirtyFiles.length,
      modified_files: allDirtyFiles.slice(0, MAX_MODIFIED_FILES),
      ...(lease ? { lease } : {}),
      allDirtyFiles,
    });
  }

  const fileToWorktrees = new Map<string, string[]>();
  for (const entry of inspected) {
    for (const file of entry.allDirtyFiles) {
      const list = fileToWorktrees.get(file);
      if (list) list.push(entry.path);
      else fileToWorktrees.set(file, [entry.path]);
    }
  }

  const overlaps: WorktreeFileOverlap[] = [];
  for (const [file, worktrees] of fileToWorktrees.entries()) {
    if (worktrees.length >= 2) {
      overlaps.push({ file, worktrees });
    }
  }
  overlaps.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    worktrees: inspected.map(({ allDirtyFiles: _ignored, ...entry }) => entry),
    overlaps,
  };
}

export function formatWorktreeStatus(result: WorktreeStatusResult): string {
  const lines: string[] = [];
  for (const wt of result.worktrees) {
    const branchLabel = wt.branch ?? "(detached)";
    const headLabel = wt.head ? wt.head.slice(0, 7) : "-";
    const stateParts: string[] = [];
    if (wt.prunable) stateParts.push("missing/prunable");
    stateParts.push(wt.dirty_count === 0 ? "clean" : `${wt.dirty_count} dirty`);
    if (wt.lease) {
      const who = wt.lease.persona ?? "unassigned";
      stateParts.push(`lease=${who}:${wt.lease.task_id}`);
    }
    lines.push(
      `${branchLabel}  ${JSON.stringify(wt.path)}  head=${headLabel}  [${stateParts.join(", ")}]`,
    );
  }
  if (result.overlaps.length > 0) {
    for (const overlap of result.overlaps) {
      lines.push(
        `OVERLAP: ${overlap.file}  (${overlap.worktrees.map((p) => JSON.stringify(p)).join(", ")})`,
      );
    }
  } else {
    lines.push("No cross-worktree file overlaps.");
  }
  return lines.join("\n");
}
