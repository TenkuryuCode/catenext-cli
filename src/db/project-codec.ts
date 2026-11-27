import type { DatabaseSync } from "node:sqlite";
import type { ProjectDocument } from "@catenext/shared";
import {
  type LocalEpic,
  type LocalPermission,
  type LocalProject,
  type LocalRoot,
  type LocalTask,
  type VersionedEpicSummary,
  VersionedEpicSummarySchema,
} from "../local-state.js";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function tableColumnNames(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((col) => col.name),
  );
}

function epicsSelectSql(db: DatabaseSync): string {
  const columns = tableColumnNames(db, "epics");
  const cols = ["id", "title", "description"];
  if (columns.has("summary_json")) cols.push("summary_json");
  if (columns.has("archived_at")) cols.push("archived_at");
  return cols.join(", ");
}

function parseEpicSummary(raw: unknown): VersionedEpicSummary | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parsedJson = parseJson<unknown>(raw, null);
  if (!parsedJson) return null;
  const validated = VersionedEpicSummarySchema.safeParse(parsedJson);
  return validated.success ? validated.data : null;
}

function documentsSelectSql(db: DatabaseSync): string {
  const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
  const base = "slug, title, kind, version, updated_by, updated_at, size, content";
  return columns.some((col) => col.name === "archived_at") ? `${base}, archived_at` : base;
}

function tasksSelectSql(db: DatabaseSync): string {
  const columns = tableColumnNames(db, "tasks");
  const cols = [
    "id",
    "epic_id",
    "title",
    "instruction",
    "status",
    "target",
    "role",
    "persona",
    "requires_approval",
    "revision",
    "stale",
    "feedback",
    "lease_json",
    "branch_json",
    "handoff_json",
    "review_json",
    "blocker_json",
    "integrated_commit_json",
    "position",
  ];
  for (const optionalCol of [
    "scope_files_json",
    "verify_command",
    "doc_refs_json",
    "archived_at",
  ]) {
    if (columns.has(optionalCol)) cols.push(optionalCol);
  }
  return cols.join(", ");
}

export function emptyExtendedProject(): LocalProject {
  return {
    repos: [],
    epics: [],
    personas: [],
    tasks: [],
    documents: [],
    permissions: [],
    workspace_roots: [],
    session_prefs: {},
    platform_setup: [],
  };
}

