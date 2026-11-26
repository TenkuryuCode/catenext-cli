import { lstat } from "node:fs/promises";
import type { CatenextConfig, PlatformId } from "@catenext/shared";
import { configuredPlatforms, isMissingFile, stateFilePath } from "./config.js";
import {
  entryMatchesRoot,
  inspectMcp,
  McpConfigError,
  selectedAdapters,
  WINDSURF_UNSUPPORTED,
} from "./init/mcp-config.js";
import { readRepoFile } from "./init/repo-files.js";
import { entryIsStale } from "./maintenance.js";

export interface CheckLine {
  ok: boolean;
  label: string;
  hint?: string;
}

/** Verify local configuration and server launch mapping without starting any process. */
export async function verifySetup(
  root: string,
  config: CatenextConfig,
  selected?: readonly PlatformId[],
): Promise<CheckLine[]> {
  const platforms = selected ?? configuredPlatforms(config);
  const lines: CheckLine[] = [{ ok: true, label: `Config lokal valid: ${config.repo_name}` }];
  const state = stateFilePath(root, config);
  try {
    const stat = await lstat(state);
    lines.push({
      ok: stat.isFile() && stat.nlink === 1,
      label: `File state lokal: ${state}`,
      hint: "State harus file biasa, bukan symlink atau hardlink.",
    });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    lines.push({ ok: true, label: `State belum dibuat: ${state}` });
  }
  if (platforms.includes("windsurf"))
    lines.push({ ok: false, label: "Windsurf", hint: WINDSURF_UNSUPPORTED });
  for (const adapter of await selectedAdapters(root, platforms)) {
    let hint: string | undefined;
    try {
      const source = await readRepoFile(root, adapter.path);
      const { count, entry, managed, compatible } = inspectMcp(source, adapter);
      if (!count) hint = "Entri catenext belum ada. Jalankan `catenext init` atau `catenext sync`.";
      else if (!managed || !entry)
        hint = "Nama catenext dipakai oleh entri yang tidak dikelola. Periksa secara manual.";
      else if (
        count !== 1 ||
        !compatible ||
        !entryMatchesRoot(entry, root, adapter) ||
        entryIsStale(entry)
      ) {
        hint = "Entri ganda, basi, atau tidak sesuai repo. Jalankan `catenext sync --fix`.";
      }
    } catch (error) {
      if (!(error instanceof McpConfigError)) throw error;
      hint = error.message;
    }
    lines.push({ ok: hint === undefined, label: `${adapter.label}: ${adapter.path}`, hint });
  }
  if (!platforms.length) lines.push({ ok: true, label: "Tidak ada platform MCP yang dipilih." });
  return lines;
}

export function formatChecks(lines: CheckLine[]): string {
  return lines
    .map(
      ({ ok, label, hint }) => `${ok ? "✓" : "✗"} ${label}${hint && !ok ? `\n    → ${hint}` : ""}`,
    )
    .join("\n");
}
