import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpToolOutput } from "@catenext/shared";
import type { FileEdit } from "./maintenance.js";

/**
 * Subagent Claude Code per persona Catenext (.claude/agents/<alias>.md). Orchestrator cukup
 * memanggil "adel" untuk mengerjakan task milik adel; aturan & batas wilayahnya ikut dimuat.
 * File ditandai penanda agar sync hanya menimpa/menghapus file buatan Catenext.
 */
export const SUBAGENTS_DIR = join(".claude", "agents");
export const SUBAGENT_MARKER = "<!-- catenext:persona -->";

type PersonaItem = McpToolOutput<"list_personas">["personas"][number];

export function renderSubagent(p: PersonaItem): string {
  const rules = p.rules.length > 0 ? p.rules.map((r) => `- ${r}`) : ["- (belum ada aturan)"];
  const alias = JSON.stringify(p.alias);
  return [
    "---",
    `name: ${p.alias}`,
    `description: Persona Catenext "${p.alias}" (role ${p.role}). Pakai saat diminta "${p.alias}, kerjakan" atau untuk task Catenext milik ${p.alias}. Mengerjakan satu task lalu melapor.`,
    "---",
    SUBAGENT_MARKER,
    `<!-- Dibuat oleh \`catenext sync\` dari persona di Cloud; ubah persona di Dashboard, bukan file ini. -->`,
    "",
    `Anda adalah persona Catenext **${p.alias}** (role: ${p.role}).`,
    "",
    "## Alur kerja (satu task per pemanggilan)",
    "",
    `1. \`get_project_context\` dengan \`agent_alias: ${alias}\`.`,
    `2. \`get_ready_tasks\` dengan \`agent_alias: ${alias}\`; pilih task teratas. Bila kosong, laporkan "tidak ada task untuk ${p.alias}" lalu berhenti.`,
    `3. \`claim_task\` dengan \`task_id\` dan \`agent_alias: ${alias}\`. Patuhi field \`persona\` di hasilnya.`,
    "4. Kerjakan, jalankan tes, commit di branch kerja.",
    "5. `complete_handoff` dengan ringkasan terstruktur, atau `report_blocker` bila buntu.",
    "6. Laporkan ke pemanggil: task apa yang selesai, status, dan perintah verifikasinya.",
    "",
    `Tanpa tool MCP: \`catenext next --as ${p.alias}\`, \`catenext claim <id> --as ${p.alias}\`, \`catenext done <id> ...\`.`,
    "",
    "## Aturan & batas wilayah",
    "",
    ...rules,
    "",
  ].join("\n");
}

const readOrNull = (p: string) =>
  readFile(p, "utf8").then(
    (s) => s,
    () => null,
  );

/** Rencana file subagent: buat/perbarui per persona, hapus file Catenext untuk persona yang sudah hilang. */
export async function planSubagents(
  root: string,
  personas: PersonaItem[],
): Promise<{ edits: FileEdit[]; skipped: string[] }> {
  const edits: FileEdit[] = [];
  const skipped: string[] = [];
  const wanted = new Set<string>();
  for (const p of personas) {
    const path = join(SUBAGENTS_DIR, `${p.alias}.md`);
    wanted.add(path);
    const before = await readOrNull(join(root, path));
    if (before !== null && !before.includes(SUBAGENT_MARKER)) {
      skipped.push(path);
      continue;
    }
    const after = renderSubagent(p);
    if (after !== before) edits.push({ path, before, after });
  }
  for (const path of await catenextSubagentFiles(root)) {
    if (!wanted.has(path)) {
      edits.push({ path, before: await readOrNull(join(root, path)), after: null });
    }
  }
  return { edits, skipped };
}

/** File subagent buatan Catenext yang ada di repo (untuk sync & remove). */
export async function catenextSubagentFiles(root: string): Promise<string[]> {
  const names = await readdir(join(root, SUBAGENTS_DIR)).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names.filter((n) => n.endsWith(".md")).sort()) {
    const path = join(SUBAGENTS_DIR, n);
    if ((await readOrNull(join(root, path)))?.includes(SUBAGENT_MARKER)) out.push(path);
  }
  return out;
}
