import type { DatabaseSync } from "node:sqlite";
import { briefText, IdSchema } from "@catenext/shared";
import { z } from "zod";
import { LocalServiceError } from "./errors.js";
import {
  type EpicSummaryTaskRef,
  type LocalEpic,
  type LocalProject,
  type LocalTask,
  type VersionedEpicSummary,
  VersionedEpicSummarySchema,
} from "./local-state.js";

/** Maximum UTF-8 serialized JSON byte size for a stored versioned epic summary. */
export const EPIC_SUMMARY_MAX_BYTES = 2048;

export const UpsertEpicSummaryInput = z.object({
  epic_id: IdSchema,
  overview: z.string().trim().min(1).max(600).optional(),
  key_decisions: z.array(z.string().trim().min(1).max(240)).max(12).optional(),
  outcomes: z.array(z.string().trim().min(1).max(240)).max(12).optional(),
  unresolved_risks: z.array(z.string().trim().min(1).max(240)).max(10).optional(),
  /**
   * Optimistic concurrency guard. When provided, must match current summary version (0 = none).
   * When omitted, version auto-bumps from current version.
   */
  expected_version: z.number().int().min(0).optional(),
});
export type UpsertEpicSummaryInputType = z.infer<typeof UpsertEpicSummaryInput>;

export type ArchiveBlockerCode =
  | "already_archived"
  | "empty_epic"
  | "live_leases"
  | "non_terminal_tasks"
  | "active_cross_epic_dependencies";

export interface ArchiveBlocker {
  code: ArchiveBlockerCode;
  message: string;
  task_ids: string[];
}

export interface EpicRetentionCounts {
  task_count: number;
  handoff_count: number;
  event_count: number;
}

export interface EpicRetentionBytes {
  tasks_bytes: number;
  handoffs_bytes: number;
  events_bytes: number;
  summary_bytes: number;
  total_estimated_bytes: number;
}

export interface EpicArchivePreview {
  epic_id: string;
  title: string;
  dry_run: boolean;
  eligible: boolean;
  already_archived: boolean;
  blockers: ArchiveBlocker[];
  counts: EpicRetentionCounts;
  estimated_payload_bytes: number;
  bytes: EpicRetentionBytes;
  summary_version: number | null;
  /** Archival is logical/soft by default and does not claim physical SQLite file shrinkage. */
  physical_file_shrunk: false;
}

export interface EpicArchiveResult extends EpicArchivePreview {
  archived: boolean;
  archived_at: string | null;
  summary: VersionedEpicSummary | null;
}

export interface EpicRestoreResult {
  epic_id: string;
  title: string;
  restored: true;
  restored_at: string;
  restored_task_count: number;
  summary: VersionedEpicSummary | null;
}

export function isEpicArchived(epic: Pick<LocalEpic, "archived_at">): boolean {
  return typeof epic.archived_at === "string" && epic.archived_at.length > 0;
}

export function isTaskArchived(
  task: Pick<LocalTask, "epicId" | "archived_at">,
  epicsById?: ReadonlyMap<string, Pick<LocalEpic, "archived_at">>,
): boolean {
  if (typeof task.archived_at === "string" && task.archived_at.length > 0) return true;
  const epic = epicsById?.get(task.epicId);
  return epic ? isEpicArchived(epic) : false;
}

export function filterVisibleEpics<T extends Pick<LocalEpic, "archived_at">>(
  epics: readonly T[],
  includeArchived = false,
): T[] {
  if (includeArchived) return [...epics];
  return epics.filter((epic) => !isEpicArchived(epic));
}

