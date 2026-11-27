import { z } from "zod";
import { estimateTokens } from "./common.js";
import { PullRequestRefSchema } from "./review.js";

/** Batas payload handoff agar tetap ~300–600 token. */
export const HANDOFF_LIMITS = {
  maxFilesModified: 15,
  maxPathLength: 200,
  maxKeyDecisions: 5,
  maxKeyDecisionLength: 150,
  maxVerificationCommandLength: 300,
  maxNotesLength: 500,
  maxTokens: 600,
} as const;

const CODE_FENCE = /```/;
const CODE_DECLARATION = /^(?:const|let|var)\s+[$\p{ID_Start}][$\p{ID_Continue}]*\s*=/u;
const PATH_CONTROL_OR_LINE_BREAK = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const FilePathSchema = z
  .string()
  .min(1)
  .max(HANDOFF_LIMITS.maxPathLength)
  .refine(
    (path) =>
      path.trim().length > 0 &&
      !PATH_CONTROL_OR_LINE_BREAK.test(path) &&
      !CODE_FENCE.test(path) &&
      !CODE_DECLARATION.test(path.trimStart()),
    "Isi path file tanpa karakter kontrol, baris baru, atau potongan kode",
  );

const NoCodeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !CODE_FENCE.test(s), "Jangan menempelkan blok kode; cukup rujuk path file");

/**
 * Ringkasan handoff terstruktur. Tidak pernah string bebas: agen berikutnya harus bisa
 * langsung tahu file mana yang berubah, keputusan apa yang diambil, dan cara memverifikasi.
 */
export const HandoffSummarySchema = z
  .object({
    files_modified: z.array(FilePathSchema).max(HANDOFF_LIMITS.maxFilesModified),
    key_decisions: z
      .array(NoCodeText(HANDOFF_LIMITS.maxKeyDecisionLength))
      .max(HANDOFF_LIMITS.maxKeyDecisions),
    verification_command: z
      .string()
      .min(1)
      .max(HANDOFF_LIMITS.maxVerificationCommandLength)
      .nullable(),
    notes_for_next_agent: NoCodeText(HANDOFF_LIMITS.maxNotesLength),
    pull_request: PullRequestRefSchema.optional(),
    git_branch: z.string().min(1).max(255),
    last_commit_hash: z.string().regex(/^[0-9a-f]{7,64}$/, "Hash commit git (hex, 7–64 karakter)"),
  })
  .refine((h) => !h.pull_request || h.last_commit_hash === h.pull_request.head_sha, {
    message: "SHA handoff harus sama dengan head SHA PR.",
  })
  .refine((h) => estimateHandoffTokens(h) <= HANDOFF_LIMITS.maxTokens, {
    message: `Ringkasan handoff melebihi ~${HANDOFF_LIMITS.maxTokens} token; ringkas lagi`,
  });

export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

export function estimateHandoffTokens(h: {
  files_modified: string[];
  key_decisions: string[];
  verification_command: string | null;
  notes_for_next_agent: string;
  git_branch: string;
  last_commit_hash: string;
}): number {
  return estimateTokens(JSON.stringify(h));
}
