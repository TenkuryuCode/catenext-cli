import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  DEFAULT_PLATFORMS,
  IdSchema,
  type PlatformId,
  PlatformIdSchema,
  RepoNameSchema,
} from "@catenext/shared";
import { createTwoFilesPatch } from "diff";
import { planEntryPointers } from "../agents/entry-pointers.js";
import {
  CONFIG_PATH,
  ConfigError,
  configuredPlatforms,
  parseConfig,
  stateFilePath,
} from "../config.js";
import { AGENTS_MD, upsertAgentsBlock } from "./agents-md.js";
import { renderNewConfig, updateConfig } from "./config-file.js";
import { detectStack } from "./detect.js";
import { ensureGitignore } from "./gitignore.js";
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
} from "./mcp-config.js";
import { applyRepoEdits, type FileEdit, readRepoFile } from "./repo-files.js";

export interface InitOptions {
  root: string;
  projectId?: string;
  projectName?: string;
  repoName?: string;
  stack?: string[];
  platforms?: readonly PlatformId[];
  mcpCommand: McpServerEntry;
  /** Explicit `--mcp-command`; otherwise keep valid existing launchers. */
  replaceMcpCommand?: boolean;
  agentsMd?: boolean;
}

export interface FileChange extends FileEdit {
  after: string;
}

export function slugifyRepoName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "repo"
  );
}

/** Compute local setup changes without writing files or contacting any service. */
export async function planInit(opts: InitOptions): Promise<FileChange[]> {
  const root = resolve(opts.root);
  if (opts.projectId !== undefined && !IdSchema.safeParse(opts.projectId).success) {
    throw new ConfigError("--project harus berupa UUID yang valid.");
  }
  if (opts.repoName !== undefined && !RepoNameSchema.safeParse(opts.repoName).success) {
    throw new ConfigError("--repo harus slug huruf kecil (a-z, 0-9, '-' atau '_').");
  }
  for (const platform of opts.platforms ?? []) {
    if (!PlatformIdSchema.safeParse(platform).success)
      throw new ConfigError(`Platform tidak didukung: ${platform}`);
    if (platform === "windsurf") throw new McpConfigError(WINDSURF_UNSUPPORTED);
  }
  const configBefore = await readRepoFile(root, CONFIG_PATH);
  const config = configBefore === null ? null : parseConfig(configBefore);
  if (config && opts.projectId !== undefined && opts.projectId !== config.project_id) {
    throw new ConfigError(
      "--project berbeda dari project_id lokal. Init tidak mengganti identitas proyek yang sudah ada.",
    );
  }
  const previous = config ? configuredPlatforms(config) : [];
  const platforms = [
    ...new Set([...previous, ...(opts.platforms ?? (previous.length ? [] : DEFAULT_PLATFORMS))]),
  ];
  const fields = {
    project_name:
      opts.projectName ?? (config ? undefined : basename(root).slice(0, 120) || "Catenext"),
    repo_name: opts.repoName,
    stack: opts.stack,
    platforms,
  };
  const configAfter =
    configBefore !== null
      ? updateConfig(configBefore, fields)
      : renderNewConfig({
          ...fields,
          project_id: opts.projectId ?? randomUUID(),
          repo_name: fields.repo_name ?? slugifyRepoName(basename(root)),
          stack: fields.stack ?? (await detectStack(root)),
        });
  const changes: FileChange[] = [{ path: CONFIG_PATH, before: configBefore, after: configAfter }];
  for (const adapter of await selectedAdapters(root, opts.platforms ?? platforms)) {
    const before = await readRepoFile(root, adapter.path);
    const current = inspectMcp(before, adapter);
    if (current.count > 1) {
      throw new McpConfigError(
        `${adapter.path}: entri catenext ganda. Jalankan \`catenext sync --fix\`.`,
      );
    }
    const existing =
      current.entry && current.managed && !opts.replaceMcpCommand ? entryBase(current.entry) : null;
    if (
      current.entry &&
      existing &&
      current.compatible &&
      entryMatchesRoot(current.entry, root, adapter)
    )
      continue;
    const role =
      current.entry && existing ? (entryRole(current.entry) ?? "orchestrator") : "orchestrator";
    const entry = scopedEntry(root, adapter, existing ?? opts.mcpCommand, role);
    const after = changeMcp(before, adapter, entry);
    if (after !== null) changes.push({ path: adapter.path, before, after });
  }
  const gitignore = await readRepoFile(root, ".gitignore");
  changes.push({ path: ".gitignore", before: gitignore, after: ensureGitignore(gitignore) });
  if (opts.agentsMd !== false) {
    const before = await readRepoFile(root, AGENTS_MD);
    changes.push({ path: AGENTS_MD, before, after: upsertAgentsBlock(before) });
  }
  for (const edit of await planEntryPointers(root, platforms)) {
    if (edit.after !== null)
      changes.push({ path: edit.path, before: edit.before, after: edit.after });
  }
  const state = stateFilePath(root, config ?? {});
  return changes.filter(({ before, after, path }) => {
    if (before === after) return false;
    if (resolve(root, path) === state)
      throw new ConfigError(`${path} dipakai sebagai state_file; file tidak disentuh.`);
    return true;
  });
}

export function renderDiff(changes: FileChange[]): string {
  return changes
    .map(({ path, before, after }) =>
      createTwoFilesPatch(
        before === null ? "/dev/null" : `a/${path}`,
        `b/${path}`,
        before ?? "",
        after,
      ),
    )
    .join("\n");
}

export async function applyInit(root: string, changes: FileChange[]): Promise<void> {
  await applyRepoEdits(root, changes);
}
