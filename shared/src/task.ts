import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, RepoNameSchema, RoleSchema } from "./common.js";
import { HandoffSummarySchema } from "./handoff.js";

/**
 * Tujuh status task. "Stale" sengaja BUKAN status: ia adalah flag `is_stale` yang
 * menempel di atas status apa pun (lihat TaskSchema).
 */
export const TASK_STATUSES = [
  "DRAFT",
  "TODO",
  "IN_PROGRESS",
  "NEEDS_REVIEW",
  "REVISION_REQUESTED",
  "BLOCKED",
  "DONE",
] as const;

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Kolom Kanban di Web UI (DRAFT tinggal di layar review rencana, bukan di board). */
export const KANBAN_STATUSES = TASK_STATUSES.filter(
  (s): s is Exclude<TaskStatus, "DRAFT"> => s !== "DRAFT",
);

/** Status yang boleh diambil agen lewat claim_task. */
export const CLAIMABLE_STATUSES = [
  "TODO",
  "REVISION_REQUESTED",
] as const satisfies readonly TaskStatus[];

/**
 * Event yang menggerakkan task. Setiap event punya pelaku yang jelas:
 * - human: dari Web UI
 * - agent: dari tool MCP / CLI
 * - system: dari server (mis. lease habis)
 */
export const TASK_EVENTS = [
  "approve_plan", // human: DRAFT -> TODO
  "return_to_draft", // human: TODO -> DRAFT
  "claim", // agent: TODO | REVISION_REQUESTED -> IN_PROGRESS
  "complete", // agent: IN_PROGRESS -> DONE, atau NEEDS_REVIEW bila requires_approval
  "report_blocker", // agent: IN_PROGRESS -> BLOCKED
  "release", // agent: IN_PROGRESS -> TODO (melepas lock tanpa blocker)
  "lease_expired", // system: IN_PROGRESS -> TODO
  "approve", // human: NEEDS_REVIEW -> DONE
  "request_revision", // human: NEEDS_REVIEW | DONE -> REVISION_REQUESTED
  "unblock", // human: BLOCKED -> TODO
] as const;

export const TaskEventSchema = z.enum(TASK_EVENTS);
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export type TaskActor = "human" | "agent" | "system";

export const TASK_EVENT_ACTOR: Record<TaskEvent, TaskActor> = {
  approve_plan: "human",
  return_to_draft: "human",
  claim: "agent",
  complete: "agent",
  report_blocker: "agent",
  release: "agent",
  lease_expired: "system",
  approve: "human",
  request_revision: "human",
  unblock: "human",
};

type TransitionTable = Record<TaskEvent, Partial<Record<TaskStatus, TaskStatus>>>;

const TRANSITIONS: TransitionTable = {
  approve_plan: { DRAFT: "TODO" },
  return_to_draft: { TODO: "DRAFT" },
  claim: { TODO: "IN_PROGRESS", REVISION_REQUESTED: "IN_PROGRESS" },
  // Target "DONE" diganti NEEDS_REVIEW di transition() bila requires_approval.
  complete: { IN_PROGRESS: "DONE" },
  report_blocker: { IN_PROGRESS: "BLOCKED" },
  release: { IN_PROGRESS: "TODO" },
  lease_expired: { IN_PROGRESS: "TODO" },
  approve: { NEEDS_REVIEW: "DONE" },
  request_revision: { NEEDS_REVIEW: "REVISION_REQUESTED", DONE: "REVISION_REQUESTED" },
  unblock: { BLOCKED: "TODO" },
};

export interface TransitionContext {
  /** Approval gate: complete diarahkan ke NEEDS_REVIEW, bukan DONE. */
  requiresApproval?: boolean;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly event: TaskEvent,
  ) {
    super(`Transisi tidak sah: event "${event}" tidak berlaku untuk status ${from}`);
    this.name = "InvalidTransitionError";
  }
}

/** Status berikutnya, atau null bila event tidak berlaku untuk status ini. */
export function nextStatus(
  from: TaskStatus,
  event: TaskEvent,
  ctx: TransitionContext = {},
): TaskStatus | null {
  const to = TRANSITIONS[event][from];
  if (to === undefined) return null;
  if (event === "complete" && ctx.requiresApproval) return "NEEDS_REVIEW";
  return to;
}

