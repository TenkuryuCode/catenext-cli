import { randomUUID } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { findCycle } from "@catenext/shared";
import { LocalServiceError } from "../errors.js";
import type { LocalProject } from "../local-state.js";
import {
  dbHasProjects,
  getSchemaVersion,
  legacyStateJsonPath,
  migrateJsonStateIfNeeded,
} from "./migrate.js";
import { ensureDatabasePermissions, openDatabaseAt } from "./open.js";
import {
  emptyExtendedProject,
  loadProject,
  loadProjectState,
  saveProjectDiff,
} from "./project-codec.js";
import { SCHEMA_VERSION } from "./schema.js";
import {
  queryTaskEvents,
  type ReadTaskEventsOptions,
  type TaskEventRecord,
} from "./task-events.js";

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const CORRUPT_LOCK_GRACE_MS = 500;

export interface LockMetadata {
  pid: number;
  startedAt: string;
}

export interface LocalStoreOptions {
  /** Max time to wait for an active lock before throwing `state_busy`. Default: 5000 ms. */
  lockTimeoutMs?: number;
  /** Age after which a lock file is considered stale even if PID is alive. Default: 30000 ms. */
  staleLockMs?: number;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function unique<T>(items: T[]): boolean {
  return new Set(items).size === items.length;
}

/** Validate cross-record invariants; malformed DB rows must never be treated as empty. */
export function isConsistent(project: LocalProject): boolean {
  const epicIds = new Set(project.epics.map((epic) => epic.id));
  const aliases = new Set(project.personas.map((persona) => persona.alias));
  const taskIds = new Set(project.tasks.map((task) => task.id));
  const reservedBranches = new Set<string>();
  const activeSessions = new Set<string>();
  const activeRepos = new Map<string, boolean>();
  const leaseIds = project.tasks.flatMap((task) => (task.lease ? [task.lease.id] : []));
  if (
    epicIds.size !== project.epics.length ||
    aliases.size !== project.personas.length ||
    taskIds.size !== project.tasks.length ||
    !unique(leaseIds) ||
    !unique(project.documents.map((doc) => doc.slug))
  )
    return false;
  for (const task of project.tasks) {
    const { branch, lease } = task;
    if (
      !epicIds.has(task.epicId) ||
      (task.persona && !aliases.has(task.persona)) ||
      !unique(task.dependencies) ||
      task.dependencies.some((id) => !taskIds.has(id)) ||
      (task.status === "IN_PROGRESS") !== Boolean(lease) ||
      (task.status === "BLOCKED") !== Boolean(task.blocker) ||
      ((task.status === "DONE" || task.status === "NEEDS_REVIEW") && !task.handoff) ||
      (task.status === "REVISION_REQUESTED" && (!task.handoff || !task.feedback)) ||
      (task.review && task.review.approvedLocally !== (task.status === "DONE")) ||
      Boolean(task.handoff?.pull_request) !== Boolean(task.review)
    )
      return false;
    if (branch) {
      const key = `${branch.repo}:${branch.name}`;
      if (reservedBranches.has(key) || (lease && (!lease.worktree || lease.repo !== branch.repo)))
        return false;
      reservedBranches.add(key);
    }
    if (lease) {
      if (lease.worktree) {
        if (!branch || activeSessions.has(lease.worktree.session)) return false;
        activeSessions.add(lease.worktree.session);
      }
      const existing = activeRepos.get(lease.repo);
      if (existing === false || (existing !== undefined && !lease.worktree)) return false;
      activeRepos.set(lease.repo, Boolean(lease.worktree));
    }
  }
  return !findCycle(
    project.tasks.flatMap((task) =>
      task.dependencies.map((dependsOn) => ({ task: task.id, dependsOn })),
    ),
  );
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function parseLockMetadata(raw: string): LockMetadata | null {
  try {
    const val = JSON.parse(raw) as unknown;
    if (!val || typeof val !== "object" || Array.isArray(val)) return null;
    const candidate = val as { pid?: unknown; startedAt?: unknown };
    if (
      typeof candidate.pid === "number" &&
      Number.isInteger(candidate.pid) &&
      candidate.pid > 0 &&
      typeof candidate.startedAt === "string" &&
      candidate.startedAt.length > 0
    ) {
      return { pid: candidate.pid, startedAt: candidate.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function isLockContentStale(raw: string, fileMtimeMs: number, staleLockMs: number): boolean {
  const now = Date.now();
  const parsed = parseLockMetadata(raw);
  if (!parsed) {
    return now - fileMtimeMs >= Math.min(staleLockMs, CORRUPT_LOCK_GRACE_MS);
  }
  if (!isPidAlive(parsed.pid)) return true;
  const startedMs = Date.parse(parsed.startedAt);
  const ageMs = Number.isFinite(startedMs) ? now - startedMs : now - fileMtimeMs;
  return ageMs >= staleLockMs;
}

async function tryCreateLockFile(lockPath: string, payload: string): Promise<boolean> {
  const tmpPath = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(tmpPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await link(tmpPath, lockPath);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    if (hasCode(error, "EXDEV") || hasCode(error, "EPERM") || hasCode(error, "ENOTSUP")) {
      try {
        await writeFile(lockPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return true;
      } catch (writeErr) {
        if (hasCode(writeErr, "EEXIST")) return false;
        throw writeErr;
      }
    }
    throw error;
  } finally {
    await rm(tmpPath, { force: true });
  }
}

async function tryRecoverStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
  let st: Stats;
  try {
    st = await lstat(lockPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }

  if (st.isSymbolicLink()) {
    throw new LocalServiceError("invalid_state_file", "Use a regular lock file, not a symlink.");
  }

  if (st.isDirectory()) {
    if (Date.now() - st.mtimeMs < staleLockMs) return false;
    try {
      await rmdir(lockPath);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return true;
      if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) return false;
      throw error;
    }
  }

  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }

  if (!isLockContentStale(raw, st.mtimeMs, staleLockMs)) return false;

  const reapPath = `${lockPath}.reap.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, reapPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }

  try {
    const reapedRaw = await readFile(reapPath, "utf8");
    const reapedStat = await lstat(reapPath);
    if (isLockContentStale(reapedRaw, reapedStat.mtimeMs, staleLockMs)) {
      await rm(reapPath, { force: true });
      return true;
    }
    // Another process replaced the stale lock with a live one right before rename: restore it.
    try {
      await link(reapPath, lockPath);
    } catch {
      /* ignore if another process already recreated lockPath */
    }
    await rm(reapPath, { force: true });
    return false;
  } catch (error) {
    await rm(reapPath, { force: true });
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
}

async function acquireLock(
  lockPath: string,
  lockTimeoutMs: number,
  staleLockMs: number,
): Promise<LockMetadata> {
  const start = performance.now();
  while (true) {
    const meta: LockMetadata = { pid: process.pid, startedAt: new Date().toISOString() };
    const created = await tryCreateLockFile(lockPath, JSON.stringify(meta));
    if (created) return meta;

    const recovered = await tryRecoverStaleLock(lockPath, staleLockMs);
    if (recovered) continue;

    if (performance.now() - start >= lockTimeoutMs) {
      throw new LocalServiceError(
        "state_busy",
        `Catenext state is locked (${lockPath}). If no CLI/MCP process is using this DB, remove the lock file and retry.`,
      );
    }
    await delay(20 + Math.floor(Math.random() * 30));
  }
}

async function releaseLock(lockPath: string, owner: LockMetadata): Promise<void> {
  try {
    const current = await readFile(lockPath, "utf8");
    const parsed = parseLockMetadata(current);
    if (!parsed || parsed.pid !== owner.pid || parsed.startedAt !== owner.startedAt) {
      return;
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    return;
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function assertRegularFileOrMissing(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new LocalServiceError(
        "invalid_state_file",
        "Use a regular state file, not a directory, symlink, or hardlink.",
      );
    }
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function wrapOpenError(error: unknown): never {
  if (error instanceof LocalServiceError) throw error;
  throw new LocalServiceError(
    "corrupt_state",
    "Catenext SQLite state is corrupt or not a database. File was not modified; restore from backup.",
    error instanceof Error ? { cause: error.message } : undefined,
  );
}

/** SQLite-backed project store with WAL, PID+timestamp lock recovery, and partial diff writes. */
export class LocalStore {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(
    private readonly file: string,
    options: LocalStoreOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  /**
   * Execute a read-only query against SQLite without acquiring `.lock` or rewriting tables.
   * Falls back to a locked migration pass only if an older v1 DB or legacy `state.json` needs upgrade.
   */
  async query<T>(run: (db: DatabaseSync) => Promise<T> | T): Promise<T> {
    const dir = dirname(this.file);
    if (!existsSync(dir)) {
      const mem = openDatabaseAt(":memory:");
      try {
        return await run(mem);
      } finally {
        mem.close();
      }
    }
    const file = join(await realpath(dir), basename(this.file));
    const exists = await assertRegularFileOrMissing(file);
    if (!exists) {
      if (existsSync(legacyStateJsonPath(file))) {
        return await this.withWriteLock(file, async (db) => await run(db));
      }
      const mem = openDatabaseAt(":memory:");
      try {
        return await run(mem);
      } finally {
        mem.close();
      }
    }

    let db: DatabaseSync | undefined;
    let needsUpgrade = false;
    try {
      try {
        db = openDatabaseAt(file, { readOnly: true });
        const version = getSchemaVersion(db);
        if (version > SCHEMA_VERSION) {
          throw new LocalServiceError(
            "unsupported_schema",
            `Catenext SQLite schema version ${version} is newer than supported version ${SCHEMA_VERSION}. Upgrade Catenext CLI.`,
          );
        }
        if (
          version < SCHEMA_VERSION ||
          (!dbHasProjects(db) && existsSync(legacyStateJsonPath(file)))
        ) {
          needsUpgrade = true;
        }
      } catch (error) {
        wrapOpenError(error);
      }
      if (!needsUpgrade) {
        return await run(db);
      }
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore close errors */
      }
    }

    if (needsUpgrade) {
      return await this.withWriteLock(file, async (rwDb) => await run(rwDb));
    }
    throw new LocalServiceError("corrupt_state", "Failed to read SQLite state.");
  }

  /**
   * Read a project's state without acquiring `.lock` or performing any writes.
   */
  async read<T>(
    projectId: string,
    run: (project: LocalProject, db: DatabaseSync) => Promise<T> | T,
  ): Promise<T> {
    return await this.query(async (db) => {
      const project = loadProject(db, projectId);
      if (!isConsistent(project) && (project.tasks.length > 0 || project.epics.length > 0)) {
        throw new LocalServiceError(
          "corrupt_state",
          "Catenext SQLite state failed consistency checks. Restore from backup.",
        );
      }
      ensureProjectSeedDefaults(project);
      return await run(project, db);
    });
  }

  /**
   * Read task audit log entries without acquiring `.lock` or modifying state.
   */
  async readTaskEvents(
    projectId: string,
    options: ReadTaskEventsOptions = {},
  ): Promise<TaskEventRecord[]> {
    return await this.query((db) => queryTaskEvents(db, projectId, options));
  }

  private async withWriteLock<T>(
    file: string,
    run: (db: DatabaseSync) => Promise<T> | T,
  ): Promise<T> {
    const lockPath = `${file}.lock`;
    const owner = await acquireLock(lockPath, this.lockTimeoutMs, this.staleLockMs);
    let db: DatabaseSync | undefined;
    try {
      try {
        db = openDatabaseAt(file);
      } catch (error) {
        wrapOpenError(error);
      }
      await migrateJsonStateIfNeeded(db, file);
      return await run(db);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore close errors */
      }
      await releaseLock(lockPath, owner);
    }
  }

  async transaction<T>(
    projectId: string,
    repo: string,
    run: (
      project: LocalProject,
      dirty: () => void,
      db: DatabaseSync,
      afterSave: (hook: (db: DatabaseSync) => void) => void,
    ) => Promise<T> | T,
  ): Promise<T> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(await realpath(dir), basename(this.file));
    await assertRegularFileOrMissing(file);
    return await this.withWriteLock(file, async (db) => {
      const { exists, project: data } = loadProjectState(db, projectId);
      if (!isConsistent(data) && (data.tasks.length > 0 || data.epics.length > 0)) {
        throw new LocalServiceError(
          "corrupt_state",
          "Catenext SQLite state failed consistency checks. Restore from backup.",
        );
      }
      ensureProjectSeedDefaults(data);
      const before = structuredClone(data);

      let changed = false;
      if (!data.repos.includes(repo)) {
        data.repos.push(repo);
        changed = true;
      }
      const hooks: Array<(db: DatabaseSync) => void> = [];
      const result = await run(
        data,
        () => {
          changed = true;
        },
        db,
        (hook) => {
          hooks.push(hook);
        },
      );
      if (changed || hooks.length > 0) {
        if (changed && !isConsistent(data)) {
          throw new LocalServiceError(
            "corrupt_state",
            "Refusing to write inconsistent project state.",
          );
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          if (changed) {
            saveProjectDiff(db, projectId, before, data, exists);
          } else if (!exists) {
            db.prepare(
              "INSERT INTO projects (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
            ).run(projectId, new Date().toISOString());
          }
          for (const hook of hooks) {
            hook(db);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        ensureDatabasePermissions(file);
      }
      return result;
    });
  }
}

export function ensureProjectSeedDefaults(project: LocalProject): void {
  project.permissions ??= [];
  project.workspace_roots ??= [];
  project.session_prefs ??= {};
  project.platform_setup ??= [];
}

export function newRootId(): string {
  return randomUUID();
}

export { emptyExtendedProject };
