const LOCAL_PATHS = [
  ".catenext/catenext.sqlite",
  ".catenext/catenext.sqlite.lock/",
  ".catenext/catenext.sqlite-journal",
  ".catenext/catenext.sqlite-wal",
  ".catenext/catenext.sqlite-shm",
  ".catenext/state.json",
  ".catenext/state.json.bak",
  ".catenext/state.json.lock/",
  ".catenext/state.json.*.tmp",
  ".catenext/cache/",
];

/** Keep local state private, including after remove. Preserve existing ignore patterns. */
export function ensureGitignore(source: string | null): string {
  const text = source ?? "";
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (lines.some((line) => line === ".catenext/" || line === "/.catenext/")) return text;
  const missing = LOCAL_PATHS.filter(
    (path) => !lines.includes(path) && !lines.includes(`/${path}`),
  );
  if (missing.length === 0) return text;
  const prefix = text === "" ? "" : text.endsWith("\n") ? eol : `${eol}${eol}`;
  return `${text}${prefix}# Catenext: state dan cache lokal, jangan di-commit${eol}${missing.join(eol)}${eol}`;
}
