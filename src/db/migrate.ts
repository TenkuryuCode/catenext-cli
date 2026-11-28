import { readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AgentAliasSchema,
  BlockerCategorySchema,
  CommitShaSchema,
  EpicSchema,
  HandoffSummarySchema,
  IdSchema,
  IsoDateTimeSchema,
  PersonaSchema,
  ProjectDocumentSchema,
  PullRequestRefSchema,
  RepoNameSchema,
  ReviewDecisionSchema,
  RoleSchema,
  TaskStatusSchema,
  TaskSummarySchema,
} from "@catenext/shared";
import { z } from "zod";
import { LocalServiceError } from "../errors.js";
import { emptyExtendedProject, saveProject } from "./project-codec.js";
import {
  CODE_SEARCH_FILES_SQL,
  CODE_SEARCH_FTS_SQL,
  EMBEDDING_CHUNKS_SQL,
  EPIC_RUNS_SQL,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from "./schema.js";

const LeaseTokenSchema = z.string().min(1).max(128);

const taskLease = z.strictObject({
  id: LeaseTokenSchema,
  repo: RepoNameSchema,
  alias: AgentAliasSchema.optional(),
  expiresAt: IsoDateTimeSchema,
  worktree: z
    .strictObject({
      session: IdSchema,
      worktree_path: z.string().min(1).max(1000).optional(),
      base_branch: z.string().min(1).max(255).optional(),
    })
    .optional(),
});

const review = z.strictObject({
  ref: PullRequestRefSchema,
  repo: RepoNameSchema,
  author: AgentAliasSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  lease: z
    .strictObject({
      id: LeaseTokenSchema,
      reviewer: z.string().min(1),
      expiresAt: IsoDateTimeSchema,
    })
    .optional(),
  decision: z
    .strictObject({
      value: ReviewDecisionSchema,
      reviewer: z.string().min(1),
      feedback: z.string().min(1).max(1000),
    })
    .optional(),
  approvedLocally: z.boolean(),
});

const legacyTask = z.strictObject({
  id: IdSchema,
  epicId: IdSchema,
  title: TaskSummarySchema.shape.title,
  instruction: z.string().min(1).max(8000),
  status: TaskStatusSchema,
  dependencies: z.array(IdSchema).max(10),
  target: RepoNameSchema.nullable(),
  role: RoleSchema.nullable(),
  persona: AgentAliasSchema.nullable(),
  requiresApproval: z.boolean(),
  lease: taskLease.optional(),
  branch: z
    .strictObject({
      repo: RepoNameSchema,
      name: z.string().min(1).max(255),
      worktree_path: z.string().min(1).max(1000).optional(),
      base_branch: z.string().min(1).max(255).optional(),
    })
    .optional(),
  handoff: HandoffSummarySchema.optional(),
  integrated_commit: z
    .strictObject({ branch: z.string().min(1).max(255), sha: CommitShaSchema })
    .optional(),
  review: review.optional(),
  feedback: z.string().min(1).max(2000).optional(),
  revision: z.number().int().min(0),
  stale: z.boolean(),
  blocker: z
    .strictObject({ category: BlockerCategorySchema, reason: z.string().min(10).max(1000) })
    .optional(),
});

const legacyProject = z.strictObject({
  repos: z.array(RepoNameSchema),
  epics: z.array(
    z.strictObject(EpicSchema.pick({ id: true, title: true, description: true }).shape),
  ),
  personas: z.array(z.strictObject(PersonaSchema.shape)),
  tasks: z.array(legacyTask),
  documents: z.array(z.strictObject(ProjectDocumentSchema.shape)),
});

const legacyState = z.strictObject({
  version: z.literal(1),
  projects: z.record(IdSchema, legacyProject),
});

export interface SchemaMigration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

export interface SchemaMigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 2,
    description: "Ensure tasks.integrated_commit_json column and v2 schema indexes",
    up(db) {
      db.exec(SCHEMA_SQL);
      const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (
        taskColumns.length > 0 &&
        !taskColumns.some((col) => col.name === "integrated_commit_json")
      ) {
        db.exec("ALTER TABLE tasks ADD COLUMN integrated_commit_json TEXT");
      }
    },
  },
  {
    version: 3,
    description: "Add task_events audit log table and index",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          event TEXT NOT NULL,
          actor TEXT NOT NULL,
          note TEXT,
          detail_json TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_task_events_project_task_created
          ON task_events(project_id, task_id, created_at);
      `);
    },
  },
  {
    version: 4,
    description: "Preserve existing task order in explicit task positions",
    up(db) {
      const columns = db.prepare("PRAGMA table_info(tasks)").all();
      if (!columns.some(({ name }) => name === "position")) {
        db.exec("ALTER TABLE tasks ADD COLUMN position REAL NOT NULL DEFAULT 0");
      }
      db.exec(`
        WITH task_order AS MATERIALIZED (
          SELECT rowid AS task_row, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY rowid) - 1 AS initial_position
          FROM tasks
        )
        UPDATE tasks SET position = task_order.initial_position
        FROM task_order WHERE tasks.rowid = task_order.task_row;
      `);
    },
  },
  {
    version: 5,
    description: "Add documents.archived_at for soft-archive metadata",
    up(db) {
      const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
      if (!columns.some(({ name }) => name === "archived_at")) {
        db.exec("ALTER TABLE documents ADD COLUMN archived_at TEXT");
      }
    },
  },
  {
    version: 6,
    description: "Add SQLite FTS5 code search tables (code_search_files and code_search_fts)",
    up(db) {
      db.exec(CODE_SEARCH_FILES_SQL);
      tryEnableCodeSearchFts(db);
    },
  },
  {
    version: 7,
    description:
      "Add tasks.scope_files_json, tasks.verify_command, and tasks.doc_refs_json columns",
    up(db) {
      const columns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const names = new Set(columns.map((col) => col.name));
      if (!names.has("scope_files_json")) {
        db.exec("ALTER TABLE tasks ADD COLUMN scope_files_json TEXT");
      }
      if (!names.has("verify_command")) {
        db.exec("ALTER TABLE tasks ADD COLUMN verify_command TEXT");
      }
      if (!names.has("doc_refs_json")) {
        db.exec("ALTER TABLE tasks ADD COLUMN doc_refs_json TEXT");
      }
    },
  },
  {
    version: 8,
    description: "Add opt-in local epic runs",
    up(db) {
      db.exec(EPIC_RUNS_SQL);
    },
  },
  {
    version: 9,
    description: "Add epic summary_json and epic/task archived_at retention metadata",
    up(db) {
      db.exec(EPIC_RUNS_SQL);
      ensureRetentionColumns(db);
    },
  },
  {
    version: 10,
    description: "Add embedding_chunks table for opt-in semantic embeddings",
    up(db) {
      db.exec(EMBEDDING_CHUNKS_SQL);
    },
  },
];

/** Idempotently ensure epic summary and epic/task archival columns exist on an open DB. */
export function ensureRetentionColumns(db: DatabaseSync): void {
  const epicColumns = new Set(
    (db.prepare("PRAGMA table_info(epics)").all() as { name: string }[]).map((col) => col.name),
  );
  if (epicColumns.size > 0) {
    if (!epicColumns.has("summary_json")) {
      db.exec("ALTER TABLE epics ADD COLUMN summary_json TEXT");
    }
    if (!epicColumns.has("archived_at")) {
      db.exec("ALTER TABLE epics ADD COLUMN archived_at TEXT");
    }
  }
  const taskColumns = new Set(
    (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((col) => col.name),
  );
  if (taskColumns.size > 0 && !taskColumns.has("archived_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined;
  return Boolean(row);
}

/** Check whether the `code_search_fts` virtual table is present in SQLite. */
export function hasCodeSearchFts(db: DatabaseSync): boolean {
  return tableExists(db, "code_search_fts");
}

/**
 * Best-effort initialization of `code_search_fts`. Returns `false` cleanly if SQLite
 * was built without FTS5 so callers can fall back to `code_search_files`.
 */
export function tryEnableCodeSearchFts(
  db: DatabaseSync,
  ftsSql: string = CODE_SEARCH_FTS_SQL,
): boolean {
  if (ftsSql === CODE_SEARCH_FTS_SQL && hasCodeSearchFts(db)) return true;
  const sp = "sp_fts5_init";
  const inTx = db.isTransaction;
  db.exec(inTx ? `SAVEPOINT ${sp}` : "BEGIN IMMEDIATE");
  try {
    db.exec(ftsSql);
    db.exec(inTx ? `RELEASE SAVEPOINT ${sp}` : "COMMIT");
    return true;
  } catch (error) {
    db.exec(inTx ? `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}` : "ROLLBACK");
    const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (msg.includes("fts5") || msg.includes("no such module")) {
      return false;
    }
    throw error;
  }
}

function readMetaSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, "meta")) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!row) return 0;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const value = Number(row?.user_version ?? 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** Detect current SQLite schema version from `meta.schema_version` and `PRAGMA user_version`. */
export function getSchemaVersion(db: DatabaseSync): number {
  const metaVersion = readMetaSchemaVersion(db);
  const userVersion = readUserVersion(db);
  const combined = Math.max(metaVersion, userVersion);
  if (combined > 0) return combined;
  if (tableExists(db, "projects") || tableExists(db, "tasks")) return 1;
  return 0;
}

/** Record schema version in both `meta` and `PRAGMA user_version`. */
export function setSchemaVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new LocalServiceError("corrupt_state", `Invalid schema version: ${String(version)}`);
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(version));
  db.exec(`PRAGMA user_version = ${version}`);
}

function runInTransaction(db: DatabaseSync, name: string, fn: () => void): void {
  const useSavepoint = db.isTransaction;
  db.exec(useSavepoint ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  try {
    fn();
    db.exec(useSavepoint ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
  } catch (error) {
    db.exec(useSavepoint ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}` : "ROLLBACK");
    throw error;
  }
}

