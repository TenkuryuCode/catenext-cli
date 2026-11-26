import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { findCycle } from "@catenext/shared";
import { LocalServiceError } from "../errors.js";
import type { LocalProject } from "../local-state.js";
import { migrateJsonStateIfNeeded } from "./migrate.js";
import { openDatabaseAt } from "./open.js";
import { emptyExtendedProject, loadProject, saveProject } from "./project-codec.js";

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

async function lock(path: string): Promise<void> {
  const start = performance.now();
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (performance.now() - start >= 5000) {
        throw new LocalServiceError(
          "state_busy",
          `Catenext state is locked (${path}). If no CLI/MCP process is using this DB, remove the empty lock directory and retry.`,
        );
      }
      await delay(20 + Math.floor(Math.random() * 30));
    }
  }
}

async function assertRegularFileOrMissing(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new LocalServiceError(
        "invalid_state_file",
        "Use a regular state file, not a directory, symlink, or hardlink.",
      );
    }
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
}

/** One transaction per call: lock, hydrate project, mutate, persist to SQLite. */
export class LocalStore {
  constructor(private readonly file: string) {}

  async transaction<T>(
    projectId: string,
    repo: string,
    run: (project: LocalProject, dirty: () => void) => Promise<T> | T,
  ): Promise<T> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(await realpath(dir), basename(this.file));
    await assertRegularFileOrMissing(file);
    const lockPath = `${file}.lock`;
    await lock(lockPath);
    let db: DatabaseSync | undefined;
    try {
      try {
        db = openDatabaseAt(file);
      } catch (error) {
        throw new LocalServiceError(
          "corrupt_state",
          "Catenext SQLite state is corrupt or not a database. File was not modified; restore from backup.",
          error instanceof Error ? { cause: error.message } : undefined,
        );
      }
      await migrateJsonStateIfNeeded(db, file);
      const data = loadProject(db, projectId);
      if (!isConsistent(data) && (data.tasks.length > 0 || data.epics.length > 0)) {
        throw new LocalServiceError(
          "corrupt_state",
          "Catenext SQLite state failed consistency checks. Restore from backup.",
        );
      }
      // Ensure extended fields exist for older hydrated shapes.
      data.permissions ??= [];
      data.workspace_roots ??= [];
      data.session_prefs ??= {};
      data.platform_setup ??= [];

      let changed = false;
      if (!data.repos.includes(repo)) {
        data.repos.push(repo);
        changed = true;
      }
      const result = await run(data, () => {
        changed = true;
      });
      if (changed) {
        if (!isConsistent(data)) {
          throw new LocalServiceError(
            "corrupt_state",
            "Refusing to write inconsistent project state.",
          );
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          saveProject(db, projectId, data);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      return result;
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore close errors */
      }
      await rmdir(lockPath);
    }
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
