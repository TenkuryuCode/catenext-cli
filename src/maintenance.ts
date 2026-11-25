import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { applyEdits, modify, type ParseError, parse, visit } from "jsonc-parser";
import type { AgentApi } from "./api-client.js";
import { CONFIG_PATH } from "./config.js";
import { AGENTS_MD, BLOCK_START, removeAgentsBlock, upsertAgentsBlock } from "./init/agents-md.js";
import { CACHE_IGNORE, ensureGitignore } from "./init/gitignore.js";
import {
  ADAPTERS,
  type ClientAdapter,
  MCP_SERVER_KEY,
  type McpServerEntry,
  readMcpEntry,
  upsertMcpEntry,
} from "./init/mcp-config.js";
import { listSkills, SKILLS_DIR, skillIndex } from "./skills.js";

/** Perubahan file; `after: null` berarti file dihapus. */
export interface FileEdit {
  path: string;
  before: string | null;
  after: string | null;
  /** Salin file lama ke <path>.bak sebelum ditimpa (untuk file rusak). */
  backup?: boolean;
}

export interface Finding {
  level: "ok" | "fixable" | "warn";
  message: string;
}

const readOrNull = (p: string) =>
  readFile(p, "utf8").then(
    (s) => s,
    () => null,
  );

/** Berapa kali kunci "catenext" muncul langsung di bawah mcpServers (JSON duplikat). */
export function countEntries(source: string): number {
  let count = 0;
  let depth = 0;
  let inServers = -1;
  let pendingServers = false;
  visit(
    source,
    {
      onObjectBegin: () => {
        depth++;
        if (pendingServers) {
          inServers = depth;
          pendingServers = false;
        }
      },
      onObjectEnd: () => {
        if (depth === inServers) inServers = -1;
        depth--;
      },
      onObjectProperty: (name) => {
        if (depth === 1 && name === "mcpServers") pendingServers = true;
        else if (depth === inServers && name === MCP_SERVER_KEY) count++;
      },
    },
    { allowTrailingComma: true, disallowComments: false },
  );
  return count;
}

/** Hapus semua kunci "catenext" di mcpServers. Entri lain & komentar tetap. */
export function removeMcpEntries(source: string): string {
  let out = source;
  for (let i = 0; i < 20 && countEntries(out) > 0; i++) {
    out = applyEdits(out, modify(out, ["mcpServers", MCP_SERVER_KEY], undefined, {}));
  }
  return out;
}

function isValidJsonObject(source: string): boolean {
  const errors: ParseError[] = [];
  const doc = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 && doc !== null && typeof doc === "object" && !Array.isArray(doc);
}

/** Entri menunjuk ke file yang tidak ada lagi (mis. folder repo CLI dipindah/di-rename). */
export function entryIsStale(entry: McpServerEntry): boolean {
  if (isAbsolute(entry.command) && !existsSync(entry.command)) return true;
  const script = entry.args[0];
  return Boolean(script && isAbsolute(script) && /\.[cm]?js$/.test(script) && !existsSync(script));
}

/** Perintah dasar (tanpa "mcp" + argumen adapter) dari entri yang ada. */
function baseCommand(entry: McpServerEntry, adapter: ClientAdapter): McpServerEntry {
  const suffix = ["mcp", ...adapter.extraArgs];
  const args = [...entry.args];
  if (args.slice(-suffix.length).join("\0") === suffix.join("\0")) args.splice(-suffix.length);
  return { command: entry.command, args };
}

export interface SyncPlan {
  edits: FileEdit[];
  findings: Finding[];
}

/**
 * Hitung perbaikan lokal tanpa menulis. Tanpa `fix`: hanya menambah yang hilang (entri MCP,
 * baris .gitignore, isi blok AGENTS.md). Dengan `fix`: juga mengganti entri basi/duplikat dan
 * membuat ulang file MCP yang rusak (file lama disalin ke .bak).
 */
