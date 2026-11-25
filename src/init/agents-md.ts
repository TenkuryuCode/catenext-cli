import { CLI_FALLBACK_RULES, GENERAL_RULES, ORCHESTRATOR_RULES } from "@catenext/shared";

/**
 * Blok Catenext di AGENTS.md: aturan orchestrator untuk agen utama (dibaca Claude Code,
 * Cursor, Codex, OpenCode, dll.) plus fallback CLI untuk agen tanpa MCP. Dibatasi penanda
 * agar `init` idempoten dan `remove` bisa membersihkannya tanpa menyentuh isi lain.
 */
export const AGENTS_MD = "AGENTS.md";
export const BLOCK_START = "<!-- catenext:start -->";
export const BLOCK_END = "<!-- catenext:end -->";

export function renderAgentsBlock(): string {
  return [
    BLOCK_START,
    "## Catenext: orchestrator & subagent",
    "",
    "Repo ini memakai Catenext lewat tool MCP `catenext` (atau CLI `catenext` bila MCP tidak ada).",
    "",
    ...ORCHESTRATOR_RULES,
    "",
    ...CLI_FALLBACK_RULES,
    "",
    ...GENERAL_RULES,
    BLOCK_END,
  ].join("\n");
}

const BLOCK_RE = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}`);

/** Sisipkan atau perbarui blok; isi AGENTS.md lain tidak diubah. */
export function upsertAgentsBlock(source: string | null): string {
  const block = renderAgentsBlock();
  if (source === null || source.trim() === "") return `# AGENTS.md\n\n${block}\n`;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = eol === "\n" ? block : block.replace(/\n/g, eol);
  if (BLOCK_RE.test(source)) return source.replace(BLOCK_RE, normalized);
  const sep = source.endsWith(`${eol}${eol}`) ? "" : source.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${source}${sep}${normalized}${eol}`;
}

/** Hapus blok (untuk `catenext remove`). Mengembalikan null bila file jadi kosong. */
export function removeAgentsBlock(source: string): string | null {
  if (!BLOCK_RE.test(source)) return source;
  const out = source.replace(new RegExp(`(\\r?\\n)*${BLOCK_RE.source}(\\r?\\n)?`), "\n");
  const rest = out.trim();
  if (rest === "" || rest === "# AGENTS.md") return null;
  return `${out.replace(/\s+$/, "")}\n`;
}
