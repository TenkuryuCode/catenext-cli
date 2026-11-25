import { z } from "zod";

/** Sumber yang bisa diindeks / dicari di Cloud (kode lokal = CLI saja). */
export const SEARCH_SOURCES = ["document", "skill", "task"] as const;
export const SearchSourceSchema = z.enum(SEARCH_SOURCES);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchContextInput = z.object({
  query: z.string().trim().min(1).max(500),
  sources: z.array(SearchSourceSchema).min(1).max(3).default(["document", "skill", "task"]),
  limit: z.number().int().min(1).max(20).default(8),
});
export type SearchContextInputType = z.input<typeof SearchContextInput>;

export const SearchHitSchema = z.object({
  source: SearchSourceSchema,
  ref: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  snippet: z.string().max(800),
  score: z.number(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchContextOutput = z.object({
  hits: z.array(SearchHitSchema),
  reranked: z.boolean(),
  /** true bila embedding/rerank memakai fallback lokal (tanpa API key provider). */
  degraded: z.boolean().default(false),
});
export type SearchContextOutputType = z.infer<typeof SearchContextOutput>;

/** Dimensi vektor default untuk embedder lokal deterministik. */
export const LOCAL_EMBED_DIMS = 64;
