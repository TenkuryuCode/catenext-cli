import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { findProjectRoot, readConfig, stateFilePath } from "./config.js";
import { loadProjectState } from "./db/project-codec.js";
import { isConsistent, LocalStore } from "./db/store.js";
import { LocalServiceError } from "./errors.js";
import type { LocalTask } from "./local-state.js";
import { scrubText } from "./scrubber.js";
import { WorktreeError } from "./worktrees.js";

const MAX_MODIFIED_FILES = 50;
const MAX_MERGE_DRY_RUN_PAIRS = 20;
const MERGE_DRY_RUN_TIMEOUT_MS = 2500;
export const WORKTREE_HINT_TIMEOUT_MS = 250;
const exec = promisify(execFile);

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
  ahead_count: number;
  ahead_files: string[];
  lease?: WorktreeStatusLease;
}

export interface WorktreeFileOverlap {
  file: string;
  worktrees: string[];
}

export interface WorktreeMergeConflict {
  source: string;
  target: string;
  conflicts: string[];
  conflict_count: number;
}

export interface WorktreeStatusResult {
  worktrees: WorktreeStatusEntry[];
  overlaps: WorktreeFileOverlap[];
  merge_conflicts?: WorktreeMergeConflict[];
}

interface RawGitWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  prunable: boolean;
}

export interface ActiveWorktreeLease extends WorktreeStatusLease {
  branch: string | null;
  baseBranch: string | null;
  worktreePaths: string[];
}

type GitRunner = (cwd: string, args: string[]) => Promise<string>;

function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = exec("git", ["--no-optional-locks", ...args], {
    cwd,
    env: cleanGitEnv(),
    encoding: "utf8",
    ...(signal ? { signal, killSignal: "SIGKILL" } : { timeout: 5000 }),
    // Bound parsing and file bookkeeping per command for best-effort hints only.
    maxBuffer: signal ? 256 * 1024 : 8 * 1024 * 1024,
  });
  child.child.stdin?.end();
  const { stdout } = await child;
  signal?.throwIfAborted();
  return stdout;
}

async function canonicalPath(path: string): Promise<string> {
  const abs = resolve(path);
  try {
    return await realpath(abs);
  } catch {
    const parent = dirname(abs);
    if (parent !== abs) {
      try {
        return join(await realpath(parent), basename(abs));
      } catch {
        return abs;
      }
    }
    return abs;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
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

export function parseGitDiffNameOnly(raw: string): string[] {
  if (!raw) return [];
  const files: string[] = [];
  const seen = new Set<string>();
  const tokens = raw.includes("\0") ? raw.split("\0") : raw.split(/\r?\n/);
  for (const token of tokens) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    files.push(token);
  }
  return files;
}

function isValidCommitSha(sha: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(sha);
}

function isValidGitRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false;
  if (ref.startsWith("-") || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock")) {
    return false;
  }
  if (/[\s~^:?*[\\]/.test(ref)) return false;
  return !Array.from(ref).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

export function parseMergeTreeConflicts(raw: string): string[] {
  if (!raw) return [];
  const tokens = raw.includes("\0") ? raw.split("\0") : raw.split(/\r?\n/);
  const files: string[] = [];
  const seen = new Set<string>();
  let index = 0;
  if (tokens[0] && isValidCommitSha(tokens[0].trim())) {
    index = 1;
  }
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || seen.has(token)) continue;
    seen.add(token);
    files.push(token);
  }
  return files;
}

async function verifyCommitRef(git: GitRunner, cwd: string, ref: string): Promise<string | null> {
  if (!isValidGitRef(ref)) return null;
  try {
    const out = (
      await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])
    ).trim();
    return isValidCommitSha(out) ? out : null;
  } catch {
    return null;
  }
}

async function resolveDefaultBaseRef(
  git: GitRunner,
  cwd: string,
  primaryBranch: string | null,
): Promise<{ ref: string; commit: string } | null> {
  const candidates: string[] = [];
  try {
    const remoteHead = (
      await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    ).trim();
    const prefix = "refs/remotes/origin/";
    if (remoteHead.startsWith(prefix)) {
      const name = remoteHead.slice(prefix.length);
      if (name) {
        candidates.push(`refs/heads/${name}`, remoteHead);
      }
    }
  } catch {
    // No origin/HEAD configured.
  }
  candidates.push("refs/heads/main", "refs/heads/master");
  if (primaryBranch) {
    candidates.push(`refs/heads/${primaryBranch}`);
  }

  for (const ref of new Set(candidates)) {
    const commit = await verifyCommitRef(git, cwd, ref);
    if (commit) return { ref, commit };
  }
  return null;
}

