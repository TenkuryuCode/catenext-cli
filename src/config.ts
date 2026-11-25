import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type CatenextConfig,
  CatenextConfigSchema,
  checkConfigCompatibility,
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
  } catch {
    throw new ConfigError(
      "Belum ada .catenext/config.yaml di folder ini. Jalankan `catenext init --project <project_id>` terlebih dahulu.",
    );
  }
  return parseConfig(source);
}

/**
 * Cari folder terdekat (cwd lalu induknya) yang berisi .catenext/config.yaml, karena
 * IDE bisa menjalankan server MCP dari subfolder repo.
 */
export async function findProjectRoot(start: string = process.cwd()): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    try {
      await access(join(dir, CONFIG_PATH));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}
