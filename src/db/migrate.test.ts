import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalServiceError } from "../errors.js";
import {
  getSchemaVersion,
  legacyStateJsonPath,
  migrateJsonStateIfNeeded,
  runSchemaMigrations,
  SCHEMA_MIGRATIONS,
  setSchemaVersion,
} from "./migrate.js";
import { openDatabaseAt } from "./open.js";
import { loadProject } from "./project-codec.js";
import { SCHEMA_VERSION } from "./schema.js";

const V1_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE project_repos (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  PRIMARY KEY (project_id, repo)
);

CREATE TABLE epics (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE personas (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  role TEXT NOT NULL,
  rules_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (project_id, alias)
);

CREATE TABLE persona_repos (
  project_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  repo TEXT NOT NULL,
  PRIMARY KEY (project_id, alias, repo),
  FOREIGN KEY (project_id, alias) REFERENCES personas(project_id, alias) ON DELETE CASCADE
);

CREATE TABLE documents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  size INTEGER NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (project_id, slug)
);

CREATE TABLE tasks (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  target TEXT,
  role TEXT,
  persona TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  feedback TEXT,
  lease_json TEXT,
  branch_json TEXT,
  handoff_json TEXT,
  review_json TEXT,
  blocker_json TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE task_deps (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (project_id, task_id, depends_on),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

CREATE TABLE permissions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  principal TEXT NOT NULL,
  PRIMARY KEY (project_id, action, principal)
);

CREATE TABLE workspace_roots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  owner_persona TEXT,
  label TEXT,
  UNIQUE (project_id, path)
);

CREATE TABLE platform_setup (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, platform)
);

