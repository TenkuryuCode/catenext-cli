import { z } from "zod";
import { IsoDateTimeSchema, SlugSchema } from "./common.js";

/**
 * Dokumen proyek di Cloud: blueprint, ERD, arsitektur, kontrak API, keputusan, runbook.
 * Konteks bersama lintas sesi/IDE/CLI untuk orchestrator. Markdown pendek, bukan source code.
 */
export const DOCUMENT_KINDS = [
  "blueprint",
  "erd",
  "architecture",
  "api_contract",
  "decision",
  "runbook",
  "other",
] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const DOCUMENT_LIMITS = {
  /** Karakter per dokumen (~15k token). Lebih dari itu: pecah per bagian. */
  content: 60_000,
  perProject: 50,
} as const;

export const DocumentSlugSchema = SlugSchema.max(64);

export const DocumentIndexEntrySchema = z.object({
  slug: DocumentSlugSchema,
  title: z.string(),
  kind: DocumentKindSchema,
  version: z.number().int().min(1),
  /** "human:<nama>" atau nama agen (mis. claude-code@be). */
  updated_by: z.string(),
  updated_at: IsoDateTimeSchema,
  /** Panjang isi dalam karakter, agar agen bisa menimbang biaya membaca. */
  size: z.number().int().min(0),
});
export type DocumentIndexEntry = z.infer<typeof DocumentIndexEntrySchema>;

export const ProjectDocumentSchema = DocumentIndexEntrySchema.extend({
  content: z.string(),
});
export type ProjectDocument = z.infer<typeof ProjectDocumentSchema>;

export const SaveDocumentInput = z.object({
  slug: DocumentSlugSchema,
  title: z.string().trim().min(1).max(120),
  kind: DocumentKindSchema,
  content: z.string().trim().min(1).max(DOCUMENT_LIMITS.content),
  /**
   * Versi yang dibaca penulis. 0 = dokumen baru. Bila versi di server sudah berubah, simpan
   * ditolak (document_version_conflict) agar sesi lain tidak tertimpa diam-diam.
   */
  expected_version: z.number().int().min(0).optional(),
});
export type SaveDocumentInputType = z.infer<typeof SaveDocumentInput>;

export const GetDocumentInput = z.object({ slug: DocumentSlugSchema });
export const SaveDocumentOutput = z.object({
  document: DocumentIndexEntrySchema,
  created: z.boolean(),
});