export async function planSync(opts: {
  root: string;
  fix: boolean;
  defaultCommand: () => McpServerEntry;
}): Promise<SyncPlan> {
  const root = resolve(opts.root);
  const edits: FileEdit[] = [];
  const findings: Finding[] = [];

  for (const adapter of ADAPTERS) {
    const before = await readOrNull(join(root, adapter.path));
    if (before !== null && before.trim() !== "" && !isValidJsonObject(before)) {
      if (!opts.fix) {
        findings.push({
          level: "fixable",
          message: `${adapter.path} bukan JSON valid. \`catenext sync --fix\` akan membuatnya ulang (salinan lama ke .bak).`,
        });
        continue;
      }
      const cmd = opts.defaultCommand();
      edits.push({
        path: adapter.path,
        before,
        backup: true,
        after: upsertMcpEntry(
          null,
          { command: cmd.command, args: [...cmd.args, "mcp", ...adapter.extraArgs] },
          adapter.path,
        ),
      });
      findings.push({ level: "ok", message: `${adapter.path} dibuat ulang (rusak).` });
      continue;
    }

    const entry = before ? readMcpEntry(before) : null;
    const dupes = before ? countEntries(before) : 0;
    const stale = entry ? entryIsStale(entry) : false;
    let base = entry && !stale ? baseCommand(entry, adapter) : opts.defaultCommand();
    let source = before;

    if (dupes > 1) {
      if (opts.fix) {
        source = removeMcpEntries(before ?? "");
        findings.push({
          level: "ok",
          message: `${adapter.path}: ${dupes} entri "catenext" disatukan.`,
        });
      } else {
        findings.push({
          level: "fixable",
          message: `${adapter.path}: entri "catenext" muncul ${dupes} kali. Jalankan \`catenext sync --fix\`.`,
        });
        continue;
      }
    }
    if (stale) {
      if (!opts.fix) {
        findings.push({
          level: "fixable",
          message: `${adapter.path}: entri "catenext" menunjuk ke path yang tidak ada (${entry?.command} ${entry?.args[0] ?? ""}). Jalankan \`catenext sync --fix\`.`,
        });
        continue;
      }
      base = opts.defaultCommand();
      findings.push({ level: "ok", message: `${adapter.path}: path server MCP diperbarui.` });
    }
    if (!entry)
      findings.push({ level: "ok", message: `${adapter.path}: entri "catenext" ditambahkan.` });

    const after = upsertMcpEntry(
      source,
      { command: base.command, args: [...base.args, "mcp", ...adapter.extraArgs] },
      adapter.path,
    );
    if (after !== before) edits.push({ path: adapter.path, before, after });
  }

  const gitignore = await readOrNull(join(root, ".gitignore"));
  const gitignoreAfter = ensureGitignore(gitignore);
  if (gitignoreAfter !== gitignore) {
    edits.push({ path: ".gitignore", before: gitignore, after: gitignoreAfter });
  }

  // Blok AGENTS.md hanya diperbarui bila sudah ada (menghormati --no-agents-md saat init).
  const agents = await readOrNull(join(root, AGENTS_MD));
  if (agents?.includes(BLOCK_START)) {
    const after = upsertAgentsBlock(agents);
    if (after !== agents) edits.push({ path: AGENTS_MD, before: agents, after });
  }

  return { edits, findings };
}

/** Kirim indeks skill lokal ke Cloud. Isi skill tidak pernah dikirim. */
export async function syncSkills(
  root: string,
  api: AgentApi | null,
): Promise<{ count: number; invalid: { file: string; error: string }[] }> {
  const { skills, invalid } = await listSkills(root);
  if (api) await api.put("skills", { skills: skillIndex(skills) });
  return { count: skills.length, invalid };
}

/** Rencana `catenext remove`. Skill repo disimpan kecuali `all`. */
export async function planRemove(opts: { root: string; all: boolean }): Promise<FileEdit[]> {
  const root = resolve(opts.root);
  const edits: FileEdit[] = [];

  for (const adapter of ADAPTERS) {
    const before = await readOrNull(join(root, adapter.path));
    if (before === null || countEntries(before) === 0) continue;
    const stripped = removeMcpEntries(before);
    const doc = parse(stripped, [], { allowTrailingComma: true }) as Record<string, unknown>;
    const servers = doc?.mcpServers as Record<string, unknown> | undefined;
    const emptyDoc =
      Object.keys(doc ?? {}).every((k) => k === "mcpServers") &&
      Object.keys(servers ?? {}).length === 0 &&
      !/\/\/|\/\*/.test(stripped);
    edits.push({ path: adapter.path, before, after: emptyDoc ? null : stripped });
  }

  const gitignore = await readOrNull(join(root, ".gitignore"));
  if (gitignore !== null) {
    const eol = gitignore.includes("\r\n") ? "\r\n" : "\n";
    const lines = gitignore.split(/\r?\n/);
    const kept = lines.filter(
      (l, i) =>
        l.trim() !== CACHE_IGNORE &&
        !(l.startsWith("# Catenext:") && lines[i + 1]?.trim() === CACHE_IGNORE),
    );
    if (kept.length !== lines.length) {
      const text = kept.join(eol).replace(/(\r?\n)+$/, "");
      edits.push({ path: ".gitignore", before: gitignore, after: text ? `${text}${eol}` : null });
    }
  }

  const agents = await readOrNull(join(root, AGENTS_MD));
  if (agents?.includes(BLOCK_START)) {
    edits.push({ path: AGENTS_MD, before: agents, after: removeAgentsBlock(agents) });
  }

  for (const p of [CONFIG_PATH, join(".catenext", "cache.json")]) {
    const before = await readOrNull(join(root, p));
    if (before !== null) edits.push({ path: p, before, after: null });
  }
  if (opts.all) {
    const { skills, invalid } = await listSkills(root);
    for (const f of [...skills.map((s) => `${s.name}.md`), ...invalid.map((i) => i.file)]) {
      const p = join(SKILLS_DIR, f);
      edits.push({ path: p, before: await readOrNull(join(root, p)), after: null });
    }
  }
  return edits;
}

/** Terapkan perubahan secara atomik; folder kosong yang ditinggalkan Catenext ikut dihapus. */
export async function applyFileEdits(root: string, edits: FileEdit[]): Promise<void> {
  const base = resolve(root);
  for (const e of edits) {
    const target = join(base, e.path);
    if (e.after === null) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    if (e.backup && e.before !== null) await copyFile(target, `${target}.bak`);
    const tmp = `${target}.catenext-${process.pid}.tmp`;
    await writeFile(tmp, e.after);
    await rename(tmp, target);
  }
  for (const dir of [SKILLS_DIR, ".catenext", ".cursor"]) {
    await rmdir(join(base, dir)).catch(() => {}); // hanya berhasil bila kosong
  }
}

export function summarize(edits: FileEdit[]): string[] {
  return edits.map((e) =>
    e.after === null
      ? `- dihapus  ${e.path}`
      : e.before === null
        ? `+ dibuat   ${e.path}`
        : `~ diubah   ${e.path}${e.backup ? " (salinan lama: .bak)" : ""}`,
  );
}
