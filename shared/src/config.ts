import { z } from "zod";
import {
  AgentAliasSchema,
  IdSchema,
  ProjectLayoutSchema,
  RepoNameSchema,
  RoleSchema,
} from "./common.js";

/** Versi skema .catenext/config.yaml yang dipahami versi paket ini. */
export const CONFIG_SCHEMA_VERSION = 1;

/** Platform IDE / CLI yang didukung untuk setup server MCP Catenext. */
export const SUPPORTED_PLATFORMS = [
  "claude-code",
  "cursor",
  "codex",
  "antigravity",
  "opencode",
  "windsurf",
  "vscode",
] as const;
export const PlatformIdSchema = z.enum(SUPPORTED_PLATFORMS);
export type PlatformId = z.infer<typeof PlatformIdSchema>;

export const DEFAULT_PLATFORMS: PlatformId[] = ["claude-code", "cursor", "codex", "antigravity"];

/**
 * Isi .catenext/config.yaml. File ini milik manusia: tidak ada tool MCP yang boleh
 * menulisnya. State orkestrator disimpan secara lokal di .catenext/catenext.sqlite.
 */
export const CatenextConfigSchema = z.object({
  schema_version: z.number().int().positive(),
  project_id: IdSchema,
  project_name: z.string().min(1).max(120).optional(),
  repo_name: RepoNameSchema,
  layout: ProjectLayoutSchema.default("polyrepo"),
  stack: z.array(z.string().min(1).max(40)).max(20).default([]),
  platforms: z.array(PlatformIdSchema).optional(),
  /** Path SQLite state bersama (opsional, untuk proyek multi-repo lintas folder). */
  state_file: z.string().min(1).max(300).optional(),
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
      message: `Config memakai schema_version ${schemaVersion}, CLI ini hanya mendukung ${supported}. Perbarui CLI Catenext ke versi terbaru.`,
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