CREATE TABLE session_prefs (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  locale TEXT
);
`;

function createV1Database(
  file: string,
  options: { withMetaVersion?: boolean } = {},
): {
  projectId: string;
  epicId: string;
  taskId: string;
} {
  const projectId = randomUUID();
  const epicId = randomUUID();
  const taskId = randomUUID();
  const db = new DatabaseSync(file);
  try {
    db.exec(V1_SCHEMA_SQL);
    if (options.withMetaVersion !== false) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    }
    db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
      projectId,
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO project_repos (project_id, repo) VALUES (?, ?)").run(
      projectId,
      "catenext",
    );
    db.prepare("INSERT INTO epics (id, project_id, title, description) VALUES (?, ?, ?, ?)").run(
      epicId,
      projectId,
      "V1 Epic",
      "Existing epic",
    );
    db.prepare(
      `INSERT INTO tasks
        (id, project_id, epic_id, title, instruction, status, target, role, persona, requires_approval, revision, stale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      projectId,
      epicId,
      "Legacy task",
      "Preserve me across migration",
      "TODO",
      "catenext",
      "backend",
      null,
      1,
      0,
      0,
    );
  } finally {
    db.close();
  }
  return { projectId, epicId, taskId };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "catenext-migrate-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SQLite schema migrations", () => {
  it("initializes an empty database to SCHEMA_VERSION and records both meta and user_version", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(getSchemaVersion(db)).toBe(0);
      const first = runSchemaMigrations(db);
      expect(first).toEqual({ fromVersion: 0, toVersion: SCHEMA_VERSION, applied: [] });
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(metaRow.value).toBe(String(SCHEMA_VERSION));
      expect(userVersion.user_version).toBe(SCHEMA_VERSION);

      const second = runSchemaMigrations(db);
      expect(second).toEqual({
        fromVersion: SCHEMA_VERSION,
        toVersion: SCHEMA_VERSION,
        applied: [],
      });
    } finally {
      db.close();
    }
  });

  it("migrates an existing v1 database to SCHEMA_VERSION idempotently while preserving rows", () => {
    const dbPath = join(dir, "v1.sqlite");
    const { projectId, epicId, taskId } = createV1Database(dbPath);

    const db = new DatabaseSync(dbPath);
    try {
      expect(getSchemaVersion(db)).toBe(1);
      const colsBefore = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      expect(colsBefore.some((c) => c.name === "integrated_commit_json")).toBe(false);

      const result1 = runSchemaMigrations(db);
      expect(result1).toEqual({ fromVersion: 1, toVersion: SCHEMA_VERSION, applied: [2, 3, 4, 5] });

      const colsAfter = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      expect(colsAfter.some((c) => c.name === "integrated_commit_json")).toBe(true);

      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(["files", "symbols", "edges", "task_events"]));

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(indexes).toContain("idx_task_events_project_task_created");

      const project = loadProject(db, projectId);
      expect(project.repos).toEqual(["catenext"]);
      expect(project.epics).toEqual([
        { id: epicId, title: "V1 Epic", description: "Existing epic" },
      ]);
      expect(project.tasks).toHaveLength(1);
      expect(project.tasks[0]?.id).toBe(taskId);
      expect(project.tasks[0]?.title).toBe("Legacy task");

      const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(metaRow.value).toBe(String(SCHEMA_VERSION));
      expect(userVersion.user_version).toBe(SCHEMA_VERSION);

      // Re-running migration on already-current DB is a no-op
      const result2 = runSchemaMigrations(db);
      expect(result2).toEqual({
        fromVersion: SCHEMA_VERSION,
        toVersion: SCHEMA_VERSION,
        applied: [],
      });
    } finally {
      db.close();
    }
  });

  it("migrates an existing v2 database without task_events to v3 idempotently", () => {
    const dbPath = join(dir, "v2.sqlite");
    const { projectId, taskId } = createV1Database(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      runSchemaMigrations(db, { targetVersion: 2 });
      db.exec("DROP TABLE IF EXISTS task_events");
      expect(getSchemaVersion(db)).toBe(2);

      const res = runSchemaMigrations(db, { targetVersion: 3 });
      expect(res).toEqual({ fromVersion: 2, toVersion: 3, applied: [3] });
      expect(getSchemaVersion(db)).toBe(3);

      const eventCols = (
        db.prepare("PRAGMA table_info(task_events)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(eventCols).toEqual([
        "id",
        "project_id",
        "task_id",
        "event",
        "actor",
        "note",
        "detail_json",
        "created_at",
      ]);
      expect(db.prepare("SELECT id FROM tasks WHERE project_id = ?").get(projectId)?.id).toBe(
        taskId,
      );
      expect(runSchemaMigrations(db, { targetVersion: 3 })).toEqual({
        fromVersion: 3,
        toVersion: 3,
        applied: [],
      });
    } finally {
      db.close();
    }
  });

  it("gives existing v3 tasks project-local positions without changing row order", () => {
    const dbPath = join(dir, "positions-v3.sqlite");
    const first = createV1Database(dbPath);
    const next = [randomUUID(), randomUUID()];
    const otherProject = randomUUID();
    const db = new DatabaseSync(dbPath);
    try {
      runSchemaMigrations(db, { targetVersion: 3 });
      const insertTask = db.prepare(`INSERT INTO tasks
        (id, project_id, epic_id, title, instruction, status) VALUES (?, ?, ?, ?, ?, 'TODO')`);
      db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
        otherProject,
        new Date().toISOString(),
      );
      insertTask.run(next[0] ?? "", first.projectId, first.epicId, "Z", "Synthetic");
      insertTask.run(first.taskId, otherProject, randomUUID(), "Other", "Synthetic");
      insertTask.run(next[1] ?? "", first.projectId, first.epicId, "A", "Synthetic");
      expect(
        db
          .prepare("PRAGMA table_info(tasks)")
          .all()
          .some(({ name }) => name === "position"),
      ).toBe(false);
      expect(runSchemaMigrations(db, { targetVersion: 4 })).toEqual({
        fromVersion: 3,
        toVersion: 4,
        applied: [4],
      });
      const tasks = loadProject(db, first.projectId).tasks;
      expect(tasks.map(({ id, position }) => [id, position])).toEqual(
        [first.taskId, ...next].map((id, position) => [id, position]),
      );
      expect(loadProject(db, otherProject).tasks[0]?.position).toBe(0);
      expect(runSchemaMigrations(db, { targetVersion: 4 }).applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("adds documents.archived_at on v5 migration and leaves existing rows NULL", () => {
    const dbPath = join(dir, "docs-v4.sqlite");
    const { projectId } = createV1Database(dbPath);
    const db = new DatabaseSync(dbPath);
    const stamp = "2026-01-15T12:00:00.000Z";
    try {
      runSchemaMigrations(db, { targetVersion: 4 });
      db.prepare(
        `INSERT INTO documents
          (project_id, slug, title, kind, version, updated_by, updated_at, size, content)
         VALUES (?, 'blueprint', 'Blueprint', 'blueprint', 1, 'be', ?, 8, 'body')`,
      ).run(projectId, stamp);
      expect(
        db
          .prepare("PRAGMA table_info(documents)")
          .all()
          .some(({ name }) => name === "archived_at"),
      ).toBe(false);

      expect(runSchemaMigrations(db)).toEqual({ fromVersion: 4, toVersion: 5, applied: [5] });
      const docCols = (
        db.prepare("PRAGMA table_info(documents)").all() as { name: string; dflt_value: unknown }[]
      ).find((c) => c.name === "archived_at");
      expect(docCols?.name).toBe("archived_at");

      const row = db
        .prepare("SELECT archived_at FROM documents WHERE project_id = ? AND slug = 'blueprint'")
        .get(projectId) as { archived_at: string | null };
      expect(row.archived_at).toBeNull();
      expect(loadProject(db, projectId).documents[0]?.archived_at ?? null).toBeNull();
      expect(runSchemaMigrations(db).applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("infers version 1 when tables exist without meta.schema_version or user_version and migrates via openDatabaseAt", () => {
    const dbPath = join(dir, "legacy-no-meta.sqlite");
    const { projectId, taskId } = createV1Database(dbPath, { withMetaVersion: false });

    const db = openDatabaseAt(dbPath);
    try {
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(mode.journal_mode.toLowerCase()).toBe("wal");

      const project = loadProject(db, projectId);
      expect(project.tasks.map((t) => t.id)).toEqual([taskId]);
    } finally {
      db.close();
    }
  });

  it("syncs lagging meta or user_version when already at targetVersion", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runSchemaMigrations(db);
      db.exec("PRAGMA user_version = 0");
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

      const res = runSchemaMigrations(db);
      expect(res).toEqual({ fromVersion: SCHEMA_VERSION, toVersion: SCHEMA_VERSION, applied: [] });
      const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(userVersion.user_version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("rejects databases with a newer schema version than supported", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runSchemaMigrations(db);
      setSchemaVersion(db, 99);
      expect(() => runSchemaMigrations(db)).toThrowError(LocalServiceError);
      try {
        runSchemaMigrations(db);
      } catch (err) {
        expect(err).toBeInstanceOf(LocalServiceError);
        expect((err as LocalServiceError).code).toBe("unsupported_schema");
      }
    } finally {
      db.close();
    }
  });

  it("rolls back failed migrations atomically (standalone and nested savepoint)", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runSchemaMigrations(db, { targetVersion: SCHEMA_VERSION });
      const nextVersion = SCHEMA_VERSION + 1;
      const failingMigrations = [
        ...SCHEMA_MIGRATIONS,
        {
          version: nextVersion,
          description: `Failing v${nextVersion} step`,
          up(targetDb: DatabaseSync) {
            targetDb.exec("CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)");
            throw new Error("boom");
          },
        },
      ];

      expect(() =>
        runSchemaMigrations(db, { targetVersion: nextVersion, migrations: failingMigrations }),
      ).toThrow("boom");
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
      const rolledBack = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'")
        .get();
      expect(rolledBack).toBeUndefined();

      db.exec("BEGIN IMMEDIATE");
      try {
        expect(() =>
          runSchemaMigrations(db, { targetVersion: nextVersion, migrations: failingMigrations }),
        ).toThrow("boom");
        expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
      } finally {
        db.exec("ROLLBACK");
      }
    } finally {
      db.close();
    }
  });

  it("migrates legacy state.json once and renames it to state.json.bak", async () => {
    const dbPath = join(dir, "state.sqlite");
    const jsonPath = legacyStateJsonPath(dbPath);
    const projectId = randomUUID();
    const epicId = randomUUID();
    const taskId = randomUUID();

    await writeFile(
      jsonPath,
      JSON.stringify({
        version: 1,
        projects: {
          [projectId]: {
            repos: ["catenext"],
            epics: [{ id: epicId, title: "JSON Epic", description: null }],
            personas: [],
            tasks: [
              {
                id: taskId,
                epicId,
                title: "From JSON",
                instruction: "Migrate me",
                status: "TODO",
                dependencies: [],
                target: "catenext",
                role: "backend",
                persona: null,
                requiresApproval: true,
                revision: 0,
                stale: false,
              },
            ],
            documents: [],
          },
        },
      }),
    );

    const db = openDatabaseAt(dbPath);
    try {
      const migrated = await migrateJsonStateIfNeeded(db, dbPath);
      expect(migrated).toBe(true);
      expect(existsSync(jsonPath)).toBe(false);
      expect(existsSync(`${jsonPath}.bak`)).toBe(true);

      const project = loadProject(db, projectId);
      expect(project.tasks.map((t) => t.title)).toEqual(["From JSON"]);

      const meta = db.prepare("SELECT value FROM meta WHERE key = 'migrated_from_json'").get() as
        | { value: string }
        | undefined;
      expect(meta?.value).toBeTruthy();

      const bak = JSON.parse(await readFile(`${jsonPath}.bak`, "utf8")) as { version: number };
      expect(bak.version).toBe(1);

      expect(await migrateJsonStateIfNeeded(db, dbPath)).toBe(false);
    } finally {
      db.close();
    }
  });
});
