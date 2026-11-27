/** SQLite DDL for local Catenext orchestration (schema version 9). */

export const SCHEMA_VERSION = 9;

export const EPIC_RUNS_SQL = `
CREATE TABLE IF NOT EXISTS epic_runs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  state_json TEXT NOT NULL,
  PRIMARY KEY (project_id, epic_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_epic_runs_open_repo
  ON epic_runs(project_id, repo) WHERE closed = 0;
`;

export const CODE_SEARCH_FILES_SQL = `
CREATE TABLE IF NOT EXISTS code_search_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_id TEXT,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content TEXT NOT NULL,
  UNIQUE (project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_code_search_files_project
  ON code_search_files(project_id);
`;

export const CODE_SEARCH_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS code_search_fts USING fts5(
  path,
  content,
  tokens,
  tokenize = 'unicode61'
);
`;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_repos (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  PRIMARY KEY (project_id, repo)
);

CREATE TABLE IF NOT EXISTS epics (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  summary_json TEXT,
  archived_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS personas (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  role TEXT NOT NULL,
  rules_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (project_id, alias)
);

CREATE TABLE IF NOT EXISTS persona_repos (
  project_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  repo TEXT NOT NULL,
  PRIMARY KEY (project_id, alias, repo),
  FOREIGN KEY (project_id, alias) REFERENCES personas(project_id, alias) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS documents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  size INTEGER NOT NULL,
  content TEXT NOT NULL,
  archived_at TEXT,
  PRIMARY KEY (project_id, slug)
);

CREATE TABLE IF NOT EXISTS tasks (
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
  integrated_commit_json TEXT,
  scope_files_json TEXT,
  verify_command TEXT,
  doc_refs_json TEXT,
  archived_at TEXT,
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS task_deps (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (project_id, task_id, depends_on),
  FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS permissions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  principal TEXT NOT NULL,
  PRIMARY KEY (project_id, action, principal)
);

CREATE TABLE IF NOT EXISTS workspace_roots (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  owner_persona TEXT,
  label TEXT,
  UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS platform_setup (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, platform)
);

CREATE TABLE IF NOT EXISTS session_prefs (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  locale TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_id TEXT,
  path TEXT NOT NULL,
  hash TEXT,
  mtime_ms INTEGER,
  UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  from_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  to_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  from_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  to_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  label TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_task_events_project_task_created
  ON task_events(project_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(project_id, name);
CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(project_id, path);

${CODE_SEARCH_FILES_SQL}
${EPIC_RUNS_SQL}
`;
