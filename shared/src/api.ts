import { z } from "zod";
import {
  AgentAliasSchema,
  IdSchema,
  IsoDateTimeSchema,
  RepoNameSchema,
  RoleSchema,
} from "./common.js";
import { CommitShaSchema, PullRequestStateSchema } from "./review.js";
import { BlockerCategorySchema, TaskSchema } from "./task.js";

/**
 * Kontrak HTTP antara Web UI / CLI dan Catenext Cloud API (apps/api).
 * Semua body request divalidasi dengan skema ini di server, dan tipe responsnya
 * dipakai langsung oleh apps/web.
 */

// --- Entitas ----------------------------------------------------------------

export const WorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string(),
  slug: z.string(),
  role: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ProjectSchema = z.object({
  id: IdSchema,
  workspace_id: IdSchema,
  name: z.string().min(1).max(120),
  detected_stack: z.array(z.string()),
  agent_connected_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const EpicSchema = z.object({
  id: IdSchema,
  workspace_id: IdSchema,
  project_id: IdSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable(),
  template_used: z.string().max(80).nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type Epic = z.infer<typeof EpicSchema>;

/** Task seperti yang dikirim API: TaskSchema + urutan Kanban dan kategori blocker. */
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
  workspace_id: IdSchema,
  project_id: IdSchema.nullable(),
  alias: AgentAliasSchema,
  role: RoleSchema,
  rules: z.array(z.string()),
  repos: z.array(z.string()),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type AgentPersona = z.infer<typeof AgentPersonaSchema>;

export const ApiKeySchema = z.object({
  id: IdSchema,
  workspace_id: IdSchema,
  project_id: IdSchema.nullable(),
  name: z.string(),
  prefix: z.string(),
  last_used_at: IsoDateTimeSchema.nullable(),
  revoked_at: IsoDateTimeSchema.nullable(),
  created_at: IsoDateTimeSchema,
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ACTIVITY_ACTORS = ["human", "agent", "system"] as const;

export const ActivityLogSchema = z.object({
  id: IdSchema,
  workspace_id: IdSchema,
  project_id: IdSchema.nullable(),
  task_id: IdSchema.nullable(),
  event_type: z.string(),
  actor: z.enum(ACTIVITY_ACTORS),
  persona_alias: z.string().nullable(),
  /** Nama agen + repo untuk event agen (mis. `claude-code@web`), null untuk manusia/sistem. */
  agent_name: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  created_at: IsoDateTimeSchema,
});
export type ActivityLog = z.infer<typeof ActivityLogSchema>;

export const ProjectMetricsSchema = z.object({
  handoffs_7d: z.number().int(),
  revisions_7d: z.number().int(),
  blockers_7d: z.number().int(),
  avg_task_duration_ms: z.number().int().nullable(),
});
export type ProjectMetrics = z.infer<typeof ProjectMetricsSchema>;

// --- Body request (Web UI) --------------------------------------------------

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
  detected_stack: z.array(z.string().min(1).max(40)).max(20).default([]),
});

// Skema update ditulis eksplisit, bukan CreateX.partial(): di Zod 4 field ber-.default() tetap
// terisi default saat tidak dikirim, sehingga PATCH { name } diam-diam mengosongkan detected_stack.
export const UpdateProjectInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  detected_stack: z.array(z.string().min(1).max(40)).max(20).optional(),
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
  /** Persona penanggung jawab; role task otomatis mengikuti role persona. */
  persona_id: IdSchema.nullish(),
  requires_approval: z.boolean().default(false),
  depends_on: z.array(IdSchema).max(10).default([]),
  /** Task buatan manusia langsung TODO; DRAFT bila ingin ditinjau bersama rencana agen. */
  status: z.enum(["DRAFT", "TODO"]).default("TODO"),
});

export const UpdateTaskInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  prompt_instruction: z.string().min(1).max(8000).optional(),
  target_repo: RepoNameSchema.nullable().optional(),
  role: RoleSchema.nullable().optional(),
  persona_id: IdSchema.nullable().optional(),
  requires_approval: z.boolean().optional(),
  assignee_id: IdSchema.nullable().optional(),
  position: z.number().finite().optional(),
  /** Hanya boleh false: manusia menandai task stale sudah diperiksa ulang. */
  is_stale: z.literal(false).optional(),
});

export const SetDependenciesInput = z.object({
  depends_on: z.array(IdSchema).max(10),
});

/** Event task yang boleh dipicu manusia dari Web UI. */
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
  project_id: IdSchema.nullish(),
});

// Eksplisit, bukan PersonaInput.partial(): lihat catatan di UpdateProjectInput (rules ber-default).
export const UpdatePersonaInput = z.object({
  alias: AgentAliasSchema.optional(),
  role: RoleSchema.optional(),
  rules: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  repos: z.array(RepoNameSchema).max(10).optional(),
  project_id: IdSchema.nullish(),
});

export const CreateApiKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  project_id: IdSchema.nullish(),
});

export const CreateApiKeyOutput = z.object({
  api_key: ApiKeySchema,
  /** Kunci mentah. Hanya dikirim sekali, saat dibuat. */
  secret: z.string(),
});

// --- Agen (CLI / MCP lokal) -------------------------------------------------

/** Header yang dikirim CLI agar server tahu repo & proyek mana yang sedang bekerja. */
export const AGENT_HEADERS = {
  project: "x-catenext-project",
  repo: "x-catenext-repo",
  agent: "x-catenext-agent",
} as const;

export const API_KEY_PREFIX = "ctnx_";

export const ReleaseTaskInput = z.object({ task_id: IdSchema, lease_id: IdSchema.optional() });

export const SyncSkillsInput = z.object({
  revision: CommitShaSchema.optional(),
  previous_revision: CommitShaSchema.nullable().optional(),
  skills: z
    .array(
      z.object({
        name: z.string().min(1).max(48),
        when_to_use: z.string().min(1).max(160),
      }),
    )
    .max(100),
});

export const VerifyOutput = z.object({
  token_valid: z.literal(true),
  workspace_id: IdSchema,
  project: z.object({ id: IdSchema, name: z.string() }),
  repo_name: RepoNameSchema,
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
