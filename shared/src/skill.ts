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
  let fence: { marker: string; lines: number } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = match?.[1];
    const rest = match?.[2]?.trim() ?? "";
    if (!fence) {
      if (marker && (!marker.startsWith("`") || !rest.includes("`"))) {
        fence = { marker, lines: 0 };
      }
    } else if (marker?.startsWith(fence.marker) && !rest) {
      fence = undefined;
    } else {
      longest = Math.max(longest, ++fence.lines);
    }
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

/** Indeks Tier 1 (~10–15 token per skill). Isi lengkap dibaca terpisah dari repo. */
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
