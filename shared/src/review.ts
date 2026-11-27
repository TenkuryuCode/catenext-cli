import { z } from "zod";
import { IdSchema } from "./common.js";

export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const PULL_REQUEST_URL_RE =
  /^https?:\/\/[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*(?::\d{1,5})?(?:\/[a-z\d_][a-z\d._-]*){2,}(?:\/pull|\/(?:-\/)?merge_requests|\/pull-requests|\/pulls)\/[1-9]\d*$/i;
const PULL_REQUEST_URL_MSG =
  "Gunakan URL pull/merge request GitHub, GitLab, Bitbucket, atau Gitea yang valid.";
type UrlParts = {
  protocol: string;
  username: string;
  password: string;
  search: string;
  hash: string;
};

const UrlConstructor = (globalThis as { URL?: new (input: string) => UrlParts }).URL;

export const PullRequestUrlSchema = z
  .string()
  .max(240)
  .regex(PULL_REQUEST_URL_RE, PULL_REQUEST_URL_MSG)
  .refine((value) => {
    if (!UrlConstructor) return true;
    try {
      const parsed = new UrlConstructor(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  }, PULL_REQUEST_URL_MSG);
export const PullRequestRefSchema = z.object({
  url: PullRequestUrlSchema.optional(),
  base_branch: z.string().min(1).max(255),
  head_sha: CommitShaSchema,
});
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>;

export const REVIEW_STAGES = [
  "awaiting_review",
  "in_review",
  "changes_requested",
  "awaiting_human_approval",
  "approved_locally",
] as const;
export const ReviewStageSchema = z.enum(REVIEW_STAGES);
export type ReviewStage = z.infer<typeof ReviewStageSchema>;
export const REVIEW_STAGE_LABELS: Record<ReviewStage, string> = {
  awaiting_review: "Menunggu reviewer",
  in_review: "Sedang direview",
  changes_requested: "Menunggu revisi",
  awaiting_human_approval: "Menunggu persetujuan manusia",
  approved_locally: "Disetujui lokal; merge tidak diverifikasi",
};

export const PullRequestStateSchema = PullRequestRefSchema.extend({
  stage: ReviewStageSchema,
  /** Waktu pembaruan catatan review lokal, bukan pengecekan host. */
  checked_at: z.iso.datetime(),
  reviewer: z.string().nullable(),
  merge_sha: z.null(),
});
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;

export const ReviewDecisionSchema = z.enum(["approve", "request_changes"]);

/** Maximum serialized UTF-8 JSON bytes for the optional review_context_pack. */
export const REVIEW_CONTEXT_PACK_MAX_BYTES = 4096;

export const ReviewChangedFileSchema = z.object({
  path: z.string().min(1).max(300),
  status: z.enum(["added", "modified", "deleted", "renamed", "typechange", "handoff"]),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  binary: z.boolean().optional(),
  previous_path: z.string().min(1).max(300).optional(),
  in_scope: z.boolean().optional(),
});
export type ReviewChangedFile = z.infer<typeof ReviewChangedFileSchema>;

export const ReviewScopeDriftSchema = z.object({
  scope_files: z.array(z.string().min(1).max(300)),
  in_scope_files: z.array(z.string().min(1).max(300)),
  out_of_scope_files: z.array(z.string().min(1).max(300)),
  untouched_scope_files: z.array(z.string().min(1).max(300)),
  drift_detected: z.boolean(),
});
export type ReviewScopeDrift = z.infer<typeof ReviewScopeDriftSchema>;

export const ReviewDiffMetaSchema = z.object({
  source: z.enum(["git_diff", "handoff_only"]),
  base_ref: z.string().min(1).max(255).optional(),
  total_files: z.number().int().min(0),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  changed_files: z.array(ReviewChangedFileSchema),
  files_truncated: z.boolean().optional(),
  scope_drift: ReviewScopeDriftSchema.optional(),
});
export type ReviewDiffMeta = z.infer<typeof ReviewDiffMetaSchema>;

export const ReviewDetailPointersSchema = z.object({
  git_diff_command: z.string().min(1).max(400),
  git_show_stat_command: z.string().min(1).max(400),
  doc_refs: z.array(z.string().min(1).max(160)).optional(),
  mcp_tools: z.array(z.string().min(1).max(160)),
});
export type ReviewDetailPointers = z.infer<typeof ReviewDetailPointersSchema>;

export const ReviewContextPackSchema = z.object({
  task_id: IdSchema,
  reviewed_commit_sha: CommitShaSchema,
  head_sha: CommitShaSchema,
  last_commit_hash: z.string().regex(/^[0-9a-f]{7,64}$/),
  base_branch: z.string().min(1).max(255),
  git_branch: z.string().min(1).max(255).optional(),
  diff_meta: ReviewDiffMetaSchema,
  handoff_decisions: z.array(z.string()),
  verification_command: z.string().nullable(),
  task_verify_command: z.string().nullable().optional(),
  epic_summary_excerpt: z.string().optional(),
  sync_board_excerpt: z.string().optional(),
  detail_pointers: ReviewDetailPointersSchema,
  byte_length: z.number().int().min(1).max(REVIEW_CONTEXT_PACK_MAX_BYTES),
  truncated: z.literal(true).optional(),
});
export type ReviewContextPack = z.infer<typeof ReviewContextPackSchema>;

export const ReviewInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), limit: z.number().int().min(1).max(30).default(10) }),
  z.object({
    action: z.literal("claim"),
    task_id: IdSchema,
    agent_alias: z.string().min(1).max(80).optional(),
    head_sha: CommitShaSchema.optional(),
    compact: z.boolean().optional(),
    include_context: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("refresh"),
    task_id: IdSchema,
    head_sha: CommitShaSchema.optional(),
    compact: z.boolean().optional(),
    include_context: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("submit"),
    task_id: IdSchema,
    lease_id: IdSchema,
    head_sha: CommitShaSchema,
    decision: ReviewDecisionSchema,
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
    /** Batas review lokal, bukan kegagalan aksi. */
    notice: z.string().optional(),
    warning: z.string().optional(),
    stale_commit: z.literal(true).optional(),
    review_context_pack: ReviewContextPackSchema.optional(),
    byte_length: z.number().int().min(1).optional(),
  }),
]);
export type ReviewRequest = z.output<typeof ReviewInput>;
export type ReviewResult = z.infer<typeof ReviewOutput>;