/** Seperti nextStatus, tapi melempar InvalidTransitionError bila tidak sah. */
export function transition(
  from: TaskStatus,
  event: TaskEvent,
  ctx: TransitionContext = {},
): TaskStatus {
  const to = nextStatus(from, event, ctx);
  if (to === null) throw new InvalidTransitionError(from, event);
  return to;
}

/** Event yang sah dari sebuah status (berguna untuk tombol di Web UI). */
export function allowedEvents(from: TaskStatus): TaskEvent[] {
  return TASK_EVENTS.filter((e) => TRANSITIONS[e][from] !== undefined);
}

/**
 * Task hilir hanya terbuka bila semua dependensinya DONE. NEEDS_REVIEW dan
 * REVISION_REQUESTED sengaja menahan task hilir (approval gate + revisi tengah jalan).
 */
export function isDependencySatisfied(status: TaskStatus): boolean {
  return status === "DONE";
}

// ---------------------------------------------------------------------------
// Lock & lease
// ---------------------------------------------------------------------------

/** Lease lock task: 30 menit, diperpanjang otomatis setiap kali agen memanggil tool MCP. */
export const LOCK_LEASE_MS = 30 * 60 * 1000;

export function leaseExpiresAt(lockedAt: Date, leaseMs: number = LOCK_LEASE_MS): Date {
  return new Date(lockedAt.getTime() + leaseMs);
}

export function isLeaseExpired(
  lockedAt: Date,
  now: Date = new Date(),
  leaseMs: number = LOCK_LEASE_MS,
): boolean {
  return now.getTime() >= lockedAt.getTime() + leaseMs;
}

/**
 * Scope lock: maksimal 1 task IN_PROGRESS per (project_id, repo). `repoName` adalah
 * repo_name agen yang meng-claim (task dengan target_repo null bisa dikerjakan repo mana pun).
 */
export function lockScopeKey(projectId: string, repoName: string): string {
  return `${projectId}:${repoName}`;
}

// ---------------------------------------------------------------------------
// Entitas task
// ---------------------------------------------------------------------------

export const TaskSchema = z.object({
  id: IdSchema,
  /** Diduplikasi dari project agar kebijakan RLS cukup `workspace_id = current_setting(...)`. */
  workspace_id: IdSchema,
  project_id: IdSchema,
  epic_id: IdSchema,
  title: z.string().min(1).max(200),
  prompt_instruction: z.string().min(1).max(8000),
  status: TaskStatusSchema,
  requires_approval: z.boolean().default(false),
  target_repo: RepoNameSchema.nullable(),
  role: RoleSchema.nullable(),
  assignee_id: IdSchema.nullable(),
  locked_by: z.string().max(200).nullable(),
  locked_at: IsoDateTimeSchema.nullable(),
  lease_expires_at: IsoDateTimeSchema.nullable(),
  handoff_summary: HandoffSummarySchema.nullable(),
  review_feedback: z.string().max(2000).nullable(),
  revision_count: z.number().int().min(0).default(0),
  blocker_reason: z.string().max(1000).nullable(),
  /** Ditandai bila dependensi hulu dibuka ulang setelah task ini berjalan. */
  is_stale: z.boolean().default(false),
  depends_on: z.array(IdSchema).default([]),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

/** Bentuk ringkas untuk get_ready_tasks (~30–50 token per task). */
export const TaskSummarySchema = z.object({
  id: IdSchema,
  title: z.string().min(1).max(200),
  depends_on: z.array(IdSchema),
  role: RoleSchema.optional(),
  target_repo: RepoNameSchema.optional(),
  revision: z.boolean().optional(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const BLOCKER_CATEGORIES = [
  "missing_env",
  "ambiguous_requirement",
  "failing_tests",
  "dependency_issue",
  "other",
] as const;
export const BlockerCategorySchema = z.enum(BLOCKER_CATEGORIES);
export type BlockerCategory = z.infer<typeof BlockerCategorySchema>;
