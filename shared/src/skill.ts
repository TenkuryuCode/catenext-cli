import { z } from "zod";
import { countWords, IsoDateTimeSchema, RepoNameSchema, SlugSchema } from "./common.js";

export const SKILL_LIMITS = {
  maxWords: 500,
  maxWhenToUseLength: 160,
  /** Blok kode pendek (perintah, contoh nama) boleh; code dump tidak. */
  maxCodeBlockLines: 15,
} as const;

export const SkillNameSchema = SlugSchema.max(48);

export const SkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  when_to_use: z.string().min(1).max(SKILL_LIMITS.maxWhenToUseLength),
  updated_at: IsoDateTimeSchema,
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

function longestCodeBlockLines(markdown: string): number {
  let longest = 0;
  const blocks = markdown.match(/```[\s\S]*?```/g) ?? [];
  for (const block of blocks) {
    const lines = block.split("\n").length - 2;
    if (lines > longest) longest = lines;
  }
  return longest;
}

/** Isi skill (Markdown tanpa frontmatter): path, konvensi, perintah tes, pitfalls. */
export const SkillContentSchema = z
  .string()
  .min(1)
  .refine((s) => countWords(s) <= SKILL_LIMITS.maxWords, {
    message: `Skill maksimal ${SKILL_LIMITS.maxWords} kata`,
  })
  .refine((s) => longestCodeBlockLines(s) <= SKILL_LIMITS.maxCodeBlockLines, {
    message: `Blok kode maksimal ${SKILL_LIMITS.maxCodeBlockLines} baris; rujuk path file, jangan menyalin kode`,
  });

/** Indeks Tier 1 (~10–15 token per skill). Hanya ini yang dikirim ke Cloud. */
export const SkillIndexEntrySchema = z.object({
  name: SkillNameSchema,
  when_to_use: z.string().min(1).max(SKILL_LIMITS.maxWhenToUseLength),
  repo_name: RepoNameSchema,
});
export type SkillIndexEntry = z.infer<typeof SkillIndexEntrySchema>;

/** Path relatif file skill di repo. */
export function skillPath(name: string): string {
  return `.catenext/skills/${SkillNameSchema.parse(name)}.md`;
}
