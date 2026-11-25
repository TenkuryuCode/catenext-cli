import { z } from "zod";
import {
  AgentAliasSchema,
  IdSchema,
  IsoDateTimeSchema,
  RepoNameSchema,
  RoleSchema,
} from "./common.js";
import { findCycle } from "./dag.js";
import { HandoffSummarySchema } from "./handoff.js";
import {
  SKILL_LIMITS,
  SkillContentSchema,
  SkillIndexEntrySchema,
  SkillNameSchema,
} from "./skill.js";
import { BlockerCategorySchema, TaskStatusSchema, TaskSummarySchema } from "./task.js";

/**
 * Kontrak input/output untuk setiap tool MCP yang diekspos ke agen.
 *
 * Catatan guardrail: repo_name dan project_id TIDAK pernah menjadi input tool. Server MCP
 * lokal membacanya sendiri dari .catenext/config.yaml, sehingga agen tidak bisa menarik
 * atau mengunci task milik repo lain.
 */

const PersonaFilter = {
  agent_alias: AgentAliasSchema.optional(),
  role: RoleSchema.optional(),
};

export const PersonaSchema = z.object({
  alias: AgentAliasSchema,
  role: RoleSchema,
  rules: z.array(z.string().min(1).max(300)).max(30),
});
export type Persona = z.infer<typeof PersonaSchema>;

const DependencyHandoffSchema = z.object({
  task_id: IdSchema,
  title: z.string(),
  handoff_summary: HandoffSummarySchema,
});

// --- get_project_context ----------------------------------------------------

export const GetProjectContextInput = z.object(PersonaFilter);
export const GetProjectContextOutput = z.object({
  project: z.object({
    id: IdSchema,
    name: z.string(),
    repo_name: RepoNameSchema,
    stack: z.array(z.string()),
  }),
  /** Aturan keras untuk agen (mis. jangan mengedit config MCP). Statis di atas agar ramah cache. */
  directives: z.array(z.string()),
  persona: PersonaSchema.optional(),
  epic_summary: z.string().max(1000).optional(),
  /** Tier 1: indeks skill saja, isi lengkap lewat load_skill. */
  skills: z.array(SkillIndexEntrySchema),
  /**
   * Handoff dari dependensi langsung task aktif (dependency-scoped context). Jika belum ada
   * task aktif: handoff dependensi task yang siap diklaim (maks. 5).
   */
  recent_handoffs: z.array(DependencyHandoffSchema),
});

// --- get_ready_tasks --------------------------------------------------------

export const GetReadyTasksInput = z.object({
  ...PersonaFilter,
  limit: z.number().int().min(1).max(50).default(10),
});
export const GetReadyTasksOutput = z.object({
  tasks: z.array(TaskSummarySchema),
});

// --- claim_task -------------------------------------------------------------

export const ClaimTaskInput = z.object({
  task_id: IdSchema,
});
export const ClaimTaskOutput = z.object({
  task: z.object({
    id: IdSchema,
    title: z.string(),
    prompt_instruction: z.string(),
    status: z.literal("IN_PROGRESS"),
    role: RoleSchema.optional(),
    target_repo: RepoNameSchema.optional(),
    revision_count: z.number().int().min(0),
  }),
  lease_expires_at: IsoDateTimeSchema,
  dependencies: z.array(DependencyHandoffSchema),
  /** Diisi bila task diambil dari REVISION_REQUESTED. */
  revision: z
    .object({
      review_feedback: z.string(),
      previous_handoff: HandoffSummarySchema.nullable(),
    })
    .optional(),
  /** Peringatan bila branch lokal berbeda dari git_branch handoff dependensi. */
  warnings: z.array(z.string()).default([]),
});

// --- complete_handoff -------------------------------------------------------

export const CompleteHandoffInput = z.object({
  task_id: IdSchema,
  handoff_summary: HandoffSummarySchema,
});
export const CompleteHandoffOutput = z.object({
  task_id: IdSchema,
  status: z.enum(["DONE", "NEEDS_REVIEW"]),
  unlocked_task_ids: z.array(IdSchema),
  /** Mis. saran mereset sesi chat (1 Task = 1 Fresh Session). */
  next_step_hint: z.string(),
});

