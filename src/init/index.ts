import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { IdSchema, RepoNameSchema } from "@catenext/shared";
import { createTwoFilesPatch } from "diff";
import { CONFIG_PATH, ConfigError, parseConfig } from "../config.js";
import { AGENTS_MD, upsertAgentsBlock } from "./agents-md.js";
import { renderNewConfig, updateConfig } from "./config-file.js";
import { detectStack } from "./detect.js";
import { ensureGitignore } from "./gitignore.js";
import { ADAPTERS, type McpServerEntry, upsertMcpEntry } from "./mcp-config.js";

export interface InitOptions {
  root: string;
  projectId?: string;
  repoName?: string;
  apiUrl?: string;
  /** Perintah untuk menjalankan `catenext mcp` (tanpa argumen "mcp"). */
  mcpCommand: { command: string; args: string[] };
  /** Tulis blok Catenext di AGENTS.md untuk agen tanpa MCP (default: ya). */
  agentsMd?: boolean;
}

export interface FileChange {
  /** Relatif terhadap root. */
  path: string;
  before: string | null;
  after: string;
}

const readOrNull = (p: string) =>
  readFile(p, "utf8").then(
    (s) => s,
    () => null,
  );

export function slugifyRepoName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "repo"
  );
}

/**
 * Hitung semua perubahan file tanpa menulis apa pun. Hanya menyentuh
 * .catenext/config.yaml, .mcp.json, .cursor/mcp.json, .gitignore, dan blok di AGENTS.md.
 */
export async function planInit(opts: InitOptions): Promise<FileChange[]> {
  const root = resolve(opts.root);
  if (opts.projectId !== undefined && !IdSchema.safeParse(opts.projectId).success) {
    throw new ConfigError("--project harus UUID project_id dari Dashboard.");
  }
  if (opts.repoName !== undefined && !RepoNameSchema.safeParse(opts.repoName).success) {
    throw new ConfigError(
      "--repo harus slug huruf kecil (a-z, 0-9, '-' atau '_'), mis. backend atau frontend.",
    );
  }

  const changes: FileChange[] = [];

  // 1. .catenext/config.yaml
  const configBefore = await readOrNull(join(root, CONFIG_PATH));
  let configAfter: string;
  if (configBefore === null) {
    if (!opts.projectId) {
      throw new ConfigError(
        "Belum ada .catenext/config.yaml. Buat proyek di Dashboard lalu jalankan: catenext init --project <project_id>",
      );
    }
    configAfter = renderNewConfig({
      project_id: opts.projectId,
      repo_name: opts.repoName ?? slugifyRepoName(basename(root)),
      stack: await detectStack(root),
      ...(opts.apiUrl ? { api_url: opts.apiUrl } : {}),
    });
  } else {
    parseConfig(configBefore); // config rusak: berhenti dengan pesan yang jelas
    configAfter = updateConfig(configBefore, {
      project_id: opts.projectId,
      repo_name: opts.repoName,
      api_url: opts.apiUrl,
    });
  }
  changes.push({ path: CONFIG_PATH, before: configBefore, after: configAfter });

  // 2. Konfigurasi MCP per klien (satu entri "catenext", entri lain & komentar dipertahankan)
  for (const adapter of ADAPTERS) {
    const before = await readOrNull(join(root, adapter.path));
    const entry: McpServerEntry = {
      command: opts.mcpCommand.command,
      args: [...opts.mcpCommand.args, "mcp", ...adapter.extraArgs],
    };
    changes.push({
      path: adapter.path,
      before,
      after: upsertMcpEntry(before, entry, adapter.path),
    });
  }

  // 3. .gitignore
  const gitignoreBefore = await readOrNull(join(root, ".gitignore"));
  changes.push({
    path: ".gitignore",
    before: gitignoreBefore,
    after: ensureGitignore(gitignoreBefore),
  });

  // 4. AGENTS.md: blok fallback CLI untuk agen non-MCP
  if (opts.agentsMd !== false) {
    const before = await readOrNull(join(root, AGENTS_MD));
    changes.push({ path: AGENTS_MD, before, after: upsertAgentsBlock(before) });
  }

  return changes.filter((c) => c.before !== c.after);
}

export function renderDiff(changes: FileChange[]): string {
  return changes
    .map((c) =>
      createTwoFilesPatch(
        c.before === null ? "/dev/null" : `a/${c.path}`,
        `b/${c.path}`,
        c.before ?? "",
        c.after,
        undefined,
        undefined,
        { context: 3 },
      ),
    )
    .join("\n");
}

/** Tulis perubahan secara atomik. Tidak pernah menghapus file atau folder. */
export async function applyInit(root: string, changes: FileChange[]): Promise<void> {
  for (const c of changes) {
    const target = join(resolve(root), c.path);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.catenext-${process.pid}.tmp`;
    await writeFile(tmp, c.after);
    await rename(tmp, target);
  }
}
