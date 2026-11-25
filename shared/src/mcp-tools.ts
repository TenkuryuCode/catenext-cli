import { z } from "zod";
import { ReleaseTaskInput } from "./api.js";
import {
  AgentAliasSchema,
  IdSchema,
  IsoDateTimeSchema,
  RepoNameSchema,
  RoleSchema,
} from "./common.js";
import { findCycle } from "./dag.js";
import {
  DocumentIndexEntrySchema,
  GetDocumentInput,
  ProjectDocumentSchema,
  SaveDocumentInput,
  SaveDocumentOutput,
} from "./documents.js";
import { HandoffSummarySchema } from "./handoff.js";
import { CommitShaSchema, ReviewInput, ReviewOutput } from "./review.js";
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

/** Repo yang dipegang persona. Kosong = boleh semua repo proyek. */
export const PersonaReposSchema = z.array(RepoNameSchema).max(10);

export const PersonaSchema = z.object({
  alias: AgentAliasSchema,
  role: RoleSchema,
  rules: z.array(z.string().min(1).max(300)).max(30),
  repos: PersonaReposSchema.default([]),
});
export type Persona = z.infer<typeof PersonaSchema>;

const DependencyHandoffSchema = z.object({
  task_id: IdSchema,
  title: z.string(),
  handoff_summary: HandoffSummarySchema,
  integrated_commit: z.object({ branch: z.string(), sha: CommitShaSchema }).optional(),
});

// --- get_project_context ----------------------------------------------------

export const GetProjectContextInput = z.object({ ...PersonaFilter, lease_id: IdSchema.optional() });
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
  skill_revision: CommitShaSchema.optional(),
  /**
   * Handoff dari dependensi langsung task aktif (dependency-scoped context). Jika belum ada
   * task aktif: handoff dependensi task yang siap diklaim (maks. 5).
   */
  recent_handoffs: z.array(DependencyHandoffSchema),
  /** Repo yang dikenal proyek, agar orchestrator tahu ke mana task bisa diarahkan. */
  project_repos: z.array(RepoNameSchema).default([]),
  /** Indeks dokumen proyek di Cloud (blueprint, ERD, ...); isi lewat get_document. */
  documents: z.array(DocumentIndexEntrySchema).default([]),
});

// --- get_project_board (orchestrator) ---------------------------------------

/** Tampilan seluruh proyek lintas repo untuk orchestrator: siapa memegang apa, apa berikutnya. */
export const GetProjectBoardInput = z.object({
  epic_id: IdSchema.optional(),
  /** Tanpa filter: semua status. */
  status: z.array(TaskStatusSchema).max(7).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export const BoardTaskSchema = z.object({
  id: IdSchema,
  title: z.string(),
  epic_id: IdSchema,
  status: TaskStatusSchema,
  target_repo: RepoNameSchema.nullable(),
  role: RoleSchema.nullable(),
  persona: AgentAliasSchema.nullable(),
  depends_on: z.array(IdSchema),
  /** TODO/REVISION_REQUESTED dengan semua dependensi DONE. */
  is_ready: z.boolean(),
  is_stale: z.boolean(),
  revision_count: z.number().int().min(0),
  /** Repo yang sedang memegang lease (IN_PROGRESS). */
  locked_by_repo: RepoNameSchema.nullable(),
  blocker_reason: z.string().nullable(),
});
export const GetProjectBoardOutput = z.object({
  epics: z.array(
    z.object({
      id: IdSchema,
      title: z.string(),
      counts: z.record(z.string(), z.number().int()),
    }),
  ),
  /** Repo yang dikenal proyek (dari task, skill, dan persona) beserta persona pemegangnya. */
  repos: z.array(z.object({ repo: RepoNameSchema, personas: z.array(AgentAliasSchema) })),
  personas: z.array(PersonaSchema),
  tasks: z.array(BoardTaskSchema),
  truncated: z.boolean(),
});

// --- get_ready_tasks --------------------------------------------------------

export const GetReadyTasksInput = z.object({
  ...PersonaFilter,
  lease_id: IdSchema.optional(),
  limit: z.number().int().min(1).max(50).default(10),
});
export const GetReadyTasksOutput = z.object({
  tasks: z.array(TaskSummarySchema),
});

// --- claim_task -------------------------------------------------------------

export const ClaimTaskInput = z.object({
  worktree: z
    .object({
      session_id: IdSchema,
      branch: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[a-zA-Z0-9_./-]+$/)
        .refine((s) => s !== "HEAD" && !s.startsWith("-") && !s.includes("..")),
    })
    .optional(),
  task_id: IdSchema,
  /** Alias persona yang sedang dipakai agen. Task milik persona lain ditolak. */
  agent_alias: AgentAliasSchema.optional(),
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
  /** Persona penanggung jawab task (atau persona agen): ikuti aturan dan batas wilayahnya. */
  persona: PersonaSchema.optional(),
  lease_expires_at: IsoDateTimeSchema,
  lease_id: IdSchema.optional(),
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
  lease_id: IdSchema.optional(),
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
  lease_id: IdSchema.optional(),
  task_id: IdSchema,
  category: BlockerCategorySchema,
  reason: z.string().min(10).max(1000),
});
export const ReportBlockerOutput = z.object({
  task_id: IdSchema,
  status: z.literal("BLOCKED"),
});

// --- manage_task (orchestrator) ---------------------------------------------

/**
 * Aksi orchestrator (agen utama sesi) atas task yang sudah ada. Revisi tidak membuat task
 * baru: task dipindah ke REVISION_REQUESTED dan diambil lagi oleh persona penanggung jawab.
 */
export const MANAGE_TASK_ACTIONS = ["request_revision", "assign"] as const;

export const ManageTaskInput = z
  .object({
    action: z.enum(MANAGE_TASK_ACTIONS),
    task_id: IdSchema,
    /** Wajib untuk request_revision: apa yang harus diperbaiki (feedback manusia/orchestrator). */
    feedback: z.string().trim().min(5).max(2000).optional(),
    /** Persona penanggung jawab baru. null = lepas persona (task diambil berdasarkan role). */
    agent_alias: AgentAliasSchema.nullable().optional(),
    /** Role task tanpa persona tertentu. Diabaikan bila agent_alias diisi (role ikut persona). */
    role: RoleSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "request_revision" && !v.feedback) {
      ctx.addIssue({
        code: "custom",
        path: ["feedback"],
        message: "request_revision butuh feedback: apa yang harus diperbaiki.",
      });
    }
    if (v.action === "assign" && v.agent_alias === undefined && v.role === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agent_alias"],
        message: "assign butuh agent_alias atau role.",
      });
    }
  });
