import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalServiceError } from "../errors.js";
import type { LocalTask } from "../local-state.js";
import { openDatabaseAt } from "./open.js";
import { loadDocument, loadTask, saveDocumentRow, saveTask } from "./project-codec.js";
import { LocalStore } from "./store.js";
import { insertTaskEvents } from "./task-events.js";

let dir: string;
let dbPath: string;
let projectId: string;

async function spawnExitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  if (!pid) throw new Error("Failed to obtain child PID");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return pid;
}

function makeTask(id: string, epicId: string, title: string, deps: string[] = []): LocalTask {
  return {
    id,
    epicId,
    title,
    instruction: `Instruction for ${title}`,
    status: "TODO",
    dependencies: deps,
    target: "catenext",
    role: "backend",
    persona: null,
    position: 0,
    requiresApproval: true,
    revision: 0,
    stale: false,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "catenext-store-"));
  dbPath = join(dir, "state.sqlite");
  projectId = randomUUID();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("openDatabaseAt WAL & readOnly mode", () => {
  it("enables WAL mode and 0o600 permissions for file databases", async () => {
    const db = openDatabaseAt(dbPath);
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(mode.journal_mode.toLowerCase()).toBe("wal");

      const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);

      db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
        projectId,
        "2026-01-01T00:00:00.000Z",
      );
    } finally {
      db.close();
    }

    if (process.platform !== "win32") {
      const dbStat = await stat(dbPath);
      expect(dbStat.mode & 0o777).toBe(0o600);
      if (existsSync(`${dbPath}-wal`)) {
        expect((await stat(`${dbPath}-wal`)).mode & 0o777).toBe(0o600);
      }
      if (existsSync(`${dbPath}-shm`)) {
        expect((await stat(`${dbPath}-shm`)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("opens an existing WAL database in readOnly mode and rejects mutations", () => {
    const rw = openDatabaseAt(dbPath);
    try {
      rw.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
        projectId,
        "2026-01-01T00:00:00.000Z",
      );
    } finally {
      rw.close();
    }

    const ro = openDatabaseAt(dbPath, { readOnly: true });
    try {
      const row = ro.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as
        | { id: string }
        | undefined;
      expect(row?.id).toBe(projectId);
      expect(() =>
        ro
          .prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)")
          .run(randomUUID(), "2026-01-01T00:00:00.000Z"),
      ).toThrow();
    } finally {
      ro.close();
    }
  });
});

describe("LocalStore lock metadata & stale lock recovery", () => {
  it("writes PID + startedAt JSON to .lock during transaction and removes it afterwards", async () => {
    const store = new LocalStore(dbPath);
    const lockPath = `${dbPath}.lock`;
    let capturedLock: string | null = null;

    await store.transaction(projectId, "catenext", async () => {
      capturedLock = await readFile(lockPath, "utf8");
    });

    expect(existsSync(lockPath)).toBe(false);
    expect(capturedLock).not.toBeNull();
    const parsed = JSON.parse(capturedLock ?? "{}") as { pid?: number; startedAt?: string };
    expect(parsed.pid).toBe(process.pid);
    expect(Number.isFinite(Date.parse(parsed.startedAt ?? ""))).toBe(true);
  });

  it("cleans up .lock when transaction callback throws", async () => {
    const store = new LocalStore(dbPath);
    const lockPath = `${dbPath}.lock`;

    await expect(
      store.transaction(projectId, "catenext", () => {
        throw new Error("callback failure");
      }),
    ).rejects.toThrow("callback failure");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers stale .lock owned by a dead PID even with fresh timestamp", async () => {
    const deadPid = await spawnExitedPid();
    const lockPath = `${dbPath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }),
    );

    const store = new LocalStore(dbPath, { lockTimeoutMs: 500, staleLockMs: 60_000 });
    await store.transaction(projectId, "catenext", (project, dirty) => {
      project.epics.push({ id: randomUUID(), title: "Recovered", description: null });
      dirty();
    });

    expect(existsSync(lockPath)).toBe(false);
    const epics = await store.read(projectId, (p) => p.epics);
    expect(epics.map((e) => e.title)).toEqual(["Recovered"]);
  });

  it("recovers expired .lock even when PID is alive", async () => {
    const lockPath = `${dbPath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(Date.now() - 10_000).toISOString(),
      }),
    );

    const store = new LocalStore(dbPath, { lockTimeoutMs: 500, staleLockMs: 50 });
    await store.transaction(projectId, "catenext", (project, dirty) => {
      project.epics.push({ id: randomUUID(), title: "ExpiredRecovered", description: null });
      dirty();
    });

    expect(existsSync(lockPath)).toBe(false);
    const epics = await store.read(projectId, (p) => p.epics);
    expect(epics.map((e) => e.title)).toEqual(["ExpiredRecovered"]);
  });

  it("recovers corrupt .lock files and stale legacy lock directories", async () => {
    const lockPath = `${dbPath}.lock`;
    await writeFile(lockPath, "{not-valid-json");
    const oldTime = new Date(Date.now() - 5000);
    await utimes(lockPath, oldTime, oldTime);

    const store = new LocalStore(dbPath, { lockTimeoutMs: 500, staleLockMs: 30_000 });
    await store.transaction(projectId, "catenext", () => {});
    expect(existsSync(lockPath)).toBe(false);

    const dirOldTime = new Date(Date.now() - 60_000);
    await mkdir(lockPath);
    await utimes(lockPath, dirOldTime, dirOldTime);
    await store.transaction(projectId, "catenext", () => {});
    expect(existsSync(lockPath)).toBe(false);
  });

  it("respects an active live-PID lock within staleLockMs and throws state_busy", async () => {
    const lockPath = `${dbPath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const store = new LocalStore(dbPath, { lockTimeoutMs: 120, staleLockMs: 30_000 });
    await expect(store.transaction(projectId, "catenext", () => {})).rejects.toMatchObject({
      code: "state_busy",
    });
    expect(existsSync(lockPath)).toBe(true);
  });

  it("rejects symlink .lock and hardlinked DB files", async () => {
    const target = join(dir, "other.txt");
    await writeFile(target, "x");
    const lockPath = `${dbPath}.lock`;
    const store = new LocalStore(dbPath, { lockTimeoutMs: 200, staleLockMs: 50 });

    let symlinkCreated = false;
    try {
      await symlink(target, lockPath);
      symlinkCreated = true;
    } catch (error) {
      if (
        !(
          process.platform === "win32" &&
          error instanceof Error &&
          "code" in error &&
          error.code === "EPERM"
        )
      ) {
        throw error;
      }
    }
    if (symlinkCreated) {
      await expect(store.transaction(projectId, "catenext", () => {})).rejects.toMatchObject({
        code: "invalid_state_file",
      });
      await rm(lockPath, { force: true });
    }

    const db = openDatabaseAt(dbPath);
    db.close();
    const hardlink = join(dir, "state-link.sqlite");
    await link(dbPath, hardlink);
    await expect(store.transaction(projectId, "catenext", () => {})).rejects.toMatchObject({
      code: "invalid_state_file",
    });
  });
});

describe("LocalStore read-only queries & partial diff persistence", () => {
  it("reads missing state without creating files or .lock", async () => {
    const missingPath = join(dir, "nonexistent", "state.sqlite");
    const store = new LocalStore(missingPath);
    const result = await store.read(projectId, (p) => p);
    expect(result.repos).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(existsSync(missingPath)).toBe(false);
    expect(existsSync(`${missingPath}.lock`)).toBe(false);
    expect(existsSync(join(dir, "nonexistent"))).toBe(false);
  });

  it("executes read() and query() without acquiring .lock or rewriting tables", async () => {
    const store = new LocalStore(dbPath);
    const epicId = randomUUID();
    const taskId = randomUUID();
    await store.transaction(projectId, "catenext", (project, dirty) => {
      project.epics.push({ id: epicId, title: "Epic 1", description: null });
      project.tasks.push(makeTask(taskId, epicId, "Task 1"));
      dirty();
    });

    // Place a live lock owned by current PID; read() & query() must still succeed without lock contention.
    const lockPath = `${dbPath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const readResult = await store.read(projectId, (project, db) => {
      expect(() => db.exec("CREATE TABLE fail_ro (x INTEGER)")).toThrow();
      return project.tasks.map((t) => t.title);
    });
    expect(readResult).toEqual(["Task 1"]);

    const queryResult = await store.query((db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?")
        .get(projectId) as { n: number };
      return row.n;
    });
    expect(queryResult).toBe(1);
    await rm(lockPath, { force: true });
  });

  it("throws corrupt_state on corrupt DB file during read() without modifying bytes", async () => {
    await writeFile(dbPath, "not a sqlite database");
    const store = new LocalStore(dbPath);
    await expect(store.read(projectId, (p) => p)).rejects.toMatchObject({ code: "corrupt_state" });
    expect(await readFile(dbPath, "utf8")).toBe("not a sqlite database");
  });

  it("throws unsupported_schema on newer DB version during read()", async () => {
    const db = openDatabaseAt(dbPath);
    db.exec("PRAGMA user_version = 99");
    db.close();

    const store = new LocalStore(dbPath);
    await expect(store.read(projectId, (p) => p)).rejects.toMatchObject({
      code: "unsupported_schema",
    });
  });

  it("persists partial row diffs without rewriting untouched tasks, documents, or tables", async () => {
    const store = new LocalStore(dbPath);
    const epicId = randomUUID();
    const t1 = randomUUID();
    const t2 = randomUUID();
    const t3 = randomUUID();
    const rootId = randomUUID();

    await store.transaction(projectId, "catenext", (project, dirty) => {
      project.epics.push({ id: epicId, title: "Core", description: "Main" });
      project.personas.push({
        alias: "be",
        role: "backend",
        rules: ["Rule A"],
        repos: ["catenext"],
      });
      project.documents.push({
        slug: "blueprint",
        title: "Blueprint",
        kind: "blueprint",
        version: 1,
        updated_by: "be",
        updated_at: "2026-01-01T00:00:00.000Z",
        size: 5,
        content: "hello",
      });
      project.tasks.push(
        makeTask(t1, epicId, "Untouched task"),
        makeTask(t2, epicId, "Target task", [t1]),
        makeTask(t3, epicId, "To remove"),
      );
      project.permissions?.push({ action: "approve_plan", principal: "human" });
      project.workspace_roots?.push({
        id: rootId,
        path: "/tmp/ext",
        ownerPersona: "be",
        label: "ext",
      });
      project.platform_setup?.push("codex");
      project.session_prefs = { locale: "en" };
      dirty();
    });

    // Record initial rowids and install triggers that fail if untouched rows/tables are deleted or updated.
    let initialT1RowId = 0;
    let initialDocRowId = 0;
    const rawDb = openDatabaseAt(dbPath);
    try {
      initialT1RowId = (
        rawDb
          .prepare("SELECT rowid FROM tasks WHERE project_id = ? AND id = ?")
          .get(projectId, t1) as { rowid: number }
      ).rowid;
      initialDocRowId = (
        rawDb
          .prepare("SELECT rowid FROM documents WHERE project_id = ? AND slug = 'blueprint'")
          .get(projectId) as { rowid: number }
      ).rowid;

      rawDb.exec(`
        CREATE TEMP TRIGGER guard_doc_del BEFORE DELETE ON documents
        BEGIN SELECT RAISE(ABORT, 'documents must not be deleted'); END;
      `);
      rawDb.exec(`
        CREATE TRIGGER guard_untouched_task_upd BEFORE UPDATE ON tasks
        WHEN OLD.id = '${t1}'
        BEGIN SELECT RAISE(ABORT, 'untouched task must not be updated'); END;
        CREATE TRIGGER guard_untouched_task_del BEFORE DELETE ON tasks
        WHEN OLD.id = '${t1}'
        BEGIN SELECT RAISE(ABORT, 'untouched task must not be deleted'); END;
        CREATE TRIGGER guard_untouched_epic_del BEFORE DELETE ON epics
        BEGIN SELECT RAISE(ABORT, 'epics must not be deleted'); END;
        CREATE TRIGGER guard_untouched_persona_del BEFORE DELETE ON personas
        BEGIN SELECT RAISE(ABORT, 'personas must not be deleted'); END;
        CREATE TRIGGER guard_untouched_doc_del BEFORE DELETE ON documents
        BEGIN SELECT RAISE(ABORT, 'documents must not be deleted'); END;
        CREATE TRIGGER guard_untouched_perm_del BEFORE DELETE ON permissions
        BEGIN SELECT RAISE(ABORT, 'permissions must not be deleted'); END;
        CREATE TRIGGER guard_untouched_root_del BEFORE DELETE ON workspace_roots
        BEGIN SELECT RAISE(ABORT, 'workspace_roots must not be deleted'); END;
      `);
    } finally {
      rawDb.close();
    }

    // Mutate only t2, remove t3, update locale & platform_setup; triggers prove untouched entities aren't rewritten.
    await store.transaction(projectId, "catenext", (project, dirty) => {
      const target = project.tasks.find((t) => t.id === t2);
      if (!target) throw new Error("missing t2");
      target.status = "NEEDS_REVIEW";
      target.handoff = {
        files_modified: ["apps/cli/src/db/store.ts"],
        key_decisions: ["Partial diff"],
        verification_command: "pnpm test",
        notes_for_next_agent: "Ready",
        git_branch: "feat/e2-store-wal",
        last_commit_hash: "abcdef1",
      };
      target.dependencies = [];
      project.tasks = project.tasks.filter((t) => t.id !== t3);
      project.session_prefs = { locale: "id" };
      project.platform_setup = ["codex", "cursor"];
      dirty();
    });

    const verifyDb = openDatabaseAt(dbPath);
    try {
      // Drop guard triggers before cleanups/subsequent writes
      for (const name of [
        "guard_untouched_task_upd",
        "guard_untouched_task_del",
        "guard_untouched_epic_del",
        "guard_untouched_persona_del",
        "guard_untouched_doc_del",
        "guard_untouched_perm_del",
        "guard_untouched_root_del",
      ]) {
        verifyDb.exec(`DROP TRIGGER IF EXISTS ${name}`);
      }

      const afterT1RowId = (
        verifyDb
          .prepare("SELECT rowid FROM tasks WHERE project_id = ? AND id = ?")
          .get(projectId, t1) as { rowid: number }
      ).rowid;
      const afterDocRowId = (
        verifyDb
          .prepare("SELECT rowid FROM documents WHERE project_id = ? AND slug = 'blueprint'")
          .get(projectId) as { rowid: number }
      ).rowid;
      expect(afterT1RowId).toBe(initialT1RowId);
      expect(afterDocRowId).toBe(initialDocRowId);

      // Single-entity helpers loadTask / saveTask / loadDocument / saveDocumentRow
      const loadedT2 = loadTask(verifyDb, projectId, t2);
      expect(loadedT2?.status).toBe("NEEDS_REVIEW");
      expect(loadedT2?.dependencies).toEqual([]);
      expect(loadTask(verifyDb, projectId, t3)).toBeUndefined();

      if (!loadedT2) throw new Error("Expected loadedT2");
      loadedT2.dependencies = [t1];
      loadedT2.title = "Updated via saveTask";
      saveTask(verifyDb, projectId, loadedT2);
      expect(loadTask(verifyDb, projectId, t2)).toMatchObject({
        title: "Updated via saveTask",
        dependencies: [t1],
      });

      const doc = loadDocument(verifyDb, projectId, "blueprint");
      expect(doc?.content).toBe("hello");
      if (!doc) throw new Error("Expected doc");
      saveDocumentRow(verifyDb, projectId, {
        ...doc,
        version: 2,
        content: "updated",
        size: 7,
      });
      expect(loadDocument(verifyDb, projectId, "blueprint")).toMatchObject({
        version: 2,
        content: "updated",
        size: 7,
      });
    } finally {
      verifyDb.close();
    }

    const finalProject = await store.read(projectId, (p) => p);
    expect(finalProject.tasks.map((t) => t.id)).toEqual([t1, t2]);
    expect(finalProject.session_prefs).toEqual({ locale: "id" });
    expect(finalProject.platform_setup?.sort()).toEqual(["codex", "cursor"]);
  });

  it("combines audit filters before limiting and keeps project isolation", async () => {
    const db = openDatabaseAt(dbPath);
    const taskId = randomUUID();
    const otherProject = randomUUID();
    const cutoff = "2026-01-02T00:00:00.000Z";
    const matching = { task_id: taskId, event: "approve", actor: "human", created_at: cutoff };
    try {
      const addProject = db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)");
      addProject.run(projectId, cutoff);
      addProject.run(otherProject, cutoff);
      insertTaskEvents(db, projectId, [
        { ...matching, created_at: "2026-01-01T23:59:59.999Z", note: "too old" },
        { ...matching, note: "first" },
        { ...matching, note: "last" },
        { ...matching, actor: "agent" },
        { ...matching, event: "approve_plan" },
        { ...matching, task_id: randomUUID() },
      ]);
      insertTaskEvents(db, otherProject, [{ ...matching, note: "other project" }]);
    } finally {
      db.close();
    }
    const store = new LocalStore(dbPath);
    const filters = { taskId, event: "approve", actor: "human", since: cutoff };
    expect((await store.readTaskEvents(projectId, filters)).map((row) => row.note)).toEqual([
      "last",
      "first",
    ]);
    expect(await store.readTaskEvents(projectId, { ...filters, limit: 1 })).toMatchObject([
      { task_id: taskId, task_title: null, note: "last" },
    ]);
    expect(await store.readTaskEvents(projectId, { event: "missing" })).toEqual([]);
  });

  it("handles LocalServiceError cleanly when DB path is invalid", () => {
    expect(() => new DatabaseSync(":memory:")).not.toThrow();
    expect(new LocalServiceError("state_busy", "busy").code).toBe("state_busy");
  });
});
