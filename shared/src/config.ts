import { z } from "zod";
import { AgentAliasSchema, IdSchema, RepoNameSchema, RoleSchema } from "./common.js";

/** Versi skema .catenext/config.yaml yang dipahami versi paket ini. */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Isi .catenext/config.yaml. File ini milik manusia: tidak ada tool MCP yang boleh
 * menulisnya. Persona & rules SSOT-nya ada di Cloud; bagian `overrides` hanya
 * penyesuaian lokal opsional.
 */
export const CatenextConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  project_id: IdSchema,
  repo_name: RepoNameSchema,
  stack: z.array(z.string().min(1).max(40)).max(20).default([]),
  /** URL Catenext Cloud API; kosong = default bawaan CLI. */
  api_url: z.url().optional(),
  overrides: z
    .object({
      default_agent_alias: AgentAliasSchema.optional(),
      default_role: RoleSchema.optional(),
      extra_rules: z.array(z.string().min(1).max(300)).max(20).optional(),
    })
    .optional(),
});

export type CatenextConfig = z.infer<typeof CatenextConfigSchema>;

export type ConfigCompatibility =
  | { ok: true }
  | { ok: false; reason: "too_new" | "too_old"; message: string };

/** Cek ringan saat init/boot agar CLI lama tidak salah membaca config baru. */
export function checkConfigCompatibility(
  schemaVersion: number,
  supported: number = CONFIG_SCHEMA_VERSION,
): ConfigCompatibility {
  if (schemaVersion > supported) {
    return {
      ok: false,
      reason: "too_new",
      message: `Config memakai schema_version ${schemaVersion}, CLI ini hanya mendukung ${supported}. Perbarui CLI Catenext ke versi terbaru (sementara: git pull lalu pnpm build).`,
    };
  }
  if (schemaVersion < supported) {
    return {
      ok: false,
      reason: "too_old",
      message: `Config memakai schema_version ${schemaVersion}. Jalankan \`catenext sync --fix\` untuk memperbaruinya ke ${supported}.`,
    };
  }
  return { ok: true };
}