// --- report_blocker ---------------------------------------------------------

export const ReportBlockerInput = z.object({
  task_id: IdSchema,
  category: BlockerCategorySchema,
  reason: z.string().min(10).max(1000),
});
export const ReportBlockerOutput = z.object({
  task_id: IdSchema,
  status: z.literal("BLOCKED"),
});

// --- create_tasks -----------------------------------------------------------

export const MAX_TASKS_PER_PLAN = 30;

/** Referensi lokal di dalam satu rencana, mis. "t1", "db-schema". */
const PlanRefSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "ref harus huruf kecil, angka, '-' atau '_'");

export const PlannedTaskSchema = z.object({
  ref: PlanRefSchema,
  title: z.string().min(1).max(200),
  prompt_instruction: z.string().min(1).max(8000),
  /** Berisi ref task lain dalam rencana ini, atau UUID task yang sudah ada. */
  depends_on: z
    .array(z.union([PlanRefSchema, IdSchema]))
    .max(10)
    .default([]),
  target_repo: RepoNameSchema.optional(),
  role: RoleSchema.optional(),
  requires_approval: z.boolean().default(false),
});

export const CreateTasksInput = z
  .object({
    epic_id: IdSchema,
    tasks: z.array(PlannedTaskSchema).min(1).max(MAX_TASKS_PER_PLAN),
  })
  .superRefine((plan, ctx) => {
    const refs = new Set<string>();
    plan.tasks.forEach((t, i) => {
      if (refs.has(t.ref)) {
        ctx.addIssue({
          code: "custom",
          message: `ref "${t.ref}" duplikat`,
          path: ["tasks", i, "ref"],
        });
      }
      refs.add(t.ref);
    });

    const isUuid = (v: string) => IdSchema.safeParse(v).success;
    plan.tasks.forEach((t, i) => {
      t.depends_on.forEach((dep, j) => {
        if (dep === t.ref) {
          ctx.addIssue({
            code: "custom",
            message: "Task tidak boleh bergantung pada dirinya sendiri",
            path: ["tasks", i, "depends_on", j],
          });
        } else if (!isUuid(dep) && !refs.has(dep)) {
          ctx.addIssue({
            code: "custom",
            message: `depends_on "${dep}" bukan ref di rencana ini maupun UUID task`,
            path: ["tasks", i, "depends_on", j],
          });
        }
      });
    });

    const edges = plan.tasks.flatMap((t) =>
      t.depends_on.filter((d) => refs.has(d)).map((d) => ({ task: t.ref, dependsOn: d })),
    );
    const cycle = findCycle(edges);
    if (cycle) {
      ctx.addIssue({
        code: "custom",
        message: `Dependensi melingkar: ${cycle.join(" -> ")}`,
        path: ["tasks"],
      });
    }
  });

export const CreateTasksOutput = z.object({
  created: z.array(
    z.object({
      ref: z.string(),
      task_id: IdSchema,
      status: TaskStatusSchema,
    }),
  ),
});

// --- load_skill -------------------------------------------------------------

export const LoadSkillInput = z.object({
  name: SkillNameSchema,
});
export const LoadSkillOutput = z.object({
  name: SkillNameSchema,
  when_to_use: z.string(),
  content: z.string(),
});

// --- save_repo_skill --------------------------------------------------------

export const SaveRepoSkillInput = z.object({
  name: SkillNameSchema,
  when_to_use: z.string().min(1).max(SKILL_LIMITS.maxWhenToUseLength),
  content: SkillContentSchema,
});
export const SaveRepoSkillOutput = z.object({
  path: z.string(),
  created: z.boolean(),
});

// --- list_epics / create_epic -----------------------------------------------

const EpicSummarySchema = z.object({
  id: IdSchema,
  title: z.string(),
  description: z.string().nullable(),
  /** Jumlah task per status, mis. { DRAFT: 3, TODO: 1 }. */
  task_counts: z.record(z.string(), z.number().int().min(0)),
});

export const ListEpicsInput = z.object({});
export const ListEpicsOutput = z.object({
  epics: z.array(EpicSummarySchema),
});

