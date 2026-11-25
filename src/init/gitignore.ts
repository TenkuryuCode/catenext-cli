export const CACHE_IGNORE = ".catenext/cache.json";

const COVERS = new Set([
  CACHE_IGNORE,
  `/${CACHE_IGNORE}`,
  ".catenext/cache.json",
  ".catenext/*.json",
]);

/** Tambahkan .catenext/cache.json ke .gitignore bila belum tercakup. Baris lain tidak diubah. */
export function ensureGitignore(source: string | null): string {
  const text = source ?? "";
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => COVERS.has(l))) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const prefix = text === "" ? "" : text.endsWith("\n") ? eol : `${eol}${eol}`;
  return `${text}${prefix}# Catenext: cache lokal, jangan di-commit${eol}${CACHE_IGNORE}${eol}`;
}
