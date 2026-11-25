/**
 * Blok Catenext di AGENTS.md untuk agen tanpa MCP (Codex, Aider, dll.). Dibatasi penanda
 * agar `init` idempoten dan `remove` bisa membersihkannya tanpa menyentuh isi lain.
 */
export const AGENTS_MD = "AGENTS.md";
export const BLOCK_START = "<!-- catenext:start -->";
export const BLOCK_END = "<!-- catenext:end -->";

export function renderAgentsBlock(): string {
  return [
    BLOCK_START,
    "## Catenext: estafet task antar-agen",
    "",
    "Repo ini memakai Catenext. Bila Anda punya tool MCP `catenext`, pakai tool itu",
    "(`get_project_context` -> `get_ready_tasks` -> `claim_task` -> `complete_handoff`).",
    "Bila tidak, pakai CLI berikut:",
    "",
    "1. `catenext next`: lihat task yang siap untuk repo ini.",
    "2. `catenext claim <task_id>`: kunci task dan baca instruksi + handoff dependensinya.",
    "3. Kerjakan, jalankan tes, lalu commit.",
    '4. `catenext done <task_id> --notes "<ringkasan>" --verify "<perintah tes>" [--decision "..."]`',
    '5. Bila buntu: `catenext block <task_id> --category <missing_env|ambiguous_requirement|failing_tests|dependency_issue|other> --reason "..."`',
    "",
    "Aturan: satu task per sesi; jangan menyalin kode atau secret ke handoff (rujuk path file);",
    "jangan mengedit `.catenext/config.yaml`. Skill repo ada di `.catenext/skills/`.",
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