export function filterVisibleTasks<T extends Pick<LocalTask, "epicId" | "archived_at">>(
  tasks: readonly T[],
  epics: readonly Pick<LocalEpic, "id" | "archived_at">[],
  includeArchived = false,
): T[] {
  if (includeArchived) return [...tasks];
  const epicsById = new Map(epics.map((epic) => [epic.id, epic]));
  return tasks.filter((task) => !isTaskArchived(task, epicsById));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function dedupeTrimmed(items: readonly string[], maxItems: number, maxLen = 240): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const cleaned = briefText(raw.trim(), maxLen);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function synthesizeOverview(epic: LocalEpic, epicTasks: readonly LocalTask[]): string {
  const counts = new Map<string, number>();
  for (const task of epicTasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  const statusSummary =
    counts.size > 0
      ? [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ")
      : "0 tasks";
  const base = epic.description ? `${epic.title}: ${epic.description}` : epic.title;
  return briefText(`${base} (${statusSummary})`, 480);
}

function extractTaskRefs(epicTasks: readonly LocalTask[]): EpicSummaryTaskRef[] {
  return epicTasks.slice(0, 20).map((task) => {
    const commitSha = task.integrated_commit?.sha ?? task.handoff?.last_commit_hash ?? null;
    const branch =
      task.integrated_commit?.branch ?? task.handoff?.git_branch ?? task.branch?.name ?? null;
    return {
      task_id: task.id,
      title: briefText(task.title, 140),
      status: task.status,
      ...(commitSha ? { commit_sha: commitSha } : {}),
      ...(branch ? { branch } : {}),
    };
  });
}

function extractDecisions(epicTasks: readonly LocalTask[]): string[] {
  const raw: string[] = [];
  for (const task of epicTasks) {
    for (const decision of task.handoff?.key_decisions ?? []) {
      raw.push(decision);
    }
  }
  return dedupeTrimmed(raw, 10, 220);
}

function extractOutcomes(epicTasks: readonly LocalTask[]): string[] {
  const raw: string[] = [];
  for (const task of epicTasks) {
    if (task.handoff?.notes_for_next_agent) {
      raw.push(`${task.title}: ${task.handoff.notes_for_next_agent}`);
    } else if (task.status === "DONE") {
      raw.push(`${task.title} (DONE)`);
    }
  }
  return dedupeTrimmed(raw, 10, 220);
}

function extractUnresolvedRisks(epicTasks: readonly LocalTask[]): string[] {
  const raw: string[] = [];
  for (const task of epicTasks) {
    if (task.status === "BLOCKED" && task.blocker) {
      raw.push(`[${task.blocker.category}] ${task.title}: ${task.blocker.reason}`);
    } else if (task.status === "REVISION_REQUESTED" && task.feedback) {
      raw.push(`[revision] ${task.title}: ${task.feedback}`);
    } else if (task.stale) {
      raw.push(`[stale] ${task.title} needs downstream re-verification`);
    } else if (task.status !== "DONE") {
      raw.push(`[${task.status}] ${task.title} pending completion`);
    }
  }
  return dedupeTrimmed(raw, 8, 220);
}

/**
 * Enforce `EPIC_SUMMARY_MAX_BYTES` on the serialized JSON representation of `VersionedEpicSummary`,
 * setting `byte_length` to the exact UTF-8 byte length of the resulting JSON payload.
 */
export function boundEpicSummary(
  draft: Omit<VersionedEpicSummary, "byte_length">,
  maxBytes: number = EPIC_SUMMARY_MAX_BYTES,
): VersionedEpicSummary {
  const working: VersionedEpicSummary = {
    ...draft,
    overview: briefText(draft.overview, 600),
    key_decisions: [...draft.key_decisions],
    task_refs: [...draft.task_refs],
    outcomes: [...draft.outcomes],
    unresolved_risks: [...draft.unresolved_risks],
    byte_length: 0,
  };

  const measure = (candidate: VersionedEpicSummary): number => {
    let size = utf8Bytes(JSON.stringify(candidate));
    while (candidate.byte_length !== size) {
      candidate.byte_length = size;
      size = utf8Bytes(JSON.stringify(candidate));
    }
    return size;
  };

  let size = measure(working);
  if (size <= maxBytes) return working;

  working.truncated = true;

  while (size > maxBytes) {
    if (working.task_refs.length > 3) {
      working.task_refs.pop();
    } else if (working.outcomes.length > 2) {
      working.outcomes.pop();
    } else if (working.key_decisions.length > 2) {
      working.key_decisions.pop();
    } else if (working.unresolved_risks.length > 2) {
      working.unresolved_risks.pop();
    } else if (working.overview.length > 140) {
      working.overview = briefText(working.overview, Math.max(80, working.overview.length - 80));
    } else if (working.task_refs.length > 1) {
      working.task_refs.pop();
    } else if (working.outcomes.length > 0) {
      working.outcomes.pop();
    } else if (working.key_decisions.length > 0) {
      working.key_decisions.pop();
    } else if (working.unresolved_risks.length > 0) {
      working.unresolved_risks.pop();
    } else {
      working.task_refs = [];
      working.overview = briefText(working.overview, 80);
      size = measure(working);
      break;
    }
    size = measure(working);
  }

  return working;
}

/** Check whether an epic's stored summary is missing, invalid, or out of sync with current tasks. */
export function isEpicSummaryStale(epic: LocalEpic, allTasks: readonly LocalTask[]): boolean {
  if (!epic.summary) return true;
  const parsed = VersionedEpicSummarySchema.safeParse(epic.summary);
  if (!parsed.success) return true;
  const epicTasks = allTasks.filter((t) => t.epicId === epic.id);
  const doneCount = epicTasks.filter((t) => t.status === "DONE").length;
  return (
    parsed.data.source_task_count !== epicTasks.length || parsed.data.done_task_count !== doneCount
  );
}

/**
 * Build or update a versioned epic summary from current tasks and optional user/orchestrator inputs.
 * Supports optimistic concurrency via `expected_version` or auto-increments version when omitted.
 */
export function upsertVersionedEpicSummary(
  epic: LocalEpic,
  allTasks: readonly LocalTask[],
  options: {
    nowIso?: string;
    overview?: string;
    key_decisions?: readonly string[];
    outcomes?: readonly string[];
    unresolved_risks?: readonly string[];
    expected_version?: number;
  } = {},
): VersionedEpicSummary {
  const currentSummary =
    epic.summary && VersionedEpicSummarySchema.safeParse(epic.summary).success
      ? epic.summary
      : null;
  const currentVersion = currentSummary?.version ?? 0;

  if (options.expected_version !== undefined && options.expected_version !== currentVersion) {
    throw new LocalServiceError(
      "epic_summary_version_conflict",
      `Ringkasan epic "${epic.title}" saat ini versi ${currentVersion} (expected_version=${options.expected_version}). Baca ulang lalu kirim versi yang sesuai.`,
      { current_version: currentVersion, expected_version: options.expected_version },
    );
  }

  const epicTasks = allTasks.filter((t) => t.epicId === epic.id);
  const doneCount = epicTasks.filter((t) => t.status === "DONE").length;
  const nowIso = options.nowIso ?? new Date().toISOString();

  const overview = options.overview
    ? briefText(options.overview, 600)
    : synthesizeOverview(epic, epicTasks);
  const keyDecisions = options.key_decisions
    ? dedupeTrimmed(options.key_decisions, 12, 240)
    : extractDecisions(epicTasks);
  const outcomes = options.outcomes
    ? dedupeTrimmed(options.outcomes, 12, 240)
    : extractOutcomes(epicTasks);
  const unresolvedRisks = options.unresolved_risks
    ? dedupeTrimmed(options.unresolved_risks, 10, 240)
    : extractUnresolvedRisks(epicTasks);
  const taskRefs = extractTaskRefs(epicTasks);

  const summary = boundEpicSummary({
    version: currentVersion + 1,
    updated_at: nowIso,
    source_task_count: epicTasks.length,
    done_task_count: doneCount,
    overview,
    key_decisions: keyDecisions,
    task_refs: taskRefs,
    outcomes,
    unresolved_risks: unresolvedRisks,
  });

  epic.summary = summary;
  return summary;
}

/**
 * Format a compact epic summary excerpt for `claim_task` (`context_pack.epic_summary`) or
 * `get_project_context` (`epic_summary`), falling back safely when summary is stale or missing.
 */
export function resolveEpicSummaryText(
  epic: LocalEpic,
  allTasks: readonly LocalTask[],
  maxChars = 240,
): string {
  try {
    const epicTasks = allTasks.filter((t) => t.epicId === epic.id);
    const validSummary =
      epic.summary && VersionedEpicSummarySchema.safeParse(epic.summary).success
        ? epic.summary
        : null;
    const stale = !validSummary || isEpicSummaryStale(epic, allTasks);

    if (validSummary && !stale) {
      const parts: string[] = [`[v${validSummary.version}] ${validSummary.overview}`];
      if (validSummary.key_decisions.length > 0) {
        parts.push(`Decisions: ${validSummary.key_decisions.slice(0, 2).join("; ")}`);
      }
      if (validSummary.outcomes.length > 0) {
        parts.push(`Outcomes: ${validSummary.outcomes.slice(0, 2).join("; ")}`);
      }
      if (validSummary.unresolved_risks.length > 0) {
        parts.push(`Risks: ${validSummary.unresolved_risks.slice(0, 2).join("; ")}`);
      }
      return briefText(parts.join(" | "), maxChars);
    }

    // Safe fallback when missing or stale: synthesize compact summary without mutating DB.
    const base = `${epic.title}${epic.description ? `: ${epic.description}` : ""}`;
    if (!validSummary || epicTasks.length === 0) {
      return briefText(base, maxChars);
    }
    const decisions = extractDecisions(epicTasks);
    const risks = extractUnresolvedRisks(epicTasks);
    const parts: string[] = [validSummary ? `[v${validSummary.version}·stale] ${base}` : base];
    if (decisions.length > 0) {
      parts.push(`Decisions: ${decisions.slice(0, 2).join("; ")}`);
    }
    if (risks.length > 0) {
      parts.push(`Risks: ${risks.slice(0, 2).join("; ")}`);
    }
    return briefText(parts.join(" | "), maxChars);
  } catch {
    return briefText(`${epic.title}${epic.description ? `: ${epic.description}` : ""}`, maxChars);
  }
}

/** Read-only calculation of item counts and UTF-8 serialized payload bytes for an epic. */
export function estimateEpicRetentionPayload(
  db: DatabaseSync,
  projectId: string,
  epic: LocalEpic,
  allTasks: readonly LocalTask[],
): { counts: EpicRetentionCounts; bytes: EpicRetentionBytes } {
  const epicTasks = allTasks.filter((t) => t.epicId === epic.id);
  let tasksBytes = 0;
  let handoffsBytes = 0;
  let handoffCount = 0;

  for (const task of epicTasks) {
    tasksBytes += utf8Bytes(JSON.stringify(task));
    if (task.handoff) {
      handoffCount += 1;
      handoffsBytes += utf8Bytes(JSON.stringify(task.handoff));
      if (task.review) handoffsBytes += utf8Bytes(JSON.stringify(task.review));
      if (task.integrated_commit) {
        handoffsBytes += utf8Bytes(JSON.stringify(task.integrated_commit));
      }
    }
  }

  let eventCount = 0;
  let eventsBytes = 0;
  if (epicTasks.length > 0) {
    const placeholders = epicTasks.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, task_id, event, actor, note, detail_json, created_at
         FROM task_events
         WHERE project_id = ? AND task_id IN (${placeholders})`,
      )
      .all(projectId, ...epicTasks.map((t) => t.id)) as Array<{
      id: number;
      task_id: string;
      event: string;
      actor: string;
      note: string | null;
      detail_json: string | null;
      created_at: string;
    }>;
    eventCount = rows.length;
    for (const row of rows) {
      eventsBytes += utf8Bytes(JSON.stringify(row));
    }
  }

  const summaryBytes = epic.summary ? utf8Bytes(JSON.stringify(epic.summary)) : 0;

  return {
    counts: {
      task_count: epicTasks.length,
      handoff_count: handoffCount,
      event_count: eventCount,
    },
    bytes: {
      tasks_bytes: tasksBytes,
      handoffs_bytes: handoffsBytes,
      events_bytes: eventsBytes,
      summary_bytes: summaryBytes,
      total_estimated_bytes: tasksBytes + eventsBytes,
    },
  };
}

/** Evaluate all safety invariants that must pass before an epic can be archived. */
export function evaluateEpicArchiveBlockers(
  project: LocalProject,
  epic: LocalEpic,
): ArchiveBlocker[] {
  const blockers: ArchiveBlocker[] = [];
  if (isEpicArchived(epic)) {
    blockers.push({
      code: "already_archived",
      message: `Epic "${epic.title}" sudah diarsipkan pada ${epic.archived_at}.`,
      task_ids: [],
    });
  }

  const epicTasks = project.tasks.filter((t) => t.epicId === epic.id);
  const epicTaskIds = new Set(epicTasks.map((t) => t.id));

  if (epicTasks.length === 0) {
    blockers.push({
      code: "empty_epic",
      message: `Epic "${epic.title}" belum memiliki task untuk diarsipkan.`,
      task_ids: [],
    });
    return blockers;
  }

  const leasedTasks = epicTasks.filter((t) => Boolean(t.lease) || Boolean(t.review?.lease));
  if (leasedTasks.length > 0) {
    blockers.push({
      code: "live_leases",
      message: `Epic "${epic.title}" memiliki ${leasedTasks.length} task dengan lease aktif; lepas atau selesaikan dulu.`,
      task_ids: leasedTasks.map((t) => t.id),
    });
  }

  const nonTerminalTasks = epicTasks.filter((t) => t.status !== "DONE");
  if (nonTerminalTasks.length > 0) {
    blockers.push({
      code: "non_terminal_tasks",
      message: `Epic "${epic.title}" memiliki ${nonTerminalTasks.length} task yang belum DONE (${nonTerminalTasks.map((t) => `${t.id}:${t.status}`).join(", ")}).`,
      task_ids: nonTerminalTasks.map((t) => t.id),
    });
  }

  const epicsById = new Map(project.epics.map((e) => [e.id, e]));
  const tasksById = new Map(project.tasks.map((t) => [t.id, t]));
  const crossEpicTaskIds = new Set<string>();

  // 1. Active (non-archived, non-DONE or leased) tasks in other epics depending on tasks in this epic.
  for (const other of project.tasks) {
    if (other.epicId === epic.id) continue;
    if (isTaskArchived(other, epicsById)) continue;
    const dependsOnEpic = other.dependencies.some((depId) => epicTaskIds.has(depId));
    if (dependsOnEpic && (other.status !== "DONE" || Boolean(other.lease))) {
      crossEpicTaskIds.add(other.id);
    }
  }

  // 2. Tasks in this epic depending on non-DONE or leased tasks in other epics.
  for (const task of epicTasks) {
    for (const depId of task.dependencies) {
      if (epicTaskIds.has(depId)) continue;
      const depTask = tasksById.get(depId);
      if (depTask && (depTask.status !== "DONE" || Boolean(depTask.lease))) {
        crossEpicTaskIds.add(depTask.id);
      }
    }
  }

  if (crossEpicTaskIds.size > 0) {
    blockers.push({
      code: "active_cross_epic_dependencies",
      message: `Epic "${epic.title}" memiliki dependensi lintas-epic yang masih aktif (${[...crossEpicTaskIds].join(", ")}).`,
      task_ids: [...crossEpicTaskIds],
    });
  }

  return blockers;
}

/** Read-only dry-run archive preview for an epic. */
export function previewEpicArchive(
  db: DatabaseSync,
  projectId: string,
  project: LocalProject,
  epicId: string,
): EpicArchivePreview {
  const epic = project.epics.find((e) => e.id === epicId);
  if (!epic) {
    throw new LocalServiceError("not_found", `Epic "${epicId}" tidak ditemukan di proyek ini.`);
  }
  const blockers = evaluateEpicArchiveBlockers(project, epic);
  const { counts, bytes } = estimateEpicRetentionPayload(db, projectId, epic, project.tasks);
  return {
    epic_id: epic.id,
    title: epic.title,
    dry_run: true,
    eligible: blockers.length === 0,
    already_archived: isEpicArchived(epic),
    blockers,
    counts,
    estimated_payload_bytes: bytes.total_estimated_bytes,
    bytes,
    summary_version: epic.summary?.version ?? null,
    physical_file_shrunk: false,
  };
}

/**
 * Archive a completed, inactive epic (or perform a read-only dry-run when `options.dry_run` is true).
 * Never archives epics with live leases, non-DONE tasks, or active cross-epic dependencies.
 * Automatically generates or refreshes the versioned epic summary before archiving.
 */
export function archiveEpicInProject(
  db: DatabaseSync,
  projectId: string,
  project: LocalProject,
  epicId: string,
  options: { dry_run?: boolean; nowIso?: string } = {},
): EpicArchiveResult {
  const preview = previewEpicArchive(db, projectId, project, epicId);
  const epic = project.epics.find((e) => e.id === epicId);
  if (!epic) {
    throw new LocalServiceError("not_found", `Epic "${epicId}" tidak ditemukan di proyek ini.`);
  }
  if (options.dry_run) {
    return {
      ...preview,
      dry_run: true,
      archived: false,
      archived_at: epic.archived_at ?? null,
      summary: epic.summary ?? null,
    };
  }

  if (!preview.eligible) {
    const primary = preview.blockers[0] ?? {
      code: "non_terminal_tasks" as const,
      message: `Epic "${epic.title}" belum memenuhi syarat pengarsipan.`,
      task_ids: [],
    };
    const errorCodeMap: Record<ArchiveBlockerCode, string> = {
      already_archived: "already_archived",
      empty_epic: "epic_empty",
      live_leases: "epic_has_active_lease",
      non_terminal_tasks: "epic_tasks_not_done",
      active_cross_epic_dependencies: "epic_has_active_dependencies",
    };
    throw new LocalServiceError(errorCodeMap[primary.code], primary.message, {
      epic_id: epicId,
      blockers: preview.blockers,
    });
  }

  const nowIso = options.nowIso ?? new Date().toISOString();

  // Ensure a fresh versioned epic summary is stored before archiving.
  if (!epic.summary || isEpicSummaryStale(epic, project.tasks)) {
    upsertVersionedEpicSummary(epic, project.tasks, { nowIso });
  }

  epic.archived_at = nowIso;
  for (const task of project.tasks) {
    if (task.epicId === epic.id) {
      task.archived_at = nowIso;
    }
  }

  const refreshedEstimate = estimateEpicRetentionPayload(db, projectId, epic, project.tasks);

  return {
    epic_id: epic.id,
    title: epic.title,
    dry_run: false,
    eligible: true,
    already_archived: false,
    blockers: [],
    estimated_payload_bytes: refreshedEstimate.bytes.total_estimated_bytes,
    counts: refreshedEstimate.counts,
    bytes: refreshedEstimate.bytes,
    summary_version: epic.summary?.version ?? null,
    physical_file_shrunk: false,
    archived: true,
    archived_at: nowIso,
    summary: epic.summary ?? null,
  };
}

/**
 * Restore a previously archived epic and all its tasks back to active visibility
 * without losing its versioned epic summary, dependencies, handoffs, or audit history.
 */
export function restoreEpicInProject(
  project: LocalProject,
  epicId: string,
  options: { nowIso?: string } = {},
): EpicRestoreResult {
  const epic = project.epics.find((e) => e.id === epicId);
  if (!epic) {
    throw new LocalServiceError("not_found", `Epic "${epicId}" tidak ditemukan di proyek ini.`);
  }
  if (!isEpicArchived(epic)) {
    throw new LocalServiceError("not_archived", `Epic "${epic.title}" tidak sedang diarsipkan.`);
  }

  const nowIso = options.nowIso ?? new Date().toISOString();
  delete epic.archived_at;
  let restoredTaskCount = 0;
  for (const task of project.tasks) {
    if (task.epicId === epic.id) {
      delete task.archived_at;
      restoredTaskCount += 1;
    }
  }

  return {
    epic_id: epic.id,
    title: epic.title,
    restored: true,
    restored_at: nowIso,
    restored_task_count: restoredTaskCount,
    summary: epic.summary ?? null,
  };
}
