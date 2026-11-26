import { execFile } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { type CatenextConfig, ClaimTaskInput } from "@catenext/shared";
import { z } from "zod";
import { isMissingFile, stateFilePath } from "./config.js";
import { loadProjectState } from "./db/project-codec.js";
import { isConsistent, LocalStore } from "./db/store.js";
import { LocalServiceError } from "./errors.js";
import type { LocalTask } from "./local-state.js";

const exec = promisify(execFile);
const MARKER = "catenext-worktree.json";
const markerSchema = z.strictObject({
  project_id: z.uuid(),
  repo: z.string().min(1),
  ...ClaimTaskInput.shape.worktree.unwrap().required().shape,
  task_id: z.uuid(),
});

type Marker = z.output<typeof markerSchema>;

export class WorktreeError extends Error {}

async function git(cwd: string, ...args: string[]): Promise<string> {
  // Ambient overrides must not redirect Git to a different checkout or index.
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) {
    delete env[key];
  }
  const result = await exec(
    "git",
    ["--no-optional-locks", "-c", `core.hooksPath=${devNull}`, ...args],
    { cwd, env, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  return result.stdout;
}

const line = (value: string) => value.replace(/\r?\n$/, "");

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === "";
}

interface GitWorktreeRegistration {
  path: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

/** Read Git registrations without opening SQLite or inspecting checkout contents. */
export async function readGitWorktreeRegistrations(
  cwd: string,
): Promise<GitWorktreeRegistration[]> {
  let raw: string;
  try {
    raw = await git(cwd, "worktree", "list", "--porcelain", "-z");
  } catch {
    throw new WorktreeError("Tidak bisa membaca daftar worktree Git.");
  }
  const trees: GitWorktreeRegistration[] = [];
  let tree: GitWorktreeRegistration | undefined;
  for (const field of raw.split("\0")) {
    if (field.startsWith("worktree ")) {
      tree = { path: field.slice(9), branch: null, locked: false, prunable: false };
      trees.push(tree);
    } else if (tree && field.startsWith("branch refs/heads/")) {
      tree.branch = field.slice(18);
    } else if (tree && (field === "locked" || field.startsWith("locked "))) {
      tree.locked = true;
    } else if (tree && (field === "prunable" || field.startsWith("prunable "))) {
      tree.prunable = true;
    }
  }
  if (!trees.length || trees.some((entry) => !isAbsolute(entry.path))) {
    throw new WorktreeError("Daftar worktree Git tidak valid.");
  }
  return trees;
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function gitDir(path: string, kind: "--absolute-git-dir" | "--git-common-dir") {
  return realpath(line(await git(path, "rev-parse", "--path-format=absolute", kind)));
}

/** Only use Git admin data belonging to this exact linked checkout, never files in its working tree. */
async function linkedAdmin(path: string, common: string): Promise<string> {
  const [admin, checkoutCommon, top] = await Promise.all([
    gitDir(path, "--absolute-git-dir"),
    gitDir(path, "--git-common-dir"),
    git(path, "rev-parse", "--show-toplevel"),
  ]);
  if (
    !samePath(dirname(admin), join(common, "worktrees")) ||
    !samePath(common, checkoutCommon) ||
    !samePath(await realpath(line(top)), path)
  ) {
    throw new WorktreeError("Identitas worktree Git tidak cocok.");
  }
  return admin;
}

async function readMarker(admin: string, path: string, branch: string | null) {
  try {
    const file = join(admin, MARKER);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) return null;
    const result = markerSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return result.success &&
      result.data.branch === branch &&
      samePath(result.data.worktree_path, path) &&
      isAbsolute(result.data.worktree_path)
      ? result.data
      : null;
  } catch {
    return null;
  }
}

/** Resolve only checkouts created by `claim --create-worktree`, for shared CLI/MCP state discovery. */
export async function readManagedWorktree(path: string) {
  try {
    const root = await realpath(path);
    const [primary, ...linked] = await readGitWorktreeRegistrations(root);
    if (!primary) return null;
    const tree = linked.find((entry) => samePath(entry.path, root));
    if (!tree) return null;
    const admin = await linkedAdmin(root, await gitDir(root, "--git-common-dir"));
    const marker = await readMarker(admin, root, tree.branch);
    return marker ? { primary: await realpath(primary.path), marker } : null;
  } catch {
    return null;
  }
}

async function checkBranch(cwd: string, name: string, label: string) {
  // Shared claim validation limits syntax; check-ref-format also rejects malformed Git refs.
  const schema = ClaimTaskInput.shape.worktree.unwrap().shape.branch;
  if (schema.safeParse(name).success) {
    try {
      await git(cwd, "check-ref-format", `refs/heads/${name}`);
      return;
    } catch {
      // Invalid Git ref.
    }
  }
  throw new WorktreeError(`${label} tidak valid.`);
}

export interface CreateWorktreeOptions {
  branch?: string;
  base?: string;
  path?: string;
}

/** Validate and create a new checkout without switching branches in the calling checkout. */
export async function createClaimWorktree(
  root: string,
  cwd: string,
  config: Pick<CatenextConfig, "project_id" | "repo_name">,
  taskId: string,
  sessionId: string,
  options: CreateWorktreeOptions,
) {
  const [primary, ...linked] = await readGitWorktreeRegistrations(cwd);
  if (!primary || !samePath(await realpath(primary.path), await realpath(root))) {
    throw new WorktreeError(
      "Pembuatan worktree otomatis memerlukan config di root worktree utama.",
    );
  }
  const primaryPath = await realpath(primary.path);
  const branch = options.branch ?? `catenext/${taskId}`;
  await checkBranch(primaryPath, branch, "--branch");
  if (["main", "master"].includes(branch)) throw new WorktreeError("Pilih branch kerja baru.");

  // Only use local branches as a base. Resolve to a commit so a tag or path cannot shadow the ref.
  const base = options.base ?? (await defaultBase(primaryPath));
  await checkBranch(primaryPath, base, "--base");
  let commit: string;
  try {
    commit = line(await git(primaryPath, "rev-parse", "--verify", `refs/heads/${base}^{commit}`));
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error("Invalid commit");
  } catch {
    throw new WorktreeError("--base harus menunjuk ke branch lokal dengan commit.");
  }

  const requested =
    options.path ?? join(dirname(primaryPath), `${basename(primaryPath)}-catenext-${taskId}`);
  if (!requested.trim() || Array.from(requested).some((char) => char < " " || char === "\x7f")) {
    throw new WorktreeError("--path tidak valid.");
  }
  const target = resolve(primaryPath, requested);
  let parent: string;
  try {
    parent = await realpath(dirname(target));
    if (!(await lstat(parent)).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw new WorktreeError("Folder induk --path harus sudah ada.");
  }
  const path = join(parent, basename(target));
  const knownPaths = await Promise.all([primary, ...linked].map((tree) => canonical(tree.path)));
  if (knownPaths.some((known) => contains(known, path) || contains(path, known))) {
    throw new WorktreeError("--path harus di luar worktree yang sudah terdaftar.");
  }
  // Refuse destinations within other repositories (including unregistered linked checkouts).
  for (let dir = parent; ; dir = dirname(dir)) {
    await requireMissing(join(dir, ".git"), "--path harus di luar checkout Git lain.");
    if (dir === dirname(dir)) break;
  }
  await requireMissing(path, "--path harus belum ada.");
  const marker = markerSchema.safeParse({
    branch,
    base_branch: base,
    worktree_path: path,
    session_id: sessionId,
    project_id: config.project_id,
    repo: config.repo_name,
    task_id: taskId,
  });
  if (!marker.success) throw new WorktreeError("Metadata worktree tidak valid.");

  try {
    // -b, never -B: an existing branch is not moved or reused.
    await git(primaryPath, "worktree", "add", "-b", branch, "--", path, commit);
  } catch {
    throw new WorktreeError("Git gagal membuat worktree. Pastikan branch dan path belum dipakai.");
  }
  const common = await gitDir(primaryPath, "--git-common-dir");
  const admin = await linkedAdmin(path, common);
  const identity = await lstat(admin);
  const validate = async () => {
    try {
      const [, ...currentLinked] = await readGitWorktreeRegistrations(primaryPath);
      const tree = currentLinked.find((entry) => samePath(entry.path, path));
      if (tree?.branch !== branch || tree.prunable || !samePath(await realpath(path), path)) {
        throw new Error("Checkout changed");
      }
      if (!samePath(await linkedAdmin(path, common), admin)) throw new Error("Git admin changed");
      const current = await lstat(admin);
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error("Checkout replaced");
      }
    } catch {
      throw new WorktreeError("Checkout baru telah berubah atau hilang; task tidak diklaim.");
    }
  };
  return {
    marker: marker.data,
    validate,
    // Called after claim settles: prune cannot see a halfway-created worktree as eligible.
    mark: async () => {
      await validate();
      await writeFile(join(admin, MARKER), JSON.stringify(marker.data), {
        flag: "wx",
        mode: 0o600,
      });
    },
  };
}

async function defaultBase(root: string): Promise<string> {
  const remoteHead = await git(root, "symbolic-ref", "refs/remotes/origin/HEAD").catch(() => "");
  const prefix = "refs/remotes/origin/";
  const upstream = line(remoteHead).startsWith(prefix) ? line(remoteHead).slice(prefix.length) : "";
  for (const name of new Set([upstream, "main", "master"])) {
    if (!name) continue;
    if (await git(root, "show-ref", "--verify", `refs/heads/${name}`).catch(() => null))
      return name;
  }
  throw new WorktreeError("Tidak bisa mendeteksi base branch lokal; isi --base <branch>.");
}

async function requireMissing(path: string, message: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  throw new WorktreeError(message);
}

export type WorktreeStatus =
  | "primary"
  | "active"
  | "reserved"
  | "stale"
  | "orphaned"
  | "unmanaged"
  | "unavailable";

export interface WorktreeEntry extends GitWorktreeRegistration {
  primary: boolean;
  current: boolean;
  managed: boolean;
  status: WorktreeStatus;
  dirty: boolean | null;
  eligible: boolean;
}

export interface WorktreeInventoryOptions {
  /** Configured root; SQLite state_file resolves against this path, not cwd. */
  root: string;
  config: Pick<CatenextConfig, "project_id" | "repo_name" | "state_file">;
  cwd?: string;
}

type Snapshot = Array<{ task: LocalTask; paths: string[] }>;

function inspectStore(options: WorktreeInventoryOptions) {
  return new LocalStore(stateFilePath(options.root, options.config));
}

async function snapshot(
  db: DatabaseSync,
  options: WorktreeInventoryOptions,
): Promise<Snapshot | null> {
  const { exists, project } = loadProjectState(db, options.config.project_id);
  if (!exists) return null;
  if (!isConsistent(project))
    throw new LocalServiceError("corrupt_state", "SQLite state tidak konsisten.");
  return Promise.all(
    project.tasks.map(async (task) => ({
      task,
      paths: await Promise.all(
        [task.branch?.worktree_path, task.lease?.worktree?.worktree_path]
          .filter((path): path is string => typeof path === "string" && isAbsolute(path))
          .map(canonical),
      ),
    })),
  );
}

function leaseStatus(
  tree: GitWorktreeRegistration,
  marker: Marker | null,
  records: Snapshot | null,
  repo: string,
): WorktreeStatus {
  if (!records) return "unavailable";
  const now = Date.now();
  let reserved = false;
  let stale = false;
  for (const { task, paths } of records) {
    const sameBranch = task.branch?.repo === repo && task.branch.name === tree.branch;
    const related =
      sameBranch || paths.some((path) => samePath(path, tree.path)) || task.id === marker?.task_id;
    const lease = task.lease;
    if (
      lease &&
      !(Date.parse(lease.expiresAt) <= now) &&
      (related || (lease.repo === repo && !lease.worktree))
    ) {
      return "active";
    }
    if (!related) continue;
    if (
      task.status === "NEEDS_REVIEW" ||
      task.status === "REVISION_REQUESTED" ||
      (task.status === "BLOCKED" && task.handoff)
    )
      reserved = true;
    if (lease || task.status === "DONE") stale = true;
  }
  if (reserved) return "reserved";
  if (!marker) return "unmanaged";
  return stale ? "stale" : "orphaned";
}

async function isDirty(path: string, admin: string) {
  try {
    // Git may otherwise remove ignored or hidden files. Fail closed for sparse/assume-unchanged
    // indexes and operations that keep important state under the admin directory instead.
    const files = await git(path, "ls-files", "-v", "-z");
    if (/(?:^|\0)[a-zS] /.test(files)) return true;
    for (const name of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_START",
      "sequencer",
      "rebase-apply",
      "rebase-merge",
    ]) {
      if (
        await lstat(join(admin, name)).catch((error: unknown) => {
          if (isMissingFile(error)) return null;
          throw error;
        })
      )
        return true;
    }
    return (
      (await git(
        path,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
      )) !== ""
    );
  } catch {
    return null;
  }
}

