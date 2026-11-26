import type { SearchHit, SearchSource } from "@catenext/shared";

export interface LocalSearchItem {
  source: SearchSource;
  ref: string;
  title: string;
  text: string;
}

const words = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Rank exact token matches; title hits weigh more. No provider, external cache or fuzzy claims. */
export function searchLocalContext(
  query: string,
  items: LocalSearchItem[],
  limit: number,
): SearchHit[] {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  return items
    .flatMap(({ text, ...item }) => {
      const tokens = new Set(words(text));
      const title = new Set(words(item.title));
      const score = terms.reduce(
        (sum, term) => sum + (title.has(term) ? 2 : 0) + (tokens.has(term) ? 1 : 0),
        0,
      );
      if (!score) return [];
      const compact = text.replace(/\s+/g, " ").trim();
      const lower = compact.toLowerCase();
      const offset = Math.min(
        ...terms.map((term) => {
          const index = lower.indexOf(term);
          return index === -1 ? Infinity : index;
        }),
      );
      const start = Number.isFinite(offset) ? Math.max(0, offset - 80) : 0;
      return [
        { ...item, score: score / (3 * terms.length), snippet: compact.slice(start, start + 800) },
      ];
    })
    .sort(
      (a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.ref.localeCompare(b.ref),
    )
    .slice(0, limit);
}