/**
 * Run idempotent, ordered schema migrations up to `targetVersion` (default `SCHEMA_VERSION`).
 */
export function runSchemaMigrations(
  db: DatabaseSync,
  options: {
    targetVersion?: number;
    migrations?: readonly SchemaMigration[];
  } = {},
): SchemaMigrationResult {
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  const migrations = options.migrations ?? SCHEMA_MIGRATIONS;
  const fromVersion = getSchemaVersion(db);

  if (fromVersion > targetVersion) {
    throw new LocalServiceError(
      "unsupported_schema",
      `Catenext SQLite schema version ${fromVersion} is newer than supported version ${targetVersion}. Upgrade Catenext CLI.`,
    );
  }

  if (fromVersion === 0) {
    runInTransaction(db, "schema_init", () => {
      db.exec(SCHEMA_SQL);
      if (targetVersion >= 6) {
        tryEnableCodeSearchFts(db);
      }
      setSchemaVersion(db, targetVersion);
    });
    return { fromVersion: 0, toVersion: targetVersion, applied: [] };
  }

  if (fromVersion === targetVersion) {
    // Sync meta/user_version only when one of them lagged behind.
    if (readMetaSchemaVersion(db) !== targetVersion || readUserVersion(db) !== targetVersion) {
      runInTransaction(db, "schema_sync_ver", () => {
        setSchemaVersion(db, targetVersion);
      });
    }
    return { fromVersion, toVersion: targetVersion, applied: [] };
  }

  const pending = [...migrations]
    .filter((m) => m.version > fromVersion && m.version <= targetVersion)
    .sort((a, b) => a.version - b.version);

  const applied: number[] = [];
  for (const migration of pending) {
    runInTransaction(db, `schema_v${migration.version}`, () => {
      migration.up(db);
      setSchemaVersion(db, migration.version);
    });
    applied.push(migration.version);
  }

  const afterVersion = getSchemaVersion(db);
  if (afterVersion < targetVersion) {
    runInTransaction(db, "schema_finalize_ver", () => {
      setSchemaVersion(db, targetVersion);
    });
  }

  return { fromVersion, toVersion: targetVersion, applied };
}

