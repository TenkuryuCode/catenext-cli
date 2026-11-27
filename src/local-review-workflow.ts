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
  buildReviewContextPack,
  isStaleReviewCommit,
  withReviewResponseByteLength,
} from "./review-context.js";

interface ReviewWorkflow {
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

export const offlineReview =
  "Review lokal saja. Status, head SHA, dan merge PR di host tidak diperiksa.";

function reviewEntry(
  task: LocalTask,
  review: LocalReview,
  status: "NEEDS_REVIEW" | "REVISION_REQUESTED" | "DONE",
) {
  const stage: PullRequestState["stage"] = review.approvedLocally
    ? "approved_locally"
    : status === "REVISION_REQUESTED"
      ? "changes_requested"
      : review.decision?.value === "approve"
        ? "awaiting_human_approval"
        : review.lease
          ? "in_review"
          : "awaiting_review";
  return {
    task_id: task.id,
    title: task.title,
    status,
    review: {
      ...(review.ref.url ? { url: review.ref.url } : {}),
      base_branch: review.ref.base_branch,
      head_sha: review.ref.head_sha,
      stage,
      checked_at: review.updatedAt,
      reviewer: review.lease?.reviewer ?? review.decision?.reviewer ?? null,
      merge_sha: null,
    },
  };
}

export function reviewPullRequest(
  input: ReviewRequest,
  {
    project,
    tasks,
    repoRoot,
    repo,
    overrides,
    now,
    iso,
    personaForAlias,
    dirty,
    recordEvent,
  }: ReviewWorkflow,
): ReviewResult {
  if (input.action === "list") {
    return {
      reviews: project.tasks
        .flatMap((task) =>
          task.status === "NEEDS_REVIEW" &&
          task.review?.repo === repo &&
          !task.review.lease &&
          !task.review.decision
            ? [reviewEntry(task, task.review, "NEEDS_REVIEW")]
            : [],
        )
        .slice(0, input.limit),
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
  const entry = reviewEntry(task, review, status);
  if (input.action === "refresh") {
    if (isStaleReviewCommit({ task, review, expectedHeadSha: input.head_sha })) {
      return {
        ...entry,
        stale_commit: true,
        warning: `Review tidak cocok: head SHA handoff sudah berubah. ${offlineReview}`,
      };
    }
    const contextPack =
      input.include_context === true
        ? buildReviewContextPack({
            repoRoot,
            project,
            task,
            review,
            compact: Boolean(input.compact),
          })
        : undefined;
    const refreshed = {
      ...entry,
      notice: offlineReview,
      ...(contextPack ? { review_context_pack: contextPack } : {}),
    };
    return input.include_context === true || input.compact === true
      ? withReviewResponseByteLength(refreshed)
      : refreshed;
  }
  if (status !== "NEEDS_REVIEW")
    return { ...entry, warning: `Review tidak menunggu keputusan. ${offlineReview}` };
  if (input.action === "claim") {
    if (isStaleReviewCommit({ task, review, expectedHeadSha: input.head_sha })) {
      return {
        ...entry,
        stale_commit: true,
        warning: `Review tidak diambil: head SHA handoff sudah berubah. ${offlineReview}`,
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
    if (review.lease || review.decision)
      return { ...entry, warning: `Review sudah diambil atau diputuskan. ${offlineReview}` };
    const leaseId = randomUUID();
    review.lease = {
      id: leaseKey(leaseId),
      reviewer: persona?.alias ?? `reviewer@${repo}`,
      expiresAt: leaseEnd(now),
    };
    review.updatedAt = iso;
    dirty();
    const contextPack =
      input.include_context === true
        ? buildReviewContextPack({
            repoRoot,
            project,
            task,
            review,
            compact: Boolean(input.compact),
          })
        : undefined;
    const rawNotes = task.handoff?.notes_for_next_agent;
    const notes =
      rawNotes !== undefined && input.compact === true ? briefText(rawNotes, 160) : rawNotes;
    const claimed = {
      ...reviewEntry(task, review, status),
      lease_id: leaseId,
      lease_expires_at: review.lease.expiresAt,
      ...(notes !== undefined ? { notes_for_next_agent: notes } : {}),
      notice: offlineReview,
      ...(contextPack ? { review_context_pack: contextPack } : {}),
    };
    return input.include_context === true || input.compact === true
      ? withReviewResponseByteLength(claimed)
      : claimed;
  }
  const staleSubmit = isStaleReviewCommit({ task, review, expectedHeadSha: input.head_sha });
  if (!review.lease || !leaseMatches(review.lease.id, input.lease_id) || staleSubmit) {
    return {
      ...entry,
      ...(staleSubmit ? { stale_commit: true as const } : {}),
      warning: `Review tidak disimpan: lease atau head SHA handoff tidak cocok. ${offlineReview}`,
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
    ...reviewEntry(
      task,
      review,
      input.decision === "approve" ? "NEEDS_REVIEW" : "REVISION_REQUESTED",
    ),
    notice: offlineReview,
  };
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
