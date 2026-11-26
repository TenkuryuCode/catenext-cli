import type { DatabaseSync } from "node:sqlite";

export interface NewTaskEvent {
  task_id: string;
  event: string;
  actor: string;
  note?: string | null;
  detail?: Record<string, unknown> | null;
  created_at: string;
}

export interface TaskEventRecord {
  id: number;
  project_id: string;
  task_id: string;
  task_title: string | null;
  event: string;
  actor: string;
  note: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface ReadTaskEventsOptions {
  taskId?: string;
  event?: string;
  actor?: string;
  /** Inclusive lower bound, normalized to UTC ISO timestamp by the caller. */
  since?: string;
  limit?: number;
}

export function insertTaskEvents(
  db: DatabaseSync,
  projectId: string,
  events: readonly NewTaskEvent[],
): void {
  if (events.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO task_events (project_id, task_id, event, actor, note, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ev of events) {
    stmt.run(
      projectId,
      ev.task_id,
      ev.event,
      ev.actor,
      ev.note ?? null,
      ev.detail ? JSON.stringify(ev.detail) : null,
      ev.created_at,
    );
  }
}

export function queryTaskEvents(
  db: DatabaseSync,
  projectId: string,
  options: ReadTaskEventsOptions = {},
): TaskEventRecord[] {
  const limit = Math.max(1, Math.min(200, options.limit ?? 20));
  const where = ["e.project_id = ?"];
  const params: Array<string | number> = [projectId];
  for (const [condition, value] of [
    ["e.task_id = ?", options.taskId],
    ["e.event = ?", options.event],
    ["e.actor = ?", options.actor],
    ["e.created_at >= ?", options.since],
  ] as const) {
    if (value === undefined) continue;
    where.push(condition);
    params.push(value);
  }
  const rows = db
    .prepare(
      `SELECT e.id, e.project_id, e.task_id, t.title AS task_title,
              e.event, e.actor, e.note, e.detail_json, e.created_at
       FROM task_events e
       LEFT JOIN tasks t ON t.project_id = e.project_id AND t.id = e.task_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: number;
    project_id: string;
    task_id: string;
    task_title: string | null;
    event: string;
    actor: string;
    note: string | null;
    detail_json: string | null;
    created_at: string;
  }>;

  return rows.map((row) => {
    let detail: Record<string, unknown> | null = null;
    if (row.detail_json) {
      try {
        const parsed = JSON.parse(row.detail_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        detail = null;
      }
    }
    return {
      id: Number(row.id),
      project_id: row.project_id,
      task_id: row.task_id,
      task_title: row.task_title ?? null,
      event: row.event,
      actor: row.actor,
      note: row.note ?? null,
      detail,
      created_at: row.created_at,
    };
  });
}
