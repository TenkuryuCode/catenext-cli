export const CACHE_IGNORE = ".catenext/cache.json";
export const CACHE_DIR_IGNORE = ".catenext/cache/";

const COVERS = new Set([
  CACHE_IGNORE,
  `/${CACHE_IGNORE}`,
  ".catenext/cache.json",
  ".catenext/*.json",
  CACHE_DIR_IGNORE,
  `/${CACHE_DIR_IGNORE}`,
  ".catenext/cache",
]);

/** Tambahkan cache lokal ke .gitignore bila belum tercakup. Baris lain tidak diubah. */
export function ensureGitignore(source: string | null): string {
  const text = source ?? "";
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const missing: string[] = [];
  if (!lines.some((l) => COVERS.has(l) || l === CACHE_IGNORE)) missing.push(CACHE_IGNORE);
  if (
    !lines.some(
      (l) => l === CACHE_DIR_IGNORE || l === ".catenext/cache" || l === `/${CACHE_DIR_IGNORE}`,
    )
  ) {
    missing.push(CACHE_DIR_IGNORE);
  }
  if (missing.length === 0) return text;
  const prefix = text === "" ? "" : text.endsWith("\n") ? eol : `${eol}${eol}`;
  return `${text}${prefix}# Catenext: cache lokal, jangan di-commit${eol}${missing.join(eol)}${eol}`;
}
