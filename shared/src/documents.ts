import { z } from "zod";
import { IsoDateTimeSchema, SlugSchema } from "./common.js";

/**
 * Dokumen proyek lokal: blueprint, ERD, arsitektur, kontrak API, keputusan, runbook.
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
  /** Waktu soft-archive (Epic B); null = dokumen aktif. */
  archived_at: IsoDateTimeSchema.nullable().optional(),
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
   * Versi yang dibaca penulis. 0 atau kosong hanya untuk dokumen baru.
   * Simpan versi lama ditolak (document_version_conflict) agar sesi lain tidak tertimpa.
   */
  expected_version: z.number().int().min(0).optional(),
});
export type SaveDocumentInputType = z.infer<typeof SaveDocumentInput>;

export const DocumentHeadingSchema = z.object({
  level: z.number().int().min(1).max(6),
  title: z.string(),
  line: z.number().int().min(1),
});
export type DocumentHeading = z.infer<typeof DocumentHeadingSchema>;

export const GetDocumentInput = z.object({
  slug: DocumentSlugSchema,
  /** Kembalikan hanya daftar heading Markdown tanpa isi lengkap. */
  outline_only: z.boolean().optional(),
  /** Kembalikan hanya bagian Markdown yang cocok dengan judul heading ini. */
  section: z.string().trim().min(1).max(200).optional(),
});

export const GetDocumentOutput = ProjectDocumentSchema.extend({
  outline: z.array(DocumentHeadingSchema).optional(),
  section: z.string().optional(),
  truncated: z.boolean().optional(),
});
export type GetDocumentOutputType = z.infer<typeof GetDocumentOutput>;

export const SaveDocumentOutput = z.object({
  document: DocumentIndexEntrySchema,
  created: z.boolean(),
});

export const ArchiveDocumentInput = z.object({
  slug: DocumentSlugSchema,
});
export type ArchiveDocumentInputType = z.infer<typeof ArchiveDocumentInput>;

export const ArchiveDocumentOutput = z.object({
  document: DocumentIndexEntrySchema,
});
export type ArchiveDocumentOutputType = z.infer<typeof ArchiveDocumentOutput>;

export const RestoreDocumentInput = z.object({
  slug: DocumentSlugSchema,
});
export type RestoreDocumentInputType = z.infer<typeof RestoreDocumentInput>;

export const RestoreDocumentOutput = z.object({
  document: DocumentIndexEntrySchema,
});
export type RestoreDocumentOutputType = z.infer<typeof RestoreDocumentOutput>;
