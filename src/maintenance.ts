import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type PlatformId, SUPPORTED_PLATFORMS } from "@catenext/shared";
import {
  ENTRY_MARKER,
  MASTER_MARKER,
  MASTER_PROMPT_FILE,
  PLATFORM_ENTRY_FILES,
  renderMasterPrompt,
} from "./agents/entry-pointers.js";
import { CONFIG_PATH, configuredPlatforms, parseConfig, stateFilePath } from "./config.js";
import { AGENTS_MD, BLOCK_START, removeAgentsBlock, upsertAgentsBlock } from "./init/agents-md.js";
import { updateConfig } from "./init/config-file.js";
import { ensureGitignore } from "./init/gitignore.js";
import {
  changeMcp,
  entryBase,
  entryMatchesRoot,
  entryRole,
  inspectMcp,
  McpConfigError,
  type McpServerEntry,
  scopedEntry,
  selectedAdapters,
  WINDSURF_UNSUPPORTED,
} from "./init/mcp-config.js";
import { applyRepoEdits, type FileEdit, readRepoFile } from "./init/repo-files.js";
import { listSkills, SKILLS_DIR } from "./skills.js";
import { catenextSubagentFiles, SUBAGENT_DIRS } from "./subagents.js";

export type { FileEdit } from "./init/repo-files.js";

export interface Finding {
  level: "ok" | "fixable" | "warn";
  message: string;
}

/**
 * Stale only when an absolute launch path no longer exists. Paths inside an npx cache are
 * allowed while they exist: the CLI warns on generation and the file is still a valid launch.
 */
export function entryIsStale(entry: McpServerEntry): boolean {
  if (isAbsolute(entry.command) && !existsSync(entry.command)) return true;
  const script = entry.args[0];
  return !!script && isAbsolute(script) && /\.[cm]?js$/.test(script) && !existsSync(script);
}

export interface SyncPlan {
  edits: FileEdit[];
  findings: Finding[];
}

/** Plan repo-only maintenance; malformed files are never forcibly replaced. */
export async function planSync(opts: {
  root: string;
  platforms?: readonly PlatformId[];
  fix: boolean;
  force?: boolean;
  defaultCommand: () => McpServerEntry;
}): Promise<SyncPlan> {
  const root = resolve(opts.root);
  const configBefore = await readRepoFile(root, CONFIG_PATH);
  const config = parseConfig(configBefore ?? "");
  const previous = configuredPlatforms(config);
  const platforms = opts.platforms ?? previous;
  const configured = new Set(previous);
  const edits: FileEdit[] = [];
  const findings: Finding[] = [];
  const add = (path: string, before: string | null, after: string | null) => {
    if (resolve(root, path) === stateFilePath(root, config)) {
      throw new McpConfigError(`${path} dipakai sebagai state_file; file tidak disentuh.`);
    }
    if (before !== after) edits.push({ path, before, after });
  };
  if (platforms.includes("windsurf"))
    findings.push({ level: "warn", message: WINDSURF_UNSUPPORTED });
  const failed = new Set<PlatformId>();
  for (const adapter of await selectedAdapters(root, platforms)) {
    try {
      const before = await readRepoFile(root, adapter.path);
      const current = inspectMcp(before, adapter);
      if (current.count && !current.managed) {
        throw new McpConfigError(
          `${adapter.path}: entri catenext bukan peluncur yang dikelola. File tidak disentuh.`,
        );
      }
      const stale = current.entry ? entryIsStale(current.entry) : false;
      const needsFix =
        current.count > 1 ||
        stale ||
        (current.entry && (!current.compatible || !entryMatchesRoot(current.entry, root, adapter)));
      if (needsFix && !opts.fix && !opts.force) {
        for (const id of adapter.ids) failed.add(id);
        findings.push({
          level: "fixable",
          message: `${adapter.path}: entri ganda, basi, atau tidak sesuai repo. Jalankan \`catenext sync --fix\`.`,
        });
        continue;
      }
      if (!current.entry || needsFix || opts.force) {
        const base = current.entry && !stale && !opts.force ? entryBase(current.entry) : null;
        const role =
          current.entry && base ? (entryRole(current.entry) ?? "orchestrator") : "orchestrator";
        const after = changeMcp(
          before,
          adapter,
          scopedEntry(root, adapter, base ?? opts.defaultCommand(), role),
        );
        add(adapter.path, before, after);
        if (before !== after || !current.entry || needsFix) {
          findings.push({
            level: "ok",
            message: `${adapter.path}: entri catenext ${
              current.count ? (needsFix ? "diperbaiki" : "diperbarui") : "ditambahkan"
            }.`,
          });
        }
      }
      for (const id of adapter.ids) configured.add(id);
    } catch (error) {
      if (!(error instanceof McpConfigError)) throw error;
      for (const id of adapter.ids) failed.add(id);
      findings.push({ level: "warn", message: error.message });
    }
  }
  const tracked = [...configured].filter(
    (platform) => previous.includes(platform) || !failed.has(platform),
  );
  const previousSet = new Set(previous);
  const trackedSet = new Set(tracked);
  const platformsChanged =
    trackedSet.size !== previousSet.size || tracked.some((platform) => !previousSet.has(platform));
  if (platformsChanged && configBefore !== null) {
    add(CONFIG_PATH, configBefore, updateConfig(configBefore, { platforms: tracked }));
  }
  const gitignore = await readRepoFile(root, ".gitignore");
  add(".gitignore", gitignore, ensureGitignore(gitignore));
  const agents = await readRepoFile(root, AGENTS_MD);
  if (agents?.includes(BLOCK_START) || opts.force)
    add(AGENTS_MD, agents, upsertAgentsBlock(agents));
  const master = await readRepoFile(root, MASTER_PROMPT_FILE);
  if (master?.includes(MASTER_MARKER)) add(MASTER_PROMPT_FILE, master, renderMasterPrompt());
  return { edits, findings };
}

