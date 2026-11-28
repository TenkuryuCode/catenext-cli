import { randomUUID } from "node:crypto";
import {
  briefText,
  type CatenextConfig,
  type Persona,
  type PullRequestState,
  type ReviewRequest,
  type ReviewResult,
} from "@catenext/shared";
import type { NewTaskEvent } from "./db/task-events.js";
import { LocalServiceError } from "./errors.js";
import { advance, leaseEnd, leaseKey, leaseMatches } from "./local-lease.js";
import { allowsRepo, type LocalProject, type LocalReview, type LocalTask } from "./local-state.js";
import {
  buildReviewContextPackFromSnapshot,
  buildReviewContextPackFromSnapshotSync,
  isStaleReviewCommit,
  type ReviewContextSnapshot,
  snapshotReviewContext,
  withReviewResponseByteLength,
} from "./review-context.js";
import { scrubText } from "./scrubber.js";

export interface ReviewWorkflow {
  project: LocalProject;
  tasks: ReadonlyMap<string, LocalTask>;
  repoRoot: string;
  repo: string;
  overrides: CatenextConfig["overrides"];
  now: number;
  iso: string;
  personaForAlias: (alias: string) => Persona;
  dirty: () => void;
  recordEvent: (event: Omit<NewTaskEvent, "created_at">) => void;
}

export interface PreparedReviewResult {
  result: ReviewResult;
  contextSnapshot?: ReviewContextSnapshot;
  includeByteLength?: boolean;
}

export const offlineReview =
  "Review lokal saja. Status, head SHA, dan merge PR di host tidak diperiksa.";

function isActiveReviewLease(lease: LocalReview["lease"], now: number): boolean {
  return lease !== undefined && Date.parse(lease.expiresAt) > now;
}

function reviewEntry(
  task: LocalTask,
  review: LocalReview,
  status: "NEEDS_REVIEW" | "REVISION_REQUESTED" | "DONE",
  now: number,
) {
  const activeLease = isActiveReviewLease(review.lease, now) ? review.lease : undefined;
  const stage: PullRequestState["stage"] = review.approvedLocally
    ? "approved_locally"
    : status === "REVISION_REQUESTED"
      ? "changes_requested"
      : review.decision?.value === "approve"
        ? "awaiting_human_approval"
        : activeLease
          ? "in_review"
          : "awaiting_review";
  return {
    task_id: task.id,
    title: scrubText(task.title),
    status,
    review: {
      ...(review.ref.url ? { url: review.ref.url } : {}),
      base_branch: scrubText(review.ref.base_branch),
      head_sha: review.ref.head_sha,
      stage,
      checked_at: review.updatedAt,
      reviewer: activeLease?.reviewer ?? review.decision?.reviewer ?? null,
      merge_sha: null,
    },
  };
}

