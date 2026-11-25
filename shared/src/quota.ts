import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

/**
 * Paket & kuota (blueprint §8). Saat peluncuran semua workspace memakai Free: Pro dan Team
 * sudah dimodelkan dan ditegakkan oleh kode yang sama, tetapi belum bisa dipilih
 * (`PLAN_AVAILABLE`) sampai billing tersambung.
 */
export const PLANS = ["free", "pro", "team"] as const;
export const PlanSchema = z.enum(PLANS);
export type Plan = z.infer<typeof PlanSchema>;

/** Paket yang sudah bisa diaktifkan pengguna. Pro/Team: "segera hadir". */
export const PLAN_AVAILABLE: Record<Plan, boolean> = { free: true, pro: false, team: false };

export const QUOTA_DIMENSIONS = [
  /** Jumlah proyek di workspace. */
  "projects",
  /** Epic yang belum semua task-nya DONE. */
  "active_epics",
  /** Task yang dibuat per bulan kalender (Web, CLI, dan create_tasks). */
  "tasks_per_month",
  /** Panggilan agen yang mengubah sesuatu: claim, complete, blocker, release, create_*, sync. */
  "write_calls_per_month",
  /** Panggilan baca agen: get_project_context, get_ready_tasks, list_*. Lebih longgar. */
  "read_calls_per_month",
  /** Persona di workspace (semua proyek). */
  "personas",
  /** Indeks skill per repo yang disinkronkan ke Cloud. */
  "skills",
] as const;
export const QuotaDimensionSchema = z.enum(QUOTA_DIMENSIONS);
export type QuotaDimension = z.infer<typeof QuotaDimensionSchema>;

export interface PlanLimits {
  /** null = tanpa batas (fair use). */
  limits: Record<QuotaDimension, number | null>;
  /** Handoff & activity log lebih tua dari ini dibersihkan. null = tidak pernah. */
  retention_days: number | null;
  /** Permintaan per menit per API key. */
  rate_per_minute: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    limits: {
      projects: 1,
      active_epics: 1,
      tasks_per_month: 25,
      write_calls_per_month: 500,
      read_calls_per_month: 5000,
      personas: 3,
      skills: 10,
    },
    retention_days: 14,
    rate_per_minute: 60,
  },
  pro: {
    limits: {
      projects: null,
      active_epics: null,
      tasks_per_month: null,
      write_calls_per_month: 20000,
      read_calls_per_month: 200000,
      personas: null,
      skills: null,
    },
    retention_days: 90,
    rate_per_minute: 300,
  },
  team: {
    limits: {
      projects: null,
      active_epics: null,
      tasks_per_month: null,
      write_calls_per_month: 100000,
      read_calls_per_month: 1000000,
      personas: null,
      skills: null,
    },
    retention_days: 365,
    rate_per_minute: 600,
  },
};

/** Peringatan lunak mulai 80% kuota. */
export const QUOTA_WARNING_RATIO = 0.8;

/** Header respons API berisi peringatan kuota (≥80%) yang ditampilkan CLI/MCP ke agen & manusia. */
export const QUOTA_WARNING_HEADER = "x-catenext-quota-warning";

export const QUOTA_LABELS: Record<QuotaDimension, string> = {
  projects: "Proyek",
  active_epics: "Epic aktif",
  tasks_per_month: "Task dibuat bulan ini",
  write_calls_per_month: "Panggilan agen (tulis) bulan ini",
  read_calls_per_month: "Panggilan agen (baca) bulan ini",
  personas: "Persona",
  skills: "Indeks skill per repo",
};

/** `error.details` untuk kode `quota_exceeded` (HTTP 402). */
export const QuotaExceededDetailsSchema = z.object({
  dimension: QuotaDimensionSchema,
  plan: PlanSchema,
  limit: z.number().int(),
  used: z.number().int(),
  /** Kapan kuota bulanan direset; null untuk kuota jumlah (proyek, persona, ...). */
  reset_at: IsoDateTimeSchema.nullable(),
  upgrade_url: z.string(),
});
export type QuotaExceededDetails = z.infer<typeof QuotaExceededDetailsSchema>;

export const UsageItemSchema = z.object({
  dimension: QuotaDimensionSchema,
  label: z.string(),
  used: z.number().int().min(0),
  limit: z.number().int().nullable(),
});

export const UsageOutput = z.object({
  plan: PlanSchema,
  plans: z.array(
    z.object({
      plan: PlanSchema,
      available: z.boolean(),
      limits: z.record(z.string(), z.number().nullable()),
    }),
  ),
  period_start: IsoDateTimeSchema,
  reset_at: IsoDateTimeSchema,
  retention_days: z.number().int().nullable(),
  usage: z.array(UsageItemSchema),
});
export type Usage = z.infer<typeof UsageOutput>;

/** Awal bulan kalender UTC & awal bulan berikutnya (reset kuota bulanan). */
export function monthWindow(now: Date = new Date()): { start: Date; reset: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, reset };
}

/** Pesan peringatan bila pemakaian ≥80%, atau null. */
export function quotaWarning(
  dimension: QuotaDimension,
  used: number,
  limit: number | null,
): string | null {
  if (limit === null || limit === 0 || used / limit < QUOTA_WARNING_RATIO) return null;
  return `${QUOTA_LABELS[dimension]}: ${used}/${limit} (${Math.round((used / limit) * 100)}% kuota).`;
}
