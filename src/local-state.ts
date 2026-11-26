import {
  AgentAliasSchema,
  BlockerCategorySchema,
  CommitShaSchema,
  HandoffSummarySchema,
  IdSchema,
  IsoDateTimeSchema,
  type PersonaSchema,
  type ProjectDocumentSchema,
  PullRequestRefSchema,
  RepoNameSchema,
  ReviewDecisionSchema,
  RoleSchema,
  TaskStatusSchema,
  TaskSummarySchema,
} from "@catenext/shared";
import { z } from "zod";

export { LocalServiceError } from "./errors.js";

/** Unique per-claim lease token. State stores a hash; plaintext stays with the caller. */
const LeaseTokenSchema = z.string().min(1).max(128);

/** `id` is the unique per-claim token (hashed); `worktree.session` is only the session reservation. */
const taskLease = z.strictObject({
  id: LeaseTokenSchema,
  repo: RepoNameSchema,
  alias: AgentAliasSchema.optional(),
  expiresAt: IsoDateTimeSchema,
  worktree: z
    .strictObject({
      session: IdSchema,
      worktree_path: z.string().min(1).max(1000).optional(),
      base_branch: z.string().min(1).max(255).optional(),
    })
    .optional(),
});

const review = z.strictObject({
  ref: PullRequestRefSchema,
  repo: RepoNameSchema,
  author: AgentAliasSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  lease: z
    .strictObject({
      id: LeaseTokenSchema,
      reviewer: z.string().min(1),
      expiresAt: IsoDateTimeSchema,
    })
    .optional(),
  decision: z
    .strictObject({
      value: ReviewDecisionSchema,
      reviewer: z.string().min(1),
      feedback: z.string().min(1).max(1000),
    })
    .optional(),
  approvedLocally: z.boolean(),
});

const task = z.strictObject({
  id: IdSchema,
  epicId: IdSchema,
  title: TaskSummarySchema.shape.title,
  instruction: z.string().min(1).max(8000),
  status: TaskStatusSchema,
  dependencies: z.array(IdSchema).max(10),
  target: RepoNameSchema.nullable(),
  role: RoleSchema.nullable(),
  persona: AgentAliasSchema.nullable(),
  position: z.number().finite(),
  requiresApproval: z.boolean(),
  lease: taskLease.optional(),
  branch: z
    .strictObject({
      repo: RepoNameSchema,
      name: z.string().min(1).max(255),
      worktree_path: z.string().min(1).max(1000).optional(),
      base_branch: z.string().min(1).max(255).optional(),
    })
    .optional(),
  handoff: HandoffSummarySchema.optional(),
  integrated_commit: z
    .strictObject({ branch: z.string().min(1).max(255), sha: CommitShaSchema })
    .optional(),
  review: review.optional(),
  feedback: z.string().min(1).max(2000).optional(),
  revision: z.number().int().min(0),
  stale: z.boolean(),
  blocker: z
    .strictObject({ category: BlockerCategorySchema, reason: z.string().min(10).max(1000) })
    .optional(),
});

export const PERMISSION_ACTIONS = [
  "approve_plan",
  "edit_setup",
  "manage_roots",
  "upsert_persona",
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export type LocalPermission = {
  action: PermissionAction;
  /** `human`, `orchestrator`, or a persona alias. */
  principal: string;
};

export type LocalRoot = {
  id: string;
  path: string;
  ownerPersona: string | null;
  label?: string;
};

export type LocalProject = {
  repos: string[];
  epics: Array<{ id: string; title: string; description: string | null }>;
  personas: z.output<typeof PersonaSchema>[];
  tasks: z.output<typeof task>[];
  documents: z.output<typeof ProjectDocumentSchema>[];
  permissions: LocalPermission[];
  workspace_roots: LocalRoot[];
  session_prefs: { locale?: string };
  platform_setup: string[];
};

export type LocalTask = z.output<typeof task>;
export type LocalReview = z.output<typeof review>;