export const CreateEpicToolInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
});
export const CreateEpicToolOutput = z.object({
  epic: EpicSummarySchema,
});

// --- list_personas / upsert_persona -----------------------------------------

export const ListPersonasInput = z.object({});
export const ListPersonasOutput = z.object({
  personas: z.array(
    PersonaSchema.extend({
      /** "project" = khusus proyek ini (bisa diubah agen); "workspace" = global, hanya dari Web. */
      scope: z.enum(["project", "workspace"]),
    }),
  ),
});

/** Agen hanya boleh membuat/mengubah persona khusus proyeknya sendiri, bukan tingkat workspace. */
export const UpsertPersonaInput = PersonaSchema.extend({
  rules: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
});
export const UpsertPersonaOutput = z.object({
  persona: PersonaSchema,
  created: z.boolean(),
});

// --- Registry ---------------------------------------------------------------

export interface McpToolContract<I extends z.ZodType, O extends z.ZodType> {
  description: string;
  input: I;
  output: O;
}

function tool<I extends z.ZodType, O extends z.ZodType>(
  description: string,
  input: I,
  output: O,
): McpToolContract<I, O> {
  return { description, input, output };
}

export const MCP_TOOLS = {
  get_project_context: tool(
    "Baca konteks proyek: identitas repo, aturan persona, indeks skill, dan handoff dependensi langsung.",
    GetProjectContextInput,
    GetProjectContextOutput,
  ),
  get_ready_tasks: tool(
    "Daftar ringkas task siap dikerjakan untuk repo ini (semua dependensi DONE).",
    GetReadyTasksInput,
    GetReadyTasksOutput,
  ),
  claim_task: tool(
    "Kunci task (lease 30 menit) dan ambil instruksi lengkap beserta handoff dependensinya.",
    ClaimTaskInput,
    ClaimTaskOutput,
  ),
  complete_handoff: tool(
    "Selesaikan task dengan ringkasan handoff terstruktur (DONE, atau NEEDS_REVIEW bila ada approval gate).",
    CompleteHandoffInput,
    CompleteHandoffOutput,
  ),
  report_blocker: tool(
    "Lepas lock dan tandai task BLOCKED dengan alasan spesifik bila tidak bisa dilanjutkan.",
    ReportBlockerInput,
    ReportBlockerOutput,
  ),
  create_tasks: tool(
    "Ajukan rencana task berdependensi untuk sebuah epic (masuk sebagai DRAFT untuk ditinjau manusia).",
    CreateTasksInput,
    CreateTasksOutput,
  ),
  list_epics: tool(
    "Daftar epic di proyek ini beserta jumlah task per status. Pakai epic_id-nya untuk create_tasks.",
    ListEpicsInput,
    ListEpicsOutput,
  ),
  create_epic: tool(
    "Buat epic baru di proyek ini (mis. 'Fitur login'), lalu pecah dengan create_tasks.",
    CreateEpicToolInput,
    CreateEpicToolOutput,
  ),
  list_personas: tool(
    "Daftar persona agen (alias, role, aturan) yang berlaku untuk proyek ini.",
    ListPersonasInput,
    ListPersonasOutput,
  ),
  upsert_persona: tool(
    "Buat atau perbarui persona khusus proyek ini (alias unik, role, aturan). Persona tingkat workspace hanya bisa diubah dari Web.",
    UpsertPersonaInput,
    UpsertPersonaOutput,
  ),
  load_skill: tool(
    "Muat isi lengkap skill repo dari .catenext/skills/<name>.md saat relevan dengan task aktif.",
    LoadSkillInput,
    LoadSkillOutput,
  ),
  save_repo_skill: tool(
    "Buat atau perbarui skill repo (maks. 500 kata, tanpa code dump) di .catenext/skills/<name>.md.",
    SaveRepoSkillInput,
    SaveRepoSkillOutput,
  ),
} as const;

export type McpToolName = keyof typeof MCP_TOOLS;
export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as McpToolName[];

export type McpToolInput<N extends McpToolName> = z.input<(typeof MCP_TOOLS)[N]["input"]>;
export type McpToolOutput<N extends McpToolName> = z.output<(typeof MCP_TOOLS)[N]["output"]>;