export function prepareReviewPullRequest(
  input: ReviewRequest,
  {
    project,
    tasks,
    repo,
    overrides,
    now,
    iso,
    personaForAlias,
    dirty,
    recordEvent,
  }: Omit<ReviewWorkflow, "repoRoot"> & { repoRoot?: string },
): PreparedReviewResult {
  if (input.action === "list") {
    if (input.limit <= 0) return { result: { reviews: [] } };
    return {
      result: {
        reviews: project.tasks
          .flatMap((task) =>
            task.status === "NEEDS_REVIEW" &&
            task.review?.repo === repo &&
            !isActiveReviewLease(task.review.lease, now) &&
            !task.review.decision
              ? [reviewEntry(task, task.review, "NEEDS_REVIEW", now)]
              : [],
          )
          .slice(0, input.limit),
      },
    };
  }
  const task = tasks.get(input.task_id);
  if (!task) throw new LocalServiceError("not_found", "Task tidak ditemukan di proyek ini.");
  const review = task.review;
  if (!review || review.repo !== repo)
    throw new LocalServiceError("not_found", "Review tidak ditemukan di repo ini.");
  const status = task.status;
  if (status !== "NEEDS_REVIEW" && status !== "DONE" && status !== "REVISION_REQUESTED")
    throw new LocalServiceError("review_not_pending", "Tunggu handoff berikutnya.");
  const entry = reviewEntry(task, review, status, now);
  if (input.action === "refresh") {
    if (isStaleReviewCommit({ task, review, expectedHeadSha: input.head_sha })) {
      return {
        result: {
          ...entry,
          stale_commit: true,
          warning: `Review tidak cocok: head SHA handoff sudah berubah. ${offlineReview}`,
        },
      };
    }
    const includeContext = input.include_context === true;
    const includeByteLength = includeContext || input.compact === true;
    const contextSnapshot = includeContext
      ? snapshotReviewContext({
          project,
          task,
          review,
          compact: Boolean(input.compact),
        })
      : undefined;
    const refreshed = {
      ...entry,
      notice: offlineReview,
    };
    return {
      result:
        includeByteLength && !contextSnapshot ? withReviewResponseByteLength(refreshed) : refreshed,
      ...(contextSnapshot ? { contextSnapshot } : {}),
      ...(includeByteLength ? { includeByteLength: true } : {}),
    };
  }
  if (status !== "NEEDS_REVIEW")
    return { result: { ...entry, warning: `Review tidak menunggu keputusan. ${offlineReview}` } };
  if (input.action === "claim") {
    if (isStaleReviewCommit({ task, review, expectedHeadSha: input.head_sha })) {
      return {
        result: {
          ...entry,
          stale_commit: true,
          warning: `Review tidak diambil: head SHA handoff sudah berubah. ${offlineReview}`,
        },
      };
    }
    const alias =
      input.agent_alias ??
      (overrides?.default_role === "reviewer" ? overrides.default_agent_alias : undefined);
    const persona = alias ? personaForAlias(alias) : undefined;
    if (persona && (persona.role !== "reviewer" || !allowsRepo(persona, repo)))
      throw new LocalServiceError(
        "reviewer_required",
        "Gunakan persona reviewer yang memegang repo ini.",
      );
    if (alias && alias === review.author)
      throw new LocalServiceError(
        "self_review",
        "Persona implementer tidak dapat menjadi reviewer PR ini.",
      );
    if (review.lease && !isActiveReviewLease(review.lease, now)) {
      delete review.lease;
      dirty();
    }
    if (review.lease || review.decision)
      return {
        result: { ...entry, warning: `Review sudah diambil atau diputuskan. ${offlineReview}` },
      };
    const leaseId = randomUUID();
    review.lease = {
      id: leaseKey(leaseId),
      reviewer: persona?.alias ?? `reviewer@${repo}`,
      expiresAt: leaseEnd(now),
    };
    review.updatedAt = iso;
    dirty();
    const includeContext = input.include_context === true;
    const includeByteLength = includeContext || input.compact === true;
    const contextSnapshot = includeContext
      ? snapshotReviewContext({
          project,
          task,
          review,
          compact: Boolean(input.compact),
        })
      : undefined;
    const rawNotes = task.handoff?.notes_for_next_agent;
    const scrubbedNotes = rawNotes !== undefined ? scrubText(rawNotes) : undefined;
    const notes =
      scrubbedNotes !== undefined && input.compact === true
        ? briefText(scrubbedNotes, 160)
        : scrubbedNotes;
    const claimed = {
      ...reviewEntry(task, review, status, now),
      lease_id: leaseId,
      lease_expires_at: review.lease.expiresAt,
      ...(notes !== undefined ? { notes_for_next_agent: notes } : {}),
      notice: offlineReview,
    };
    return {
      result:
        includeByteLength && !contextSnapshot ? withReviewResponseByteLength(claimed) : claimed,
      ...(contextSnapshot ? { contextSnapshot } : {}),
      ...(includeByteLength ? { includeByteLength: true } : {}),
    };
  }
  const staleSubmit = isStaleReviewCommit({ task, review, expectedHeadSha: input.head_sha });
  if (review.lease && !isActiveReviewLease(review.lease, now)) {
    delete review.lease;
    dirty();
    return {
      result: {
        ...entry,
        ...(staleSubmit ? { stale_commit: true as const } : {}),
        warning: `Review tidak disimpan: lease review sudah kadaluarsa. ${offlineReview}`,
      },
    };
  }
  if (!review.lease || !leaseMatches(review.lease.id, input.lease_id) || staleSubmit) {
    return {
      result: {
        ...entry,
        ...(staleSubmit ? { stale_commit: true as const } : {}),
        warning: `Review tidak disimpan: lease atau head SHA handoff tidak cocok. ${offlineReview}`,
      },
    };
  }
  const reviewer = review.lease.reviewer;
  delete review.lease;
  if (input.decision === "request_changes") {
    const fromStatus = task.status;
    reviseTask(task, tasks.values(), input.feedback, iso);
    recordEvent({
      task_id: task.id,
      event: "revision",
      actor: reviewer,
      note: input.feedback,
      detail: {
        from: fromStatus,
        to: task.status,
        revision_count: task.revision,
        via: "review_pull_request",
      },
    });
  }
  // A reviewer recommendation is not an approval; only the human manage_task path can set DONE.
  review.decision = { value: input.decision, reviewer, feedback: input.feedback };
  review.updatedAt = iso;
  dirty();
  return {
    result: {
      ...reviewEntry(
        task,
        review,
        input.decision === "approve" ? "NEEDS_REVIEW" : "REVISION_REQUESTED",
        now,
      ),
      notice: offlineReview,
    },
  };
}

