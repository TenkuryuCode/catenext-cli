import { z } from "zod";
import {
  AgentAliasSchema,
  IdSchema,
  IsoDateTimeSchema,
  ProjectLayoutSchema,
  RepoNameSchema,
  RoleSchema,
} from "./common.js";
import { PullRequestStateSchema } from "./review.js";
import { BlockerCategorySchema, TaskSchema } from "./task.js";

/**
 * Kontrak domain & input lokal untuk CLI dan server MCP Catenext.
 */

// --- Entitas ----------------------------------------------------------------

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  detected_stack: z.array(z.string()),
  /** monorepo = satu git (claim wajib worktree); polyrepo = clone terpisah per repo. */
  layout: ProjectLayoutSchema.default("polyrepo"),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const EpicSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable(),
  template_used: z.string().max(80).nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Epic = z.infer<typeof EpicSchema>;

/** Task DTO: TaskSchema + urutan dan metadata lock/PR/dependensi. */
export const TaskDtoSchema = TaskSchema.extend({
  pull_request: PullRequestStateSchema.nullable().optional(),
  worktree_branch: z.string().nullable().optional(),
  position: z.number(),
  lock_repo: RepoNameSchema.nullable(),
  blocker_category: BlockerCategorySchema.nullable(),
  /** Dependensi yang belum DONE. Kosong = tidak tertahan dependensi. */
  blocked_by: z.array(IdSchema),
  /** TODO/REVISION_REQUESTED dan semua dependensinya DONE: bisa diklaim agen sekarang. */
  is_ready: z.boolean(),
});
export type TaskDto = z.infer<typeof TaskDtoSchema>;

export const AgentPersonaSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  alias: AgentAliasSchema,
  role: RoleSchema,
  rules: z.array(z.string()),
  repos: z.array(z.string()),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type AgentPersona = z.infer<typeof AgentPersonaSchema>;

// --- Input pembaruan & aksi -------------------------------------------------

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
  detected_stack: z.array(z.string().min(1).max(40)).max(20).default([]),
  layout: ProjectLayoutSchema.default("polyrepo"),
});

export const UpdateProjectInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  detected_stack: z.array(z.string().min(1).max(40)).max(20).optional(),
  layout: ProjectLayoutSchema.optional(),
});

export const CreateEpicInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullish(),
  template_used: z.string().max(80).nullish(),
});

export const UpdateEpicInput = CreateEpicInput.partial();

export const CreateTaskInput = z.object({
  title: z.string().trim().min(1).max(200),
  prompt_instruction: z.string().min(1).max(8000),
  target_repo: RepoNameSchema.nullish(),
  role: RoleSchema.nullish(),
  persona_id: IdSchema.nullish(),
  requires_approval: z.boolean().default(false),
  depends_on: z.array(IdSchema).max(10).default([]),
  status: z.enum(["DRAFT", "TODO"]).default("TODO"),
});

export const UpdateTaskInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  prompt_instruction: z.string().min(1).max(8000).optional(),
  target_repo: RepoNameSchema.nullable().optional(),
  role: RoleSchema.nullable().optional(),
  persona: AgentAliasSchema.nullable().optional(),
  persona_id: IdSchema.nullable()
    .optional()
    .describe("Project persona UUID from list_personas; null clears assignment."),
  requires_approval: z.boolean().optional(),
  position: z
    .number()
    .finite()
    .optional()
    .describe("Display order within the project, ascending; ties keep insertion order."),
  is_stale: z.literal(false).optional(),
});

export const SetDependenciesInput = z.object({
  depends_on: z.array(IdSchema).max(10),
});

export const HUMAN_TASK_EVENTS = [
  "approve_plan",
  "return_to_draft",
  "approve",
  "request_revision",
  "unblock",
] as const;

export const TaskActionInput = z.discriminatedUnion("event", [
  z.object({ event: z.literal("approve_plan") }),
  z.object({ event: z.literal("return_to_draft") }),
  z.object({ event: z.literal("approve") }),
  z.object({
    event: z.literal("request_revision"),
    feedback: z.string().trim().min(5).max(2000),
  }),
  z.object({ event: z.literal("unblock") }),
]);
export type TaskActionInputType = z.infer<typeof TaskActionInput>;

export const PersonaInput = z.object({
  alias: AgentAliasSchema,
  role: RoleSchema,
  rules: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  repos: z.array(RepoNameSchema).max(10).default([]),
  project_id: IdSchema.optional(),
});

export const UpdatePersonaInput = z.object({
  alias: AgentAliasSchema.optional(),
  role: RoleSchema.optional(),
  rules: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  repos: z.array(RepoNameSchema).max(10).optional(),
  project_id: IdSchema.optional(),
});

export const ReleaseTaskInput = z.object({ task_id: IdSchema, lease_id: IdSchema });

export const LocalErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type LocalError = z.infer<typeof LocalErrorSchema>;