function hydrateTaskRow(row: Record<string, unknown>, dependencies: string[]): LocalTask {
  const task: LocalTask = {
    id: String(row.id),
    epicId: String(row.epic_id),
    title: String(row.title),
    instruction: String(row.instruction),
    status: row.status as LocalTask["status"],
    dependencies,
    target: (row.target as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    persona: (row.persona as string | null) ?? null,
    position: Number(row.position),
    requiresApproval: Boolean(row.requires_approval),
    revision: Number(row.revision),
    stale: Boolean(row.stale),
  };
  if (row.feedback) task.feedback = String(row.feedback);
  const lease = parseJson<LocalTask["lease"] | undefined>(
    row.lease_json as string | null,
    undefined,
  );
  if (lease) task.lease = lease;
  const branch = parseJson<LocalTask["branch"] | undefined>(
    row.branch_json as string | null,
    undefined,
  );
  if (branch) task.branch = branch;
  const handoff = parseJson<LocalTask["handoff"] | undefined>(
    row.handoff_json as string | null,
    undefined,
  );
  if (handoff) task.handoff = handoff;
  const review = parseJson<LocalTask["review"] | undefined>(
    row.review_json as string | null,
    undefined,
  );
  if (review) task.review = review;
  const blocker = parseJson<LocalTask["blocker"] | undefined>(
    row.blocker_json as string | null,
    undefined,
  );
  if (blocker) task.blocker = blocker;
  const integratedCommit = parseJson<LocalTask["integrated_commit"] | undefined>(
    row.integrated_commit_json as string | null,
    undefined,
  );
  if (integratedCommit) task.integrated_commit = integratedCommit;
  const scopeFiles = parseJson<LocalTask["scope_files"] | undefined>(
    row.scope_files_json as string | null,
    undefined,
  );
  if (Array.isArray(scopeFiles)) task.scope_files = scopeFiles;
  if (typeof row.verify_command === "string" && row.verify_command.length > 0) {
    task.verify_command = row.verify_command;
  }
  const docRefs = parseJson<LocalTask["doc_refs"] | undefined>(
    row.doc_refs_json as string | null,
    undefined,
  );
  if (Array.isArray(docRefs)) task.doc_refs = docRefs;
  if (typeof row.archived_at === "string" && row.archived_at.length > 0) {
    task.archived_at = row.archived_at;
  }
  return task;
}

export function loadProjectState(
  db: DatabaseSync,
  projectId: string,
): { exists: boolean; project: LocalProject } {
  const project = emptyExtendedProject();
  const exists = db.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").get(projectId) as
    | { ok: number }
    | undefined;
  if (!exists) return { exists: false, project };

  project.repos = (
    db
      .prepare("SELECT repo FROM project_repos WHERE project_id = ? ORDER BY repo")
      .all(projectId) as {
      repo: string;
    }[]
  ).map((row) => row.repo);

  const epicSelect = epicsSelectSql(db);
  project.epics = (
    db
      .prepare(`SELECT ${epicSelect} FROM epics WHERE project_id = ? ORDER BY title, id`)
      .all(projectId) as {
      id: string;
      title: string;
      description: string | null;
      summary_json?: string | null;
      archived_at?: string | null;
    }[]
  ).map((row): LocalEpic => {
    const summary = parseEpicSummary(row.summary_json);
    const archivedAt =
      typeof row.archived_at === "string" && row.archived_at.length > 0 ? row.archived_at : null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      ...(summary ? { summary } : {}),
      ...(archivedAt ? { archived_at: archivedAt } : {}),
    };
  });

  const personaRows = db
    .prepare("SELECT alias, role, rules_json FROM personas WHERE project_id = ? ORDER BY alias")
    .all(projectId) as { alias: string; role: string; rules_json: string }[];
  const repoRows = db
    .prepare("SELECT alias, repo FROM persona_repos WHERE project_id = ?")
    .all(projectId) as { alias: string; repo: string }[];
  const reposByAlias = new Map<string, string[]>();
  for (const row of repoRows) {
    const list = reposByAlias.get(row.alias) ?? [];
    list.push(row.repo);
    reposByAlias.set(row.alias, list);
  }
  project.personas = personaRows.map((row) => ({
    alias: row.alias,
    role: row.role,
    rules: parseJson<string[]>(row.rules_json, []),
    repos: reposByAlias.get(row.alias) ?? [],
  }));

  const documentSelect = documentsSelectSql(db);
  project.documents = (
    db
      .prepare(`SELECT ${documentSelect} FROM documents WHERE project_id = ? ORDER BY slug`)
      .all(projectId) as {
      slug: string;
      title: string;
      kind: string;
      version: number;
      updated_by: string;
      updated_at: string;
      size: number;
      content: string;
      archived_at?: string | null;
    }[]
  ).map((row) => ({
    slug: row.slug,
    title: row.title,
    kind: row.kind as LocalProject["documents"][number]["kind"],
    version: row.version,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    size: row.size,
    content: row.content,
    archived_at: row.archived_at ?? null,
  }));

  const depRows = db
    .prepare("SELECT task_id, depends_on FROM task_deps WHERE project_id = ?")
    .all(projectId) as { task_id: string; depends_on: string }[];
  const depsByTask = new Map<string, string[]>();
  for (const row of depRows) {
    const list = depsByTask.get(row.task_id) ?? [];
    list.push(row.depends_on);
    depsByTask.set(row.task_id, list);
  }

  const taskRows = db
    .prepare(
      `SELECT ${tasksSelectSql(db)} FROM tasks WHERE project_id = ? ORDER BY position, rowid`,
    )
    .all(projectId) as Record<string, unknown>[];

  project.tasks = taskRows.map((row) => hydrateTaskRow(row, depsByTask.get(String(row.id)) ?? []));

  project.permissions = (
    db.prepare("SELECT action, principal FROM permissions WHERE project_id = ?").all(projectId) as {
      action: string;
      principal: string;
    }[]
  ).map((row) => ({ action: row.action as LocalPermission["action"], principal: row.principal }));

  project.workspace_roots = (
    db
      .prepare(
        "SELECT id, path, owner_persona, label FROM workspace_roots WHERE project_id = ? ORDER BY path",
      )
      .all(projectId) as {
      id: string;
      path: string;
      owner_persona: string | null;
      label: string | null;
    }[]
  ).map(
    (row): LocalRoot => ({
      id: row.id,
      path: row.path,
      ownerPersona: row.owner_persona,
      label: row.label ?? undefined,
    }),
  );

  const prefs = db
    .prepare("SELECT locale FROM session_prefs WHERE project_id = ?")
    .get(projectId) as { locale: string | null } | undefined;
  project.session_prefs = { locale: prefs?.locale ?? undefined };

  project.platform_setup = (
    db
      .prepare("SELECT platform FROM platform_setup WHERE project_id = ? AND installed = 1")
      .all(projectId) as { platform: string }[]
  ).map((row) => row.platform);

  return { exists: true, project };
}

export function loadProject(db: DatabaseSync, projectId: string): LocalProject {
  return loadProjectState(db, projectId).project;
}

