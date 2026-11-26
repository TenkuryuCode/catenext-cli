import { z } from "zod";

/** ID entitas di Catenext (UUID). */
export const IdSchema = z.uuid();
export type Id = z.infer<typeof IdSchema>;

/** Slug huruf kecil: dipakai untuk repo_name, role, alias persona, dan nama skill. */
export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Harus slug huruf kecil (a-z, 0-9, '-' atau '_')");

/** Layout checkout git proyek: monorepo (satu git) vs polyrepo (clone terpisah). */
export const PROJECT_LAYOUTS = ["monorepo", "polyrepo"] as const;
export const ProjectLayoutSchema = z.enum(PROJECT_LAYOUTS);
export type ProjectLayout = z.infer<typeof ProjectLayoutSchema>;

/** Nama repo lokal sesuai `repo_name` di .catenext/config.yaml (mis. "backend", "frontend"). */
export const RepoNameSchema = SlugSchema;

/** Label sifat pekerjaan (architect, backend, ui, migration, testing, ...). */
export const RoleSchema = SlugSchema.max(32);

/** Nama panggilan persona agen (mis. "adel", "bambang"). */
export const AgentAliasSchema = SlugSchema.max(32);

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * Perkiraan kasar jumlah token (~4 karakter per token). Cukup untuk menjaga batas
 * payload tanpa menarik tokenizer sungguhan ke paket bersama.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}