export const ManageTaskOutput = z.object({
  task_id: IdSchema,
  status: TaskStatusSchema,
  persona: AgentAliasSchema.nullable(),
  role: RoleSchema.nullable(),
  revision_count: z.number().int().min(0),
  stale_task_ids: z.array(IdSchema),
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
  /** Alias persona penanggung jawab (lihat list_personas). Role task mengikuti persona ini. */
  persona: AgentAliasSchema.optional(),
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
  revision: CommitShaSchema.optional(),
});
export const LoadSkillOutput = z.object({
  name: SkillNameSchema,
  revision: CommitShaSchema.optional(),
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
  /**
   * Tidak dikirim = aturan dipertahankan; persona proyek baru mewarisi aturan persona master
   * (workspace) dengan alias yang sama.
   */
  rules: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  /** Tidak dikirim = repo persona yang ada dipertahankan. */
  repos: PersonaReposSchema.optional(),
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
  release_task: tool(
    "Lepas lease task supaya sesi lain bisa mengambilnya.",
    ReleaseTaskInput,
    z.object({ task_id: IdSchema, status: z.enum(["TODO", "REVISION_REQUESTED"]) }),
  ),
  get_project_board: tool(
    "Khusus orchestrator: papan seluruh proyek lintas repo (epic, task, status, persona, repo, dependensi) untuk membagi, melanjutkan, dan menyerahkan task.",
    GetProjectBoardInput,
    GetProjectBoardOutput,
  ),
  get_document: tool(
    "Baca isi dokumen proyek di Cloud (blueprint, ERD, arsitektur, kontrak API, keputusan) berdasarkan slug dari get_project_context.",
    GetDocumentInput,
    ProjectDocumentSchema,
  ),
  save_document: tool(
    "Buat/perbarui dokumen proyek di Cloud agar sesi/IDE/CLI lain tidak kehilangan konteks. Markdown ringkas, tanpa code dump atau secret. Kirim expected_version dari versi yang Anda baca (0 = baru).",
    SaveDocumentInput,
    SaveDocumentOutput,
  ),
  manage_task: tool(
    "Khusus orchestrator (agen utama, bukan subagent persona): request_revision memindahkan task NEEDS_REVIEW/DONE ke kolom Revisi dengan feedback (bukan membuat task baru) dan opsional mengganti persona; assign mengatur persona/role task yang belum dikerjakan.",
    ManageTaskInput,
    ManageTaskOutput,
  ),
  review_pull_request: tool(
    "Antrean, claim, hasil review, atau cek merge pull request.",
    z.object({ request: ReviewInput }),
    ReviewOutput,
  ),
  get_project_context: tool(
    "Baca konteks proyek: identitas repo, aturan persona, indeks skill, dan handoff dependensi langsung.",
    GetProjectContextInput,
    GetProjectContextOutput,
  ),
  get_ready_tasks: tool(
    "Daftar ringkas task siap dikerjakan untuk repo ini (semua dependensi DONE). Dengan agent_alias, hanya task milik persona itu (dan task tanpa penanggung jawab yang role-nya cocok).",
    GetReadyTasksInput,
    GetReadyTasksOutput,
  ),
  claim_task: tool(
    "Kunci task (lease 30 menit) dan ambil instruksi lengkap, handoff dependensi, serta aturan persona penanggung jawabnya. Kirim agent_alias bila bekerja sebagai persona tertentu.",
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