/** Remove only local adapter entries; keep project identity, state and skills by default. */
export async function planRemove(opts: {
  root: string;
  platforms?: readonly PlatformId[];
  all?: boolean;
}): Promise<FileEdit[]> {
  const root = resolve(opts.root);
  const configBefore = await readRepoFile(root, CONFIG_PATH);
  const config = configBefore === null ? null : parseConfig(configBefore);
  const previous = config ? configuredPlatforms(config) : [];
  const selected = opts.platforms ?? (config ? previous : SUPPORTED_PLATFORMS);
  if (opts.platforms?.includes("windsurf")) throw new McpConfigError(WINDSURF_UNSUPPORTED);
  const remaining = previous.filter((platform) => !selected.includes(platform));
  const edits: FileEdit[] = [];
  const stateFile = stateFilePath(root, config ?? {});
  const add = (path: string, before: string | null, after: string | null) => {
    if (before !== after && resolve(root, path) !== stateFile) edits.push({ path, before, after });
  };
  for (const adapter of await selectedAdapters(root, selected)) {
    const before = await readRepoFile(root, adapter.path);
    if (before !== null && inspectMcp(before, adapter).managed) {
      add(adapter.path, before, changeMcp(before, adapter, null));
    }
  }
  if (configBefore !== null)
    add(CONFIG_PATH, configBefore, updateConfig(configBefore, { platforms: remaining }));
  if (!opts.platforms) {
    const agents = await readRepoFile(root, AGENTS_MD);
    if (agents?.includes(BLOCK_START)) add(AGENTS_MD, agents, removeAgentsBlock(agents));
  }
  const masterPrompt = await readRepoFile(root, MASTER_PROMPT_FILE);
  if (
    masterPrompt?.includes(MASTER_MARKER) &&
    (!opts.platforms || (previous.length > 0 && remaining.length === 0))
  ) {
    add(MASTER_PROMPT_FILE, masterPrompt, null);
  }
  const entryPlatforms = opts.platforms ? selected : SUPPORTED_PLATFORMS;
  for (const path of new Set(
    entryPlatforms
      .map((platform) => PLATFORM_ENTRY_FILES[platform])
      .filter((path): path is string => Boolean(path)),
  )) {
    const before = await readRepoFile(root, path);
    if (before?.includes(ENTRY_MARKER)) add(path, before, null);
  }
  if (opts.platforms) {
    const remainingDirs = new Set(
      remaining.map((platform) => SUBAGENT_DIRS[platform]).filter((d): d is string => Boolean(d)),
    );
    const removable = selected.filter((platform) => {
      const dir = SUBAGENT_DIRS[platform];
      return dir && !remainingDirs.has(dir);
    });
    for (const path of await catenextSubagentFiles(root, removable)) {
      add(path, await readRepoFile(root, path), null);
    }
  } else {
    for (const path of await catenextSubagentFiles(root)) {
      add(path, await readRepoFile(root, path), null);
    }
  }
  if (opts.all) {
    const { skills, invalid } = await listSkills(root);
    for (const file of [
      ...skills.map(({ name }) => `${name}.md`),
      ...invalid.map(({ file }) => file),
    ]) {
      const path = join(SKILLS_DIR, file);
      add(path, await readRepoFile(root, path), null);
    }
  }
  return edits;
}

export async function applyFileEdits(root: string, edits: FileEdit[]): Promise<void> {
  await applyRepoEdits(root, edits);
}

export function summarize(edits: FileEdit[]): string[] {
  return edits.map(({ path, before, after }) =>
    after === null
      ? `- dihapus  ${path}`
      : before === null
        ? `+ dibuat   ${path}`
        : `~ diubah   ${path}`,
  );
}