async function describeTree(
  tree: GitWorktreeRegistration,
  primary: boolean,
  context: {
    current: string;
    common: string;
    records: Snapshot | null;
    config: WorktreeInventoryOptions["config"];
  },
): Promise<WorktreeEntry> {
  const path = await canonical(tree.path);
  tree = { ...tree, path };
  const current = contains(path, context.current);
  const entry: WorktreeEntry = {
    ...tree,
    primary,
    current,
    managed: false,
    status: "unavailable",
    dirty: null,
    eligible: false,
  };
  if (primary) return { ...entry, status: "primary" };
  if (tree.prunable) return entry;
  const admin = await linkedAdmin(path, context.common).catch(() => null);
  if (!admin) return entry;
  let marker = await readMarker(admin, path, tree.branch);
  if (
    marker &&
    (marker.project_id !== context.config.project_id || marker.repo !== context.config.repo_name)
  )
    marker = null;
  const status = leaseStatus(tree, marker, context.records, context.config.repo_name);
  const dirty = await isDirty(path, admin);
  return {
    ...entry,
    managed: marker !== null,
    status,
    dirty,
    eligible:
      !current && !tree.locked && dirty === false && (status === "stale" || status === "orphaned"),
  };
}

/** Read-only Git and SQLite inventory; never runs Git prune or migrates/creates SQLite state. */
export async function readWorktreeInventory(
  options: WorktreeInventoryOptions,
): Promise<WorktreeEntry[]> {
  const [trees, common, current, records] = await Promise.all([
    readGitWorktreeRegistrations(options.root),
    gitDir(options.root, "--git-common-dir"),
    realpath(options.cwd ?? process.cwd()),
    inspectStore(options).inspect((db) => snapshot(db, options)),
  ]);
  const entries: WorktreeEntry[] = [];
  for (const [index, tree] of trees.entries()) {
    entries.push(
      await describeTree(tree, index === 0, { common, current, records, config: options.config }),
    );
  }
  return entries;
}