export async function enrichReviewResult(
  prepared: PreparedReviewResult,
  repoRoot: string,
): Promise<ReviewResult> {
  const { result, contextSnapshot, includeByteLength } = prepared;
  if ("reviews" in result) return result;
  if (!contextSnapshot) {
    return includeByteLength ? withReviewResponseByteLength(result) : result;
  }
  const contextPack = await buildReviewContextPackFromSnapshot(contextSnapshot, repoRoot);
  const enriched = {
    ...result,
    review_context_pack: contextPack,
  };
  return includeByteLength ? withReviewResponseByteLength(enriched) : enriched;
}

export function reviewPullRequest(input: ReviewRequest, workflow: ReviewWorkflow): ReviewResult {
  const prepared = prepareReviewPullRequest(input, workflow);
  const { result, contextSnapshot, includeByteLength } = prepared;
  if ("reviews" in result || !contextSnapshot) return result;
  const contextPack = buildReviewContextPackFromSnapshotSync(contextSnapshot, workflow.repoRoot);
  const enriched = {
    ...result,
    review_context_pack: contextPack,
  };
  return includeByteLength ? withReviewResponseByteLength(enriched) : enriched;
}

export function reviseTask(
  task: LocalTask,
  tasks: Iterable<LocalTask>,
  feedback: string,
  iso: string,
): string[] {
  const wasDone = task.status === "DONE";
  advance(task, "request_revision");
  task.feedback = feedback;
  task.revision += 1;
  delete task.integrated_commit;
  if (task.review) {
    delete task.review.lease;
    delete task.review.decision;
    task.review.approvedLocally = false;
    task.review.updatedAt = iso;
  }
  if (!wasDone) return [];
  const downstream = new Map<string, LocalTask[]>();
  for (const child of tasks) {
    for (const id of child.dependencies) {
      const children = downstream.get(id);
      if (children) children.push(child);
      else downstream.set(id, [child]);
    }
  }
  const queue = [task.id];
  const seen = new Set(queue);
  const updated: string[] = [];
  for (const id of queue) {
    for (const child of downstream.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      queue.push(child.id);
      if (child.status === "DRAFT" || child.status === "TODO") continue;
      child.stale = true;
      updated.push(child.id);
    }
  }
  return updated;
}
