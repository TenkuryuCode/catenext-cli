import { access, lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type CatenextConfig,
  CatenextConfigSchema,
  checkConfigCompatibility,
  type PlatformId,
} from "@catenext/shared";
import { parse } from "yaml";

export const CONFIG_PATH = join(".catenext", "config.yaml");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Validasi isi YAML config dengan pesan error yang ramah manusia. */
export function parseConfig(source: string): CatenextConfig {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (err) {
    throw new ConfigError(`.catenext/config.yaml bukan YAML yang valid: ${(err as Error).message}`);
  }

  const result = CatenextConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new ConfigError(
      `.catenext/config.yaml tidak valid:\n${lines.join("\n")}\nPerbaiki manual atau jalankan \`catenext init\` ulang.`,
    );
  }

  const compat = checkConfigCompatibility(result.data.schema_version);
  if (!compat.ok) throw new ConfigError(compat.message);

  return result.data;
}

export async function readConfig(cwd: string = process.cwd()): Promise<CatenextConfig> {
  let source: string;
  try {
    source = await readFile(join(cwd, CONFIG_PATH), "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      throw new ConfigError(
        "Belum ada .catenext/config.yaml. Jalankan `catenext init` di root repo.",
      );
    }
    throw error;
  }
  return parseConfig(source);
}

/**
 * Cari folder terdekat (cwd lalu induknya) yang berisi .catenext/config.yaml, karena
 * IDE bisa menjalankan server MCP dari subfolder repo.
 */
export async function findProjectRoot(
  start: string = process.cwd(),
  { managedWorktree = false }: { managedWorktree?: boolean } = {},
): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    try {
      await access(join(dir, CONFIG_PATH));
      return dir;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      if (managedWorktree) {
        const inherited = await managedConfigRoot(dir);
        if (inherited) return inherited;
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

/** Managed linked checkouts inherit primary config/state without copying local files. */
async function managedConfigRoot(dir: string): Promise<string | null> {
  const dotGit = await lstat(join(dir, ".git")).catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  if (!dotGit?.isFile()) return null;
  const { readManagedWorktree } = await import("./worktrees.js");
  const managed = await readManagedWorktree(dir);
  if (!managed) return null;
  const config = await readConfig(managed.primary);
  if (config.project_id !== managed.marker.project_id || config.repo_name !== managed.marker.repo) {
    throw new ConfigError("Worktree Catenext tidak cocok dengan config worktree utama.");
  }
  return managed.primary;
}

/** Temukan root dan baca config valid dalam satu langkah. */
export async function loadConfig(
  start: string = process.cwd(),
): Promise<{ root: string; config: CatenextConfig }> {
  const root = await findProjectRoot(start);
  if (!root) {
    throw new ConfigError(
      "Tidak ada .catenext/config.yaml di folder ini atau induknya. Jalankan `catenext init` di root repo.",
    );
  }
  return { root, config: await readConfig(root) };
}

export function configuredPlatforms(config: CatenextConfig): PlatformId[] {
  // Config sebelum field `platforms` hanya memasang Claude Code dan Cursor.
  return [...new Set(config.platforms ?? (["claude-code", "cursor"] as const))];
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const DEFAULT_STATE_PATH = join(".catenext", "catenext.sqlite");

export function stateFilePath(root: string, config: Pick<CatenextConfig, "state_file">): string {
  return resolve(root, config.state_file ?? DEFAULT_STATE_PATH);
}