export async function pruneWorktrees(options: WorktreeInventoryOptions, apply = false) {
  const worktrees = await readWorktreeInventory(options);
  const removed: string[] = [];
  const skipped: string[] = [];
  if (apply) {
    const store = inspectStore(options);
    for (const entry of worktrees.filter((tree) => tree.eligible)) {
      const result = await store.inspect(
        async (db) => {
          // Re-read leases and Git metadata under the same lock that claim and renew use.
          const [primary, ...linked] = await readGitWorktreeRegistrations(options.root);
          if (!primary || samePath(await canonical(primary.path), entry.path)) return false;
          const tree = linked.find((item) => samePath(item.path, entry.path));
          if (!tree || tree.branch !== entry.branch) return false;
          const refreshed = await describeTree(tree, false, {
            common: await gitDir(options.root, "--git-common-dir"),
            current: await realpath(options.cwd ?? process.cwd()),
            records: await snapshot(db, options),
            config: options.config,
          });
          if (!refreshed.eligible) return false;
          try {
            await git(options.root, "worktree", "remove", "--", entry.path);
            return true;
          } catch {
            return false; // Git may also refuse due to a concurrent change or submodules.
          }
        },
        { lock: true },
      );
      (result ? removed : skipped).push(entry.path);
    }
  }
  return { apply, worktrees, removed, skipped };
}