async function readMarkerBaseBranch(
  git: GitRunner,
  wtPath: string,
  branch: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!branch) return null;
  try {
    const gitDirRaw = (await git(wtPath, ["rev-parse", "--git-dir"])).trim();
    if (!gitDirRaw) return null;
    const adminDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(wtPath, gitDirRaw);
    const markerPath = join(adminDir, "catenext-worktree.json");
    const parsed = JSON.parse(await readFile(markerPath, { encoding: "utf8", signal })) as {
      branch?: unknown;
      base_branch?: unknown;
    };
    if (
      parsed.branch === branch &&
      typeof parsed.base_branch === "string" &&
      isValidGitRef(parsed.base_branch)
    ) {
      return parsed.base_branch;
    }
    return null;
  } catch {
    return null;
  }
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

  return (
    (await new LocalStore(dbPath).inspect((db) => {
      const { exists, project } = loadProjectState(db, config.project_id);
      if (!exists) return [];
      if (!isConsistent(project)) {
        throw new LocalServiceError("corrupt_state", "SQLite state tidak konsisten.");
      }
      return snapshotWorktreeLeases(project.tasks, config.repo_name);
    })) ?? []
  );
}

/** Copy only lease metadata used by worktree status; no filesystem access or lease tokens. */
export function snapshotWorktreeLeases(tasks: LocalTask[], repo: string): ActiveWorktreeLease[] {
  return tasks.flatMap((task) => {
    if (!task.lease) return [];
    const worktreePaths = [task.lease.worktree?.worktree_path, task.branch?.worktree_path].filter(
      (p): p is string => typeof p === "string" && isAbsolute(p),
    );
    const branch = task.branch?.repo === repo ? task.branch.name : null;
    if (!worktreePaths.length && !branch) return [];
    return [
      {
        task_id: task.id,
        persona: task.lease.alias ?? task.persona ?? null,
        branch,
        baseBranch: task.lease.worktree?.base_branch ?? null,
        worktreePaths,
      },
    ];
  });
}

function matchLeaseRecord(
  wtPath: string,
  wtBranch: string | null,
  leases: ActiveWorktreeLease[],
): ActiveWorktreeLease | undefined {
  const byPath = leases.find((lease) => lease.worktreePaths.some((p) => samePath(p, wtPath)));
  if (byPath) return byPath;
  if (wtBranch) {
    const byBranch = leases.find((lease) => lease.branch !== null && lease.branch === wtBranch);
    if (byBranch) return byBranch;
  }
  return undefined;
}

function shortRefName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice(11);
  if (ref.startsWith("refs/remotes/")) return ref.slice(13);
  return ref;
}