/** Classic JSON state path beside a SQLite DB. */
export function legacyStateJsonPath(dbPath: string): string {
  return join(dirname(dbPath), "state.json");
}

export function dbHasProjects(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
  return row.n > 0;
}

/**
 * Import `.catenext/state.json` into an empty SQLite DB once, then rename JSON to `*.bak`.
 */
export async function migrateJsonStateIfNeeded(db: DatabaseSync, dbPath: string): Promise<boolean> {
  if (dbHasProjects(db)) return false;
  const jsonPath = legacyStateJsonPath(dbPath);
  let source: string;
  try {
    source = await readFile(jsonPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new LocalServiceError(
      "corrupt_state",
      "Legacy state.json is corrupt; fix or remove it before opening SQLite state.",
    );
  }
  const parsed = legacyState.safeParse(raw);
  if (!parsed.success) {
    throw new LocalServiceError(
      "corrupt_state",
      "Legacy state.json schema is unsupported; restore a backup or remove the file.",
    );
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [projectId, data] of Object.entries(parsed.data.projects)) {
      const project = emptyExtendedProject();
      project.repos = [...data.repos];
      project.epics = data.epics.map((epic) => ({ ...epic }));
      project.personas = data.personas.map((persona) => ({
        ...persona,
        repos: [...persona.repos],
        rules: [...persona.rules],
      }));
      project.tasks = data.tasks.map((task, position) => ({
        ...task,
        position,
        dependencies: [...task.dependencies],
      }));
      project.documents = data.documents.map((doc) => ({ ...doc }));
      saveProject(db, projectId, project);
    }
    setSchemaVersion(db, SCHEMA_VERSION);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('migrated_from_json', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const bak = `${jsonPath}.bak`;
  try {
    await rename(jsonPath, bak);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  return true;
}
