import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type PlatformId, PlatformIdSchema, SUPPORTED_PLATFORMS } from "@catenext/shared";
import { InvalidArgumentError } from "commander";
import { BackupError } from "../backup.js";
import { ConfigError } from "../config.js";
import { McpConfigError } from "../init/mcp-config.js";
import { LocalServiceError } from "../local-service.js";
import { nodeLauncherWarning, stableNodeCommand } from "../node-command.js";
import { PlanningInputError } from "../planning.js";
import { SkillError } from "../skills.js";
import { TemplateBundleError } from "../template-bundle.js";
import { WorktreeError } from "../worktrees.js";

/** Error yang ditulis untuk manusia: cetak tanpa stack trace. */
export async function friendly(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (
      err instanceof ConfigError ||
      err instanceof McpConfigError ||
      err instanceof SkillError ||
      err instanceof PlanningInputError ||
      err instanceof TemplateBundleError ||
      err instanceof WorktreeError ||
      err instanceof BackupError
    ) {
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof LocalServiceError) {
      const detail = err.details ? `\n  ${JSON.stringify(err.details)}` : "";
      console.error(`✗ ${err.message} [${err.code}]${detail}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/** Perintah default untuk entri MCP: node (dari PATH bila bisa) + path absolut build CLI ini. */
export function defaultMcpCommand(): { command: string; args: string[] } {
  const self = fileURLToPath(import.meta.url);
  const entry = self.endsWith(".ts") ? resolve(dirname(self), "../../dist/index.js") : self;
  if (/[\\/]_npx[\\/]/.test(entry)) {
    console.error(
      "! CLI berjalan dari cache npx. Entri MCP memakai path lokal ini; pasang CLI di lokasi tetap lalu jalankan init lagi agar pembersihan cache tidak memutus MCP.",
    );
  }
  if (!existsSync(entry)) {
    console.error(
      `! ${entry} belum ada. Jalankan \`pnpm --filter catenext build\` agar IDE bisa menjalankan server MCP.`,
    );
  }
  const command = stableNodeCommand(process.execPath, process.env.PATH);
  const warning = nodeLauncherWarning(command);
  if (warning) console.error(warning);
  return { command, args: [entry] };
}

export const PLATFORM_OPT = [
  "--platform <id[,id...]>",
  `Platform MCP (boleh diulang): ${SUPPORTED_PLATFORMS.join(", ")}`,
  (values: string, previous: PlatformId[] = []) => {
    const ids = values.split(",").map((value) => {
      const parsed = PlatformIdSchema.safeParse(value.trim());
      if (!parsed.success) {
        throw new InvalidArgumentError(
          `Platform tidak didukung: ${JSON.stringify(value.trim())}. Pilih: ${SUPPORTED_PLATFORMS.join(", ")}.`,
        );
      }
      return parsed.data;
    });
    return [...new Set([...previous, ...ids])];
  },
] as const;

export type PlatformOptions = { platform?: PlatformId[] };

export function parseIntRange(flag: string, min: number, max: number) {
  return (value: string): number => {
    if (!/^\d+$/.test(value.trim())) {
      throw new InvalidArgumentError(`${flag} harus bilangan bulat ${min}..${max}.`);
    }
    const n = Number.parseInt(value, 10);
    if (n < min || n > max) {
      throw new InvalidArgumentError(`${flag} harus antara ${min} dan ${max}.`);
    }
    return n;
  };
}

export function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.once("close", () => res(false));
    rl.question(question, (a) => {
      res(/^(y|ya|yes)$/i.test(a.trim()));
      rl.close();
    });
  });
}

export const collect = (v: string, prev: string[]) => [...prev, v];
