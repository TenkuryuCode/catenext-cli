import { readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AgentAliasSchema,
  BlockerCategorySchema,
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
import { SCHEMA_VERSION } from "./schema.js";

const LeaseTokenSchema = z.string().min(1).max(128);

const taskLease = z.strictObject({
  id: LeaseTokenSchema,
  repo: RepoNameSchema,
  alias: AgentAliasSchema.optional(),
  expiresAt: IsoDateTimeSchema,
  worktree: z.strictObject({ session: IdSchema }).optional(),
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
  branch: z.strictObject({ repo: RepoNameSchema, name: z.string().min(1).max(255) }).optional(),
  handoff: HandoffSummarySchema.optional(),
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

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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
      project.tasks = data.tasks.map((task) => ({ ...task, dependencies: [...task.dependencies] }));
      project.documents = data.documents.map((doc) => ({ ...doc }));
      saveProject(db, projectId, project);
    }
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SCHEMA_VERSION));
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