/** Load a single task (and its dependencies) without hydrating the other 10 tables. */
export function loadTask(
  db: DatabaseSync,
  projectId: string,
  taskId: string,
): LocalTask | undefined {
  const row = db
    .prepare(`SELECT ${tasksSelectSql(db)} FROM tasks WHERE project_id = ? AND id = ?`)
    .get(projectId, taskId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const deps = (
    db
      .prepare("SELECT depends_on FROM task_deps WHERE project_id = ? AND task_id = ?")
      .all(projectId, taskId) as { depends_on: string }[]
  ).map((d) => d.depends_on);
  return hydrateTaskRow(row, deps);
}

/** Upsert a single task (and diff its dependencies) without touching other tasks or tables. */
export function saveTask(db: DatabaseSync, projectId: string, task: LocalTask): void {
  const serialized = serializeTask(task);
  const hasArchivedAt = tableColumnNames(db, "tasks").has("archived_at");
  if (hasArchivedAt) {
    db.prepare(
      `INSERT INTO tasks
        (id, project_id, epic_id, title, instruction, status, target, role, persona,
         requires_approval, revision, stale, feedback,
         lease_json, branch_json, handoff_json, review_json, blocker_json, integrated_commit_json,
         scope_files_json, verify_command, doc_refs_json, archived_at, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, id) DO UPDATE SET
         epic_id = excluded.epic_id,
         title = excluded.title,
         instruction = excluded.instruction,
         status = excluded.status,
         target = excluded.target,
         role = excluded.role,
         persona = excluded.persona,
         requires_approval = excluded.requires_approval,
         revision = excluded.revision,
         stale = excluded.stale,
         feedback = excluded.feedback,
         lease_json = excluded.lease_json,
         branch_json = excluded.branch_json,
         handoff_json = excluded.handoff_json,
         review_json = excluded.review_json,
         blocker_json = excluded.blocker_json,
         integrated_commit_json = excluded.integrated_commit_json,
         scope_files_json = excluded.scope_files_json,
         verify_command = excluded.verify_command,
         doc_refs_json = excluded.doc_refs_json,
         archived_at = excluded.archived_at,
         position = excluded.position`,
    ).run(
      task.id,
      projectId,
      serialized.epicId,
      serialized.title,
      serialized.instruction,
      serialized.status,
      serialized.target,
      serialized.role,
      serialized.persona,
      serialized.requiresApproval,
      serialized.revision,
      serialized.stale,
      serialized.feedback,
      serialized.leaseJson,
      serialized.branchJson,
      serialized.handoffJson,
      serialized.reviewJson,
      serialized.blockerJson,
      serialized.integratedCommitJson,
      serialized.scopeFilesJson,
      serialized.verifyCommand,
      serialized.docRefsJson,
      serialized.archivedAt,
      serialized.position,
    );
  } else {
    db.prepare(
      `INSERT INTO tasks
        (id, project_id, epic_id, title, instruction, status, target, role, persona,
         requires_approval, revision, stale, feedback,
         lease_json, branch_json, handoff_json, review_json, blocker_json, integrated_commit_json,
         scope_files_json, verify_command, doc_refs_json, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, id) DO UPDATE SET
         epic_id = excluded.epic_id,
         title = excluded.title,
         instruction = excluded.instruction,
         status = excluded.status,
         target = excluded.target,
         role = excluded.role,
         persona = excluded.persona,
         requires_approval = excluded.requires_approval,
         revision = excluded.revision,
         stale = excluded.stale,
         feedback = excluded.feedback,
         lease_json = excluded.lease_json,
         branch_json = excluded.branch_json,
         handoff_json = excluded.handoff_json,
         review_json = excluded.review_json,
         blocker_json = excluded.blocker_json,
         integrated_commit_json = excluded.integrated_commit_json,
         scope_files_json = excluded.scope_files_json,
         verify_command = excluded.verify_command,
         doc_refs_json = excluded.doc_refs_json,
         position = excluded.position`,
    ).run(
      task.id,
      projectId,
      serialized.epicId,
      serialized.title,
      serialized.instruction,
      serialized.status,
      serialized.target,
      serialized.role,
      serialized.persona,
      serialized.requiresApproval,
      serialized.revision,
      serialized.stale,
      serialized.feedback,
      serialized.leaseJson,
      serialized.branchJson,
      serialized.handoffJson,
      serialized.reviewJson,
      serialized.blockerJson,
      serialized.integratedCommitJson,
      serialized.scopeFilesJson,
      serialized.verifyCommand,
      serialized.docRefsJson,
      serialized.position,
    );
  }

  const existingDeps = new Set(
    (
      db
        .prepare("SELECT depends_on FROM task_deps WHERE project_id = ? AND task_id = ?")
        .all(projectId, task.id) as { depends_on: string }[]
    ).map((r) => r.depends_on),
  );
  const nextDeps = new Set(task.dependencies);
  const delDep = db.prepare(
    "DELETE FROM task_deps WHERE project_id = ? AND task_id = ? AND depends_on = ?",
  );
  for (const dep of existingDeps) {
    if (!nextDeps.has(dep)) delDep.run(projectId, task.id, dep);
  }
  const insDep = db.prepare(
    "INSERT OR IGNORE INTO task_deps (project_id, task_id, depends_on) VALUES (?, ?, ?)",
  );
  for (const dep of nextDeps) {
    if (!existingDeps.has(dep)) insDep.run(projectId, task.id, dep);
  }
}

/** Load a single document by slug without hydrating unrelated tables. */
export function loadDocument(
  db: DatabaseSync,
  projectId: string,
  slug: string,
): ProjectDocument | undefined {
  const row = db
    .prepare(`SELECT ${documentsSelectSql(db)} FROM documents WHERE project_id = ? AND slug = ?`)
    .get(projectId, slug) as
    | {
        slug: string;
        title: string;
        kind: string;
        version: number;
        updated_by: string;
        updated_at: string;
        size: number;
        content: string;
        archived_at?: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    slug: row.slug,
    title: row.title,
    kind: row.kind as ProjectDocument["kind"],
    version: row.version,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    size: row.size,
    content: row.content,
    archived_at: row.archived_at ?? null,
  };
}

/** Upsert a single document row without touching unrelated tables. */
export function saveDocumentRow(db: DatabaseSync, projectId: string, doc: ProjectDocument): void {
  db.prepare(
    `INSERT INTO documents
      (project_id, slug, title, kind, version, updated_by, updated_at, size, content, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, slug) DO UPDATE SET
       title = excluded.title,
       kind = excluded.kind,
       version = excluded.version,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at,
       size = excluded.size,
       content = excluded.content,
       archived_at = excluded.archived_at`,
  ).run(
    projectId,
    doc.slug,
    doc.title,
    doc.kind,
    doc.version,
    doc.updated_by,
    doc.updated_at,
    doc.size,
    doc.content,
    doc.archived_at ?? null,
  );
}

type SerializedTask = {
  epicId: string;
  title: string;
  instruction: string;
  status: string;
  target: string | null;
  role: string | null;
  persona: string | null;
  requiresApproval: number;
  revision: number;
  stale: number;
  feedback: string | null;
  leaseJson: string | null;
  branchJson: string | null;
  handoffJson: string | null;
  reviewJson: string | null;
  blockerJson: string | null;
  integratedCommitJson: string | null;
  scopeFilesJson: string | null;
  verifyCommand: string | null;
  docRefsJson: string | null;
  archivedAt: string | null;
  position: number;
};

function serializeTask(task: LocalTask): SerializedTask {
  return {
    epicId: task.epicId,
    position: task.position,
    title: task.title,
    instruction: task.instruction,
    status: task.status,
    target: task.target,
    role: task.role,
    persona: task.persona,
    requiresApproval: task.requiresApproval ? 1 : 0,
    revision: task.revision,
    stale: task.stale ? 1 : 0,
    feedback: task.feedback ?? null,
    leaseJson: task.lease ? JSON.stringify(task.lease) : null,
    branchJson: task.branch ? JSON.stringify(task.branch) : null,
    handoffJson: task.handoff ? JSON.stringify(task.handoff) : null,
    reviewJson: task.review ? JSON.stringify(task.review) : null,
    blockerJson: task.blocker ? JSON.stringify(task.blocker) : null,
    integratedCommitJson: task.integrated_commit ? JSON.stringify(task.integrated_commit) : null,
    scopeFilesJson: task.scope_files !== undefined ? JSON.stringify(task.scope_files) : null,
    verifyCommand: task.verify_command ?? null,
    docRefsJson: task.doc_refs !== undefined ? JSON.stringify(task.doc_refs) : null,
    archivedAt: task.archived_at ?? null,
  };
}

function serializedTaskEqual(a: SerializedTask, b: SerializedTask): boolean {
  return (
    a.epicId === b.epicId &&
    a.position === b.position &&
    a.title === b.title &&
    a.instruction === b.instruction &&
    a.status === b.status &&
    a.target === b.target &&
    a.role === b.role &&
    a.persona === b.persona &&
    a.requiresApproval === b.requiresApproval &&
    a.revision === b.revision &&
    a.stale === b.stale &&
    a.feedback === b.feedback &&
    a.leaseJson === b.leaseJson &&
    a.branchJson === b.branchJson &&
    a.handoffJson === b.handoffJson &&
    a.reviewJson === b.reviewJson &&
    a.blockerJson === b.blockerJson &&
    a.integratedCommitJson === b.integratedCommitJson &&
    a.scopeFilesJson === b.scopeFilesJson &&
    a.verifyCommand === b.verifyCommand &&
    a.docRefsJson === b.docRefsJson &&
    a.archivedAt === b.archivedAt
  );
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  if (setA.size !== new Set(b).size) return false;
  for (const item of b) {
    if (!setA.has(item)) return false;
  }
  return true;
}

/** Persist only modified rows/tables between `before` and `after` snapshots. */
export function saveProjectDiff(
  db: DatabaseSync,
  projectId: string,
  before: LocalProject,
  after: LocalProject,
  projectExists = false,
): void {
  if (!projectExists) {
    db.prepare(
      "INSERT INTO projects (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(projectId, new Date().toISOString());
  }

  // 1. project_repos
  if (!sameStringSet(before.repos, after.repos)) {
    const beforeRepos = new Set(before.repos);
    const afterRepos = new Set(after.repos);
    const delRepo = db.prepare("DELETE FROM project_repos WHERE project_id = ? AND repo = ?");
    const insRepo = db.prepare(
      "INSERT OR IGNORE INTO project_repos (project_id, repo) VALUES (?, ?)",
    );
    for (const repo of beforeRepos) {
      if (!afterRepos.has(repo)) delRepo.run(projectId, repo);
    }
    for (const repo of afterRepos) {
      if (!beforeRepos.has(repo)) insRepo.run(projectId, repo);
    }
  }

  // 2. epics
  const epicCols = tableColumnNames(db, "epics");
  const hasEpicRetentionCols = epicCols.has("summary_json") && epicCols.has("archived_at");
  const beforeEpics = new Map(before.epics.map((e) => [e.id, e]));
  const afterEpics = new Map(after.epics.map((e) => [e.id, e]));
  let delEpic: ReturnType<DatabaseSync["prepare"]> | undefined;
  let insEpic: ReturnType<DatabaseSync["prepare"]> | undefined;
  let updEpic: ReturnType<DatabaseSync["prepare"]> | undefined;
  for (const id of beforeEpics.keys()) {
    if (!afterEpics.has(id)) {
      delEpic ??= db.prepare("DELETE FROM epics WHERE project_id = ? AND id = ?");
      delEpic.run(projectId, id);
    }
  }
  for (const epic of after.epics) {
    const prev = beforeEpics.get(epic.id);
    const nextSummaryJson = epic.summary ? JSON.stringify(epic.summary) : null;
    const nextArchivedAt = epic.archived_at ?? null;
    const prevSummaryJson = prev?.summary ? JSON.stringify(prev.summary) : null;
    const prevArchivedAt = prev?.archived_at ?? null;
    if (!prev) {
      if (hasEpicRetentionCols) {
        insEpic ??= db.prepare(
          "INSERT INTO epics (id, project_id, title, description, summary_json, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        insEpic.run(
          epic.id,
          projectId,
          epic.title,
          epic.description ?? null,
          nextSummaryJson,
          nextArchivedAt,
        );
      } else {
        insEpic ??= db.prepare(
          "INSERT INTO epics (id, project_id, title, description) VALUES (?, ?, ?, ?)",
        );
        insEpic.run(epic.id, projectId, epic.title, epic.description ?? null);
      }
    } else if (
      prev.title !== epic.title ||
      (prev.description ?? null) !== (epic.description ?? null) ||
      prevSummaryJson !== nextSummaryJson ||
      prevArchivedAt !== nextArchivedAt
    ) {
      if (hasEpicRetentionCols) {
        updEpic ??= db.prepare(
          "UPDATE epics SET title = ?, description = ?, summary_json = ?, archived_at = ? WHERE project_id = ? AND id = ?",
        );
        updEpic.run(
          epic.title,
          epic.description ?? null,
          nextSummaryJson,
          nextArchivedAt,
          projectId,
          epic.id,
        );
      } else {
        updEpic ??= db.prepare(
          "UPDATE epics SET title = ?, description = ? WHERE project_id = ? AND id = ?",
        );
        updEpic.run(epic.title, epic.description ?? null, projectId, epic.id);
      }
    }
  }

  // 3. personas + persona_repos
  const beforePersonas = new Map(before.personas.map((p) => [p.alias, p]));
  const afterPersonas = new Map(after.personas.map((p) => [p.alias, p]));
  let delPersona: ReturnType<DatabaseSync["prepare"]> | undefined;
  let insPersona: ReturnType<DatabaseSync["prepare"]> | undefined;
  let updPersona: ReturnType<DatabaseSync["prepare"]> | undefined;
  let delPersonaRepo: ReturnType<DatabaseSync["prepare"]> | undefined;
  let insPersonaRepo: ReturnType<DatabaseSync["prepare"]> | undefined;
  for (const alias of beforePersonas.keys()) {
    if (!afterPersonas.has(alias)) {
      delPersona ??= db.prepare("DELETE FROM personas WHERE project_id = ? AND alias = ?");
      delPersona.run(projectId, alias);
    }
  }
  for (const persona of after.personas) {
    const prev = beforePersonas.get(persona.alias);
    const rulesJson = JSON.stringify(persona.rules);
    if (!prev) {
      insPersona ??= db.prepare(
        "INSERT INTO personas (project_id, alias, role, rules_json) VALUES (?, ?, ?, ?)",
      );
      insPersona.run(projectId, persona.alias, persona.role, rulesJson);
      for (const repo of new Set(persona.repos)) {
        insPersonaRepo ??= db.prepare(
          "INSERT OR IGNORE INTO persona_repos (project_id, alias, repo) VALUES (?, ?, ?)",
        );
        insPersonaRepo.run(projectId, persona.alias, repo);
      }
    } else {
      if (prev.role !== persona.role || JSON.stringify(prev.rules) !== rulesJson) {
        updPersona ??= db.prepare(
          "UPDATE personas SET role = ?, rules_json = ? WHERE project_id = ? AND alias = ?",
        );
        updPersona.run(persona.role, rulesJson, projectId, persona.alias);
      }
      if (!sameStringSet(prev.repos, persona.repos)) {
        const prevRepos = new Set(prev.repos);
        const nextRepos = new Set(persona.repos);
        for (const repo of prevRepos) {
          if (!nextRepos.has(repo)) {
            delPersonaRepo ??= db.prepare(
              "DELETE FROM persona_repos WHERE project_id = ? AND alias = ? AND repo = ?",
            );
            delPersonaRepo.run(projectId, persona.alias, repo);
          }
        }
        for (const repo of nextRepos) {
          if (!prevRepos.has(repo)) {
            insPersonaRepo ??= db.prepare(
              "INSERT OR IGNORE INTO persona_repos (project_id, alias, repo) VALUES (?, ?, ?)",
            );
            insPersonaRepo.run(projectId, persona.alias, repo);
          }
        }
      }
    }
  }

  // 4. documents
  const beforeDocs = new Map(before.documents.map((d) => [d.slug, d]));
  const afterDocs = new Map(after.documents.map((d) => [d.slug, d]));
  let delDoc: ReturnType<DatabaseSync["prepare"]> | undefined;
  let insDoc: ReturnType<DatabaseSync["prepare"]> | undefined;
  let updDoc: ReturnType<DatabaseSync["prepare"]> | undefined;
  for (const slug of beforeDocs.keys()) {
    if (!afterDocs.has(slug)) {
      delDoc ??= db.prepare("DELETE FROM documents WHERE project_id = ? AND slug = ?");
      delDoc.run(projectId, slug);
    }
  }
  for (const doc of after.documents) {
    const prev = beforeDocs.get(doc.slug);
    if (!prev) {
      insDoc ??= db.prepare(
        `INSERT INTO documents
          (project_id, slug, title, kind, version, updated_by, updated_at, size, content, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insDoc.run(
        projectId,
        doc.slug,
        doc.title,
        doc.kind,
        doc.version,
        doc.updated_by,
        doc.updated_at,
        doc.size,
        doc.content,
        doc.archived_at ?? null,
      );
    } else if (
      prev.title !== doc.title ||
      prev.kind !== doc.kind ||
      prev.version !== doc.version ||
      prev.updated_by !== doc.updated_by ||
      prev.updated_at !== doc.updated_at ||
      prev.size !== doc.size ||
      prev.content !== doc.content ||
      (prev.archived_at ?? null) !== (doc.archived_at ?? null)
    ) {
      updDoc ??= db.prepare(
        `UPDATE documents
         SET title = ?, kind = ?, version = ?, updated_by = ?, updated_at = ?, size = ?, content = ?, archived_at = ?
         WHERE project_id = ? AND slug = ?`,
      );
      updDoc.run(
        doc.title,
        doc.kind,
        doc.version,
        doc.updated_by,
        doc.updated_at,
        doc.size,
        doc.content,
        doc.archived_at ?? null,
        projectId,
        doc.slug,
      );
    }
  }

  // 5. tasks + task_deps
  const hasTaskArchivedCol = tableColumnNames(db, "tasks").has("archived_at");
  const beforeTasks = new Map(before.tasks.map((t) => [t.id, t]));
  const afterTasks = new Map(after.tasks.map((t) => [t.id, t]));
  let delTask: ReturnType<DatabaseSync["prepare"]> | undefined;
  let insTask: ReturnType<DatabaseSync["prepare"]> | undefined;
  let updTask: ReturnType<DatabaseSync["prepare"]> | undefined;
  let delDep: ReturnType<DatabaseSync["prepare"]> | undefined;
  let insDep: ReturnType<DatabaseSync["prepare"]> | undefined;
  for (const id of beforeTasks.keys()) {
    if (!afterTasks.has(id)) {
      delTask ??= db.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ?");
      delTask.run(projectId, id);
    }
  }
  for (const task of after.tasks) {
    const prev = beforeTasks.get(task.id);
    const nextSer = serializeTask(task);
    if (!prev) {
      if (hasTaskArchivedCol) {
        insTask ??= db.prepare(
          `INSERT INTO tasks
            (id, project_id, epic_id, title, instruction, status, target, role, persona,
             requires_approval, revision, stale, feedback,
             lease_json, branch_json, handoff_json, review_json, blocker_json, integrated_commit_json,
             scope_files_json, verify_command, doc_refs_json, archived_at, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insTask.run(
          task.id,
          projectId,
          nextSer.epicId,
          nextSer.title,
          nextSer.instruction,
          nextSer.status,
          nextSer.target,
          nextSer.role,
          nextSer.persona,
          nextSer.requiresApproval,
          nextSer.revision,
          nextSer.stale,
          nextSer.feedback,
          nextSer.leaseJson,
          nextSer.branchJson,
          nextSer.handoffJson,
          nextSer.reviewJson,
          nextSer.blockerJson,
          nextSer.integratedCommitJson,
          nextSer.scopeFilesJson,
          nextSer.verifyCommand,
          nextSer.docRefsJson,
          nextSer.archivedAt,
          nextSer.position,
        );
      } else {
        insTask ??= db.prepare(
          `INSERT INTO tasks
            (id, project_id, epic_id, title, instruction, status, target, role, persona,
             requires_approval, revision, stale, feedback,
             lease_json, branch_json, handoff_json, review_json, blocker_json, integrated_commit_json,
             scope_files_json, verify_command, doc_refs_json, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insTask.run(
          task.id,
          projectId,
          nextSer.epicId,
          nextSer.title,
          nextSer.instruction,
          nextSer.status,
          nextSer.target,
          nextSer.role,
          nextSer.persona,
          nextSer.requiresApproval,
          nextSer.revision,
          nextSer.stale,
          nextSer.feedback,
          nextSer.leaseJson,
          nextSer.branchJson,
          nextSer.handoffJson,
          nextSer.reviewJson,
          nextSer.blockerJson,
          nextSer.integratedCommitJson,
          nextSer.scopeFilesJson,
          nextSer.verifyCommand,
          nextSer.docRefsJson,
          nextSer.position,
        );
      }
      for (const dep of new Set(task.dependencies)) {
        insDep ??= db.prepare(
          "INSERT OR IGNORE INTO task_deps (project_id, task_id, depends_on) VALUES (?, ?, ?)",
        );
        insDep.run(projectId, task.id, dep);
      }
    } else {
      const prevSer = serializeTask(prev);
      if (!serializedTaskEqual(prevSer, nextSer)) {
        if (hasTaskArchivedCol) {
          updTask ??= db.prepare(
            `UPDATE tasks SET
               epic_id = ?, title = ?, instruction = ?, status = ?, target = ?, role = ?, persona = ?,
               requires_approval = ?, revision = ?, stale = ?, feedback = ?,
               lease_json = ?, branch_json = ?, handoff_json = ?, review_json = ?, blocker_json = ?,
               integrated_commit_json = ?, scope_files_json = ?, verify_command = ?, doc_refs_json = ?,
               archived_at = ?, position = ?
             WHERE project_id = ? AND id = ?`,
          );
          updTask.run(
            nextSer.epicId,
            nextSer.title,
            nextSer.instruction,
            nextSer.status,
            nextSer.target,
            nextSer.role,
            nextSer.persona,
            nextSer.requiresApproval,
            nextSer.revision,
            nextSer.stale,
            nextSer.feedback,
            nextSer.leaseJson,
            nextSer.branchJson,
            nextSer.handoffJson,
            nextSer.reviewJson,
            nextSer.blockerJson,
            nextSer.integratedCommitJson,
            nextSer.scopeFilesJson,
            nextSer.verifyCommand,
            nextSer.docRefsJson,
            nextSer.archivedAt,
            nextSer.position,
            projectId,
            task.id,
          );
        } else {
          updTask ??= db.prepare(
            `UPDATE tasks SET
               epic_id = ?, title = ?, instruction = ?, status = ?, target = ?, role = ?, persona = ?,
               requires_approval = ?, revision = ?, stale = ?, feedback = ?,
               lease_json = ?, branch_json = ?, handoff_json = ?, review_json = ?, blocker_json = ?,
               integrated_commit_json = ?, scope_files_json = ?, verify_command = ?, doc_refs_json = ?,
               position = ?
             WHERE project_id = ? AND id = ?`,
          );
          updTask.run(
            nextSer.epicId,
            nextSer.title,
            nextSer.instruction,
            nextSer.status,
            nextSer.target,
            nextSer.role,
            nextSer.persona,
            nextSer.requiresApproval,
            nextSer.revision,
            nextSer.stale,
            nextSer.feedback,
            nextSer.leaseJson,
            nextSer.branchJson,
            nextSer.handoffJson,
            nextSer.reviewJson,
            nextSer.blockerJson,
            nextSer.integratedCommitJson,
            nextSer.scopeFilesJson,
            nextSer.verifyCommand,
            nextSer.docRefsJson,
            nextSer.position,
            projectId,
            task.id,
          );
        }
      }
      if (!sameStringSet(prev.dependencies, task.dependencies)) {
        const prevDeps = new Set(prev.dependencies);
        const nextDeps = new Set(task.dependencies);
        for (const dep of prevDeps) {
          if (!nextDeps.has(dep)) {
            delDep ??= db.prepare(
              "DELETE FROM task_deps WHERE project_id = ? AND task_id = ? AND depends_on = ?",
            );
            delDep.run(projectId, task.id, dep);
          }
        }
        for (const dep of nextDeps) {
          if (!prevDeps.has(dep)) {
            insDep ??= db.prepare(
              "INSERT OR IGNORE INTO task_deps (project_id, task_id, depends_on) VALUES (?, ?, ?)",
            );
            insDep.run(projectId, task.id, dep);
          }
        }
      }
    }
  }

  // 6. permissions
  const permKey = (p: LocalPermission) => `${p.action}\0${p.principal}`;
  const beforePerms = new Map((before.permissions ?? []).map((p) => [permKey(p), p]));
  const afterPerms = new Map((after.permissions ?? []).map((p) => [permKey(p), p]));
  let delPerm: ReturnType<DatabaseSync["prepare"]> | undefined;
  let insPerm: ReturnType<DatabaseSync["prepare"]> | undefined;
  for (const [k, perm] of beforePerms) {
    if (!afterPerms.has(k)) {
      delPerm ??= db.prepare(
        "DELETE FROM permissions WHERE project_id = ? AND action = ? AND principal = ?",
      );
      delPerm.run(projectId, perm.action, perm.principal);
    }
  }
  for (const [k, perm] of afterPerms) {
    if (!beforePerms.has(k)) {
      insPerm ??= db.prepare(
        "INSERT OR IGNORE INTO permissions (project_id, action, principal) VALUES (?, ?, ?)",
      );
      insPerm.run(projectId, perm.action, perm.principal);
    }
  }

  // 7. workspace_roots
  const beforeRoots = new Map((before.workspace_roots ?? []).map((r) => [r.id, r]));
  const afterRoots = new Map((after.workspace_roots ?? []).map((r) => [r.id, r]));
  let delRoot: ReturnType<DatabaseSync["prepare"]> | undefined;
  let insRoot: ReturnType<DatabaseSync["prepare"]> | undefined;
  let updRoot: ReturnType<DatabaseSync["prepare"]> | undefined;
  for (const id of beforeRoots.keys()) {
    if (!afterRoots.has(id)) {
      delRoot ??= db.prepare("DELETE FROM workspace_roots WHERE project_id = ? AND id = ?");
      delRoot.run(projectId, id);
    }
  }
  for (const root of after.workspace_roots ?? []) {
    const prev = beforeRoots.get(root.id);
    if (!prev) {
      insRoot ??= db.prepare(
        "INSERT INTO workspace_roots (id, project_id, path, owner_persona, label) VALUES (?, ?, ?, ?, ?)",
      );
      insRoot.run(root.id, projectId, root.path, root.ownerPersona, root.label ?? null);
    } else if (
      prev.path !== root.path ||
      prev.ownerPersona !== root.ownerPersona ||
      (prev.label ?? null) !== (root.label ?? null)
    ) {
      updRoot ??= db.prepare(
        "UPDATE workspace_roots SET path = ?, owner_persona = ?, label = ? WHERE project_id = ? AND id = ?",
      );
      updRoot.run(root.path, root.ownerPersona, root.label ?? null, projectId, root.id);
    }
  }

  // 8. platform_setup
  const beforePlatforms = before.platform_setup ?? [];
  const afterPlatforms = after.platform_setup ?? [];
  if (!sameStringSet(beforePlatforms, afterPlatforms)) {
    const prevSet = new Set(beforePlatforms);
    const nextSet = new Set(afterPlatforms);
    const delPlatform = db.prepare(
      "DELETE FROM platform_setup WHERE project_id = ? AND platform = ?",
    );
    const insPlatform = db.prepare(
      "INSERT OR IGNORE INTO platform_setup (project_id, platform, installed) VALUES (?, ?, 1)",
    );
    for (const platform of prevSet) {
      if (!nextSet.has(platform)) delPlatform.run(projectId, platform);
    }
    for (const platform of nextSet) {
      if (!prevSet.has(platform)) insPlatform.run(projectId, platform);
    }
  }

  // 9. session_prefs
  const prevLocale = before.session_prefs?.locale ?? null;
  const nextLocale = after.session_prefs?.locale ?? null;
  if (!projectExists || prevLocale !== nextLocale) {
    db.prepare(
      "INSERT INTO session_prefs (project_id, locale) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET locale = excluded.locale",
    ).run(projectId, nextLocale);
  }
}

export function saveProject(db: DatabaseSync, projectId: string, project: LocalProject): void {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(
    projectId,
    now,
  );

  db.prepare("DELETE FROM task_deps WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM documents WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM persona_repos WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM personas WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM epics WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM project_repos WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM permissions WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM workspace_roots WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM platform_setup WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM session_prefs WHERE project_id = ?").run(projectId);

  const insertRepo = db.prepare("INSERT INTO project_repos (project_id, repo) VALUES (?, ?)");
  for (const repo of project.repos) insertRepo.run(projectId, repo);

  const epicCols = tableColumnNames(db, "epics");
  if (epicCols.has("summary_json") && epicCols.has("archived_at")) {
    const insertEpic = db.prepare(
      "INSERT INTO epics (id, project_id, title, description, summary_json, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const epic of project.epics) {
      insertEpic.run(
        epic.id,
        projectId,
        epic.title,
        epic.description ?? null,
        epic.summary ? JSON.stringify(epic.summary) : null,
        epic.archived_at ?? null,
      );
    }
  } else {
    const insertEpic = db.prepare(
      "INSERT INTO epics (id, project_id, title, description) VALUES (?, ?, ?, ?)",
    );
    for (const epic of project.epics) {
      insertEpic.run(epic.id, projectId, epic.title, epic.description ?? null);
    }
  }

  const insertPersona = db.prepare(
    "INSERT INTO personas (project_id, alias, role, rules_json) VALUES (?, ?, ?, ?)",
  );
  const insertPersonaRepo = db.prepare(
    "INSERT INTO persona_repos (project_id, alias, repo) VALUES (?, ?, ?)",
  );
  for (const persona of project.personas) {
    insertPersona.run(projectId, persona.alias, persona.role, JSON.stringify(persona.rules));
    for (const repo of persona.repos) insertPersonaRepo.run(projectId, persona.alias, repo);
  }

  const insertDoc = db.prepare(
    `INSERT INTO documents
      (project_id, slug, title, kind, version, updated_by, updated_at, size, content, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const doc of project.documents) {
    insertDoc.run(
      projectId,
      doc.slug,
      doc.title,
      doc.kind,
      doc.version,
      doc.updated_by,
      doc.updated_at,
      doc.size,
      doc.content,
      doc.archived_at ?? null,
    );
  }

  const hasTaskArchivedCol = tableColumnNames(db, "tasks").has("archived_at");
  const insertTask = hasTaskArchivedCol
    ? db.prepare(
        `INSERT INTO tasks
          (id, project_id, epic_id, title, instruction, status, target, role, persona,
           requires_approval, revision, stale, feedback,
           lease_json, branch_json, handoff_json, review_json, blocker_json, integrated_commit_json,
           scope_files_json, verify_command, doc_refs_json, archived_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
    : db.prepare(
        `INSERT INTO tasks
          (id, project_id, epic_id, title, instruction, status, target, role, persona,
           requires_approval, revision, stale, feedback,
           lease_json, branch_json, handoff_json, review_json, blocker_json, integrated_commit_json,
           scope_files_json, verify_command, doc_refs_json, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
  const insertDep = db.prepare(
    "INSERT INTO task_deps (project_id, task_id, depends_on) VALUES (?, ?, ?)",
  );
  for (const task of project.tasks) {
    const ser = serializeTask(task);
    if (hasTaskArchivedCol) {
      insertTask.run(
        task.id,
        projectId,
        ser.epicId,
        ser.title,
        ser.instruction,
        ser.status,
        ser.target,
        ser.role,
        ser.persona,
        ser.requiresApproval,
        ser.revision,
        ser.stale,
        ser.feedback,
        ser.leaseJson,
        ser.branchJson,
        ser.handoffJson,
        ser.reviewJson,
        ser.blockerJson,
        ser.integratedCommitJson,
        ser.scopeFilesJson,
        ser.verifyCommand,
        ser.docRefsJson,
        ser.archivedAt,
        ser.position,
      );
    } else {
      insertTask.run(
        task.id,
        projectId,
        ser.epicId,
        ser.title,
        ser.instruction,
        ser.status,
        ser.target,
        ser.role,
        ser.persona,
        ser.requiresApproval,
        ser.revision,
        ser.stale,
        ser.feedback,
        ser.leaseJson,
        ser.branchJson,
        ser.handoffJson,
        ser.reviewJson,
        ser.blockerJson,
        ser.integratedCommitJson,
        ser.scopeFilesJson,
        ser.verifyCommand,
        ser.docRefsJson,
        ser.position,
      );
    }
    for (const dep of task.dependencies) insertDep.run(projectId, task.id, dep);
  }

  const insertPerm = db.prepare(
    "INSERT INTO permissions (project_id, action, principal) VALUES (?, ?, ?)",
  );
  for (const perm of project.permissions ?? []) {
    insertPerm.run(projectId, perm.action, perm.principal);
  }

  const insertRoot = db.prepare(
    "INSERT INTO workspace_roots (id, project_id, path, owner_persona, label) VALUES (?, ?, ?, ?, ?)",
  );
  for (const root of project.workspace_roots ?? []) {
    insertRoot.run(root.id, projectId, root.path, root.ownerPersona, root.label ?? null);
  }

  const insertPlatform = db.prepare(
    "INSERT INTO platform_setup (project_id, platform, installed) VALUES (?, ?, 1)",
  );
  for (const platform of project.platform_setup ?? []) {
    insertPlatform.run(projectId, platform);
  }

  db.prepare("INSERT INTO session_prefs (project_id, locale) VALUES (?, ?)").run(
    projectId,
    project.session_prefs?.locale ?? null,
  );
}
