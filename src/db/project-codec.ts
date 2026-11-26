import type { DatabaseSync } from "node:sqlite";
import type { LocalPermission, LocalProject, LocalRoot, LocalTask } from "../local-state.js";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

export function loadProject(db: DatabaseSync, projectId: string): LocalProject {
  const project = emptyExtendedProject();
  const exists = db.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").get(projectId) as
    | { ok: number }
    | undefined;
  if (!exists) return project;

  project.repos = (
    db
      .prepare("SELECT repo FROM project_repos WHERE project_id = ? ORDER BY repo")
      .all(projectId) as {
      repo: string;
    }[]
  ).map((row) => row.repo);

  project.epics = (
    db
      .prepare("SELECT id, title, description FROM epics WHERE project_id = ? ORDER BY title, id")
      .all(projectId) as { id: string; title: string; description: string | null }[]
  ).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
  }));

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

  project.documents = (
    db
      .prepare(
        `SELECT slug, title, kind, version, updated_by, updated_at, size, content
         FROM documents WHERE project_id = ? ORDER BY slug`,
      )
      .all(projectId) as {
      slug: string;
      title: string;
      kind: string;
      version: number;
      updated_by: string;
      updated_at: string;
      size: number;
      content: string;
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
      `SELECT id, epic_id, title, instruction, status, target, role, persona,
              requires_approval, revision, stale, feedback,
              lease_json, branch_json, handoff_json, review_json, blocker_json
       FROM tasks WHERE project_id = ? ORDER BY rowid`,
    )
    .all(projectId) as Record<string, unknown>[];

  project.tasks = taskRows.map((row) => {
    const task: LocalTask = {
      id: String(row.id),
      epicId: String(row.epic_id),
      title: String(row.title),
      instruction: String(row.instruction),
      status: row.status as LocalTask["status"],
      dependencies: depsByTask.get(String(row.id)) ?? [],
      target: (row.target as string | null) ?? null,
      role: (row.role as string | null) ?? null,
      persona: (row.persona as string | null) ?? null,
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
    return task;
  });

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

  return project;
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

  const insertEpic = db.prepare(
    "INSERT INTO epics (id, project_id, title, description) VALUES (?, ?, ?, ?)",
  );
  for (const epic of project.epics) {
    insertEpic.run(epic.id, projectId, epic.title, epic.description ?? null);
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
      (project_id, slug, title, kind, version, updated_by, updated_at, size, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
  }

  const insertTask = db.prepare(
    `INSERT INTO tasks
      (id, project_id, epic_id, title, instruction, status, target, role, persona,
       requires_approval, revision, stale, feedback,
       lease_json, branch_json, handoff_json, review_json, blocker_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDep = db.prepare(
    "INSERT INTO task_deps (project_id, task_id, depends_on) VALUES (?, ?, ?)",
  );
  for (const task of project.tasks) {
    insertTask.run(
      task.id,
      projectId,
      task.epicId,
      task.title,
      task.instruction,
      task.status,
      task.target,
      task.role,
      task.persona,
      task.requiresApproval ? 1 : 0,
      task.revision,
      task.stale ? 1 : 0,
      task.feedback ?? null,
      task.lease ? JSON.stringify(task.lease) : null,
      task.branch ? JSON.stringify(task.branch) : null,
      task.handoff ? JSON.stringify(task.handoff) : null,
      task.review ? JSON.stringify(task.review) : null,
      task.blocker ? JSON.stringify(task.blocker) : null,
    );
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