async function runMergeTreeDryRun(
  cwd: string,
  commitA: string,
  commitB: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (!isValidCommitSha(commitA) || !isValidCommitSha(commitB)) return null;
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(MERGE_DRY_RUN_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const child = exec(
    "git",
    [
      "--no-optional-locks",
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      "-z",
      "--end-of-options",
      commitA,
      commitB,
    ],
    {
      cwd,
      env: cleanGitEnv(),
      encoding: "utf8",
      signal: combinedSignal,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    },
  );
  child.child.stdin?.end();
  try {
    await child;
    return [];
  } catch (error) {
    signal?.throwIfAborted();
    const err = error as { code?: unknown; stdout?: unknown };
    if (err.code === 1 && typeof err.stdout === "string") {
      return parseMergeTreeConflicts(err.stdout);
    }
    return null;
  }
}

/** Full CLI status. Keep normal per-command Git timeouts and SQLite lease enrichment. */
export async function readWorktreeStatus(
  cwd: string = process.cwd(),
  options?: { leases?: readonly ActiveWorktreeLease[]; mergeDryRun?: boolean },
): Promise<WorktreeStatusResult> {
  return scanWorktreeStatus(cwd, {
    ...(options?.leases ? { leases: options.leases } : {}),
    ...(options?.mergeDryRun ? { mergeDryRun: true } : {}),
  });
}

/** Best-effort scan from a lease snapshot. Never reopens SQLite or reads project config. */
export async function readWorktreeOverlapHint(
  cwd: string,
  leases: readonly ActiveWorktreeLease[],
  deadline: AbortSignal = AbortSignal.timeout(WORKTREE_HINT_TIMEOUT_MS),
): Promise<WorktreeFileOverlap[]> {
  if (deadline.aborted) return [];
  // realpath/access cannot be aborted. Return on deadline even if such a call is still pending.
  let onAbort: () => void = () => {};
  const aborted = new Promise<WorktreeFileOverlap[]>((resolve) => {
    onAbort = () => resolve([]);
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const scan = scanWorktreeStatus(cwd, { leases, signal: deadline });
    return await Promise.race([scan.then(({ overlaps }) => overlaps), aborted]);
  } catch {
    return [];
  } finally {
    deadline.removeEventListener("abort", onAbort);
  }
}

async function scanWorktreeStatus(
  cwd: string,
  hint?: { leases?: readonly ActiveWorktreeLease[]; signal?: AbortSignal; mergeDryRun?: boolean },
): Promise<WorktreeStatusResult> {
  const signal = hint?.signal;
  const git: GitRunner = (cwd, args) => runGit(cwd, args, signal);
  let rawList: string;
  try {
    rawList = await git(cwd, ["worktree", "list", "--porcelain"]);
  } catch {
    signal?.throwIfAborted();
    throw new WorktreeError("Tidak bisa membaca daftar worktree Git.");
  }

  const rawTrees = parseWorktreeListPorcelain(rawList);
  const primary = rawTrees[0];
  if (!primary || rawTrees.some((entry) => !isAbsolute(entry.path))) {
    throw new WorktreeError("Daftar worktree Git tidak valid.");
  }
  const primaryPath = await canonicalPath(primary.path);
  signal?.throwIfAborted();
  const rawLeases = hint?.leases ?? (await readActiveWorktreeLeases(cwd, primaryPath));
  const leases: ActiveWorktreeLease[] = [];
  for (const lease of rawLeases) {
    signal?.throwIfAborted();
    leases.push({
      ...lease,
      worktreePaths: await Promise.all(lease.worktreePaths.map(canonicalPath)),
    });
  }
  const defaultBase = await resolveDefaultBaseRef(git, primaryPath, primary.branch);

  const inspected: Array<
    WorktreeStatusEntry & {
      allDirtyFiles: string[];
      allAheadFiles: string[];
      bare: boolean;
      resolvedBaseRef: string | null;
      resolvedBaseCommit: string | null;
    }
  > = [];
  for (const [index, rawTree] of rawTrees.entries()) {
    signal?.throwIfAborted();
    const path = index === 0 ? primaryPath : await canonicalPath(rawTree.path);
    const missing = !(await exists(path));
    signal?.throwIfAborted();
    let prunable = rawTree.prunable || missing;
    let allDirtyFiles: string[] = [];
    let allAheadFiles: string[] = [];
    let baseRef: string | null = null;
    let baseCommit: string | null = null;

    if (!prunable && !rawTree.bare) {
      try {
        const statusRaw = await git(path, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
        allDirtyFiles = parseGitStatusPorcelain(statusRaw);
      } catch {
        signal?.throwIfAborted();
        if (!(await exists(path))) {
          prunable = true;
        }
        allDirtyFiles = [];
      }
    }

    const leaseRecord = matchLeaseRecord(path, rawTree.branch, leases);
    const lease: WorktreeStatusLease | undefined = leaseRecord
      ? { task_id: leaseRecord.task_id, persona: leaseRecord.persona }
      : undefined;

    if (!prunable && !rawTree.bare && rawTree.branch && rawTree.head) {
      const preferredBase =
        leaseRecord?.baseBranch ??
        (index > 0 ? await readMarkerBaseBranch(git, path, rawTree.branch, signal) : null);
      if (preferredBase && isValidGitRef(preferredBase)) {
        const candidates = preferredBase.startsWith("refs/")
          ? [preferredBase]
          : [`refs/heads/${preferredBase}`, preferredBase];
        for (const ref of candidates) {
          const commit = await verifyCommitRef(git, path, ref);
          if (commit) {
            baseRef = ref;
            baseCommit = commit;
            break;
          }
        }
      }
      if (!baseRef && defaultBase) {
        baseRef = defaultBase.ref;
        baseCommit = defaultBase.commit;
      }

      if (
        baseRef &&
        baseCommit &&
        baseCommit !== rawTree.head &&
        baseRef !== `refs/heads/${rawTree.branch}`
      ) {
        try {
          const diffRaw = await git(path, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            "--end-of-options",
            `${baseRef}...HEAD`,
            "--",
          ]);
          allAheadFiles = parseGitDiffNameOnly(diffRaw);
        } catch {
          signal?.throwIfAborted();
          allAheadFiles = [];
        }
      }
    }

    inspected.push({
      path,
      branch: rawTree.branch,
      head: rawTree.head,
      prunable,
      dirty_count: allDirtyFiles.length,
      modified_files: allDirtyFiles.slice(0, MAX_MODIFIED_FILES),
      ahead_count: allAheadFiles.length,
      ahead_files: allAheadFiles.slice(0, MAX_MODIFIED_FILES),
      ...(lease ? { lease } : {}),
      allDirtyFiles,
      allAheadFiles,
      bare: rawTree.bare,
      resolvedBaseRef: baseRef,
      resolvedBaseCommit: baseCommit,
    });
  }

  signal?.throwIfAborted();
  const fileToWorktrees = new Map<string, string[]>();
  for (const entry of inspected) {
    const touchedFiles = new Set([...entry.allDirtyFiles, ...entry.allAheadFiles]);
    for (const file of touchedFiles) {
      const list = fileToWorktrees.get(file);
      if (list) list.push(entry.path);
      else fileToWorktrees.set(file, [entry.path]);
    }
  }

  const overlaps: WorktreeFileOverlap[] = [];
  for (const [file, worktrees] of fileToWorktrees.entries()) {
    if (worktrees.length >= 2) {
      overlaps.push({
        file: scrubText(file),
        worktrees: worktrees.map((worktreePath) => scrubText(worktreePath)),
      });
    }
  }
  overlaps.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  let mergeConflicts: WorktreeMergeConflict[] | undefined;
  if (hint?.mergeDryRun) {
    mergeConflicts = [];
    const seenPairs = new Set<string>();
    const pairs: Array<{
      source: string;
      target: string;
      commitA: string;
      commitB: string;
    }> = [];

    const activeHeads = inspected.filter(
      (entry): entry is typeof entry & { head: string } =>
        !entry.prunable && !entry.bare && entry.head !== null && isValidCommitSha(entry.head),
    );

    const addPair = (source: string, target: string, commitA: string, commitB: string) => {
      if (pairs.length >= MAX_MERGE_DRY_RUN_PAIRS) return;
      if (commitA === commitB) return;
      const key = commitA < commitB ? `${commitA}:${commitB}` : `${commitB}:${commitA}`;
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      pairs.push({ source, target, commitA, commitB });
    };

    for (const entry of activeHeads) {
      const label = entry.branch ?? `(detached:${entry.head.slice(0, 7)})`;
      if (
        entry.resolvedBaseRef &&
        entry.resolvedBaseCommit &&
        entry.resolvedBaseCommit !== entry.head &&
        entry.resolvedBaseRef !== (entry.branch ? `refs/heads/${entry.branch}` : null)
      ) {
        addPair(label, shortRefName(entry.resolvedBaseRef), entry.head, entry.resolvedBaseCommit);
      }
    }

    for (const [i, a] of activeHeads.entries()) {
      const labelA = a.branch ?? `(detached:${a.head.slice(0, 7)})`;
      for (const b of activeHeads.slice(i + 1)) {
        const labelB = b.branch ?? `(detached:${b.head.slice(0, 7)})`;
        addPair(labelA, labelB, a.head, b.head);
      }
    }

    for (const pair of pairs) {
      signal?.throwIfAborted();
      const conflicts = await runMergeTreeDryRun(primaryPath, pair.commitA, pair.commitB, signal);
      if (conflicts && conflicts.length > 0) {
        mergeConflicts.push({
          source: scrubText(pair.source),
          target: scrubText(pair.target),
          conflicts: conflicts.slice(0, MAX_MODIFIED_FILES).map((c) => scrubText(c)),
          conflict_count: conflicts.length,
        });
      }
    }
  }

  return {
    worktrees: inspected.map(
      ({
        allDirtyFiles: _d,
        allAheadFiles: _a,
        bare: _b,
        resolvedBaseRef: _br,
        resolvedBaseCommit: _bc,
        ...entry
      }) => ({
        ...entry,
        path: scrubText(entry.path),
        branch: entry.branch !== null ? scrubText(entry.branch) : null,
        modified_files: entry.modified_files.map((file) => scrubText(file)),
        ahead_files: entry.ahead_files.map((file) => scrubText(file)),
      }),
    ),
    overlaps,
    ...(mergeConflicts !== undefined ? { merge_conflicts: mergeConflicts } : {}),
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
    if (wt.ahead_count > 0) stateParts.push(`${wt.ahead_count} ahead`);
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
  if (result.merge_conflicts !== undefined) {
    if (result.merge_conflicts.length > 0) {
      for (const conflict of result.merge_conflicts) {
        const preview = conflict.conflicts.slice(0, 5).join(", ");
        const more = conflict.conflict_count > 5 ? `, +${conflict.conflict_count - 5} more` : "";
        lines.push(
          `MERGE CONFLICT: ${conflict.source} <-> ${conflict.target} (${conflict.conflict_count}): ${preview}${more}`,
        );
      }
    } else {
      lines.push("No merge-tree conflicts.");
    }
  }
  return lines.join("\n");
}
