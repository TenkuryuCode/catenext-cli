import { z } from "zod";
import { IdSchema } from "./common.js";

export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const PullRequestUrlSchema = z
  .string()
  .max(240)
  .regex(
    /^https:\/\/github\.com\/[a-z\d][a-z\d-]*\/[a-z\d_.-]+\/pull\/[1-9]\d*$/i,
    "Gunakan URL pull request GitHub.",
  );
export const PullRequestRefSchema = z.object({
  url: PullRequestUrlSchema,
  base_branch: z.string().min(1).max(255),
  head_sha: CommitShaSchema,
});
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>;

export const REVIEW_STAGES = [
  "draft",
  "awaiting_review",
  "in_review",
  "changes_requested",
  "revising",
  "awaiting_human_approval",
  "approved_awaiting_merge",
  "closed_without_merge",
  "merged",
] as const;
export const ReviewStageSchema = z.enum(REVIEW_STAGES);
export type ReviewStage = z.infer<typeof ReviewStageSchema>;
export const REVIEW_STAGE_LABELS: Record<ReviewStage, string> = {
  draft: "PR masih draft",
  awaiting_review: "Menunggu reviewer",
  in_review: "Sedang direview",
  changes_requested: "Menunggu revisi",
  revising: "Revisi sedang dikerjakan",
  awaiting_human_approval: "Menunggu persetujuan manusia",
  approved_awaiting_merge: "Disetujui, menunggu merge",
  closed_without_merge: "PR ditutup tanpa merge",
  merged: "Merge terverifikasi",
};

export const PullRequestStateSchema = PullRequestRefSchema.extend({
  stage: ReviewStageSchema,
  checked_at: z.iso.datetime(),
  reviewer: z.string().nullable(),
  merge_sha: CommitShaSchema.nullable(),
});
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;

export const ReviewInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), limit: z.number().int().min(1).max(30).default(10) }),
  z.object({
    action: z.literal("claim"),
    task_id: IdSchema,
    agent_alias: z.string().min(1).max(80).optional(),
  }),
  z.object({ action: z.literal("refresh"), task_id: IdSchema }),
  z.object({
    action: z.literal("submit"),
    task_id: IdSchema,
    lease_id: IdSchema,
    head_sha: CommitShaSchema,
    decision: z.enum(["approve", "request_changes"]),
    feedback: z.string().trim().min(1).max(1000),
  }),
]);

export const ReviewEntrySchema = z.object({
  task_id: IdSchema,
  title: z.string(),
  status: z.enum(["NEEDS_REVIEW", "REVISION_REQUESTED", "DONE"]),
  review: PullRequestStateSchema,
});
export const ReviewOutput = z.union([
  z.object({ reviews: z.array(ReviewEntrySchema) }),
  ReviewEntrySchema.extend({
    lease_id: IdSchema.optional(),
    lease_expires_at: z.iso.datetime().optional(),
    notes_for_next_agent: z.string().optional(),
    warning: z.string().optional(),
  }),
]);
export type ReviewRequest = z.output<typeof ReviewInput>;
export type ReviewResult = z.infer<typeof ReviewOutput>;

export const HumanReviewInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("approve"), head_sha: CommitShaSchema }),
]);
export type HumanReviewRequest = z.infer<typeof HumanReviewInput>;
