import type { PlatformId } from "@catenext/shared";
import { CONFIG_PATH, parseConfig } from "../config.js";
import { type FileEdit, summarize } from "../maintenance.js";
import { type PersonaSeedMode, personasForSeed } from "../seed.js";
import { planSubagents } from "../subagents.js";
import type { FileChange } from "./index.js";

export type InitDryRunPreview = {
  personaSeed: PersonaSeedMode;
  personaAliases: string[];
  stubEdits: FileEdit[];
  skipped: string[];
};

/** Plan SQLite seed + agent stubs after init without writing state or stub files. */
export async function planInitDryRunPreview(opts: {
  root: string;
  changes: FileChange[];
  platforms: readonly PlatformId[];
  personaSeed: PersonaSeedMode;
  stack: string[];
}): Promise<InitDryRunPreview> {
  const configChange = opts.changes.find((c) => c.path === CONFIG_PATH);
  const config = configChange ? parseConfig(configChange.after) : null;
  const stack = config?.stack ?? opts.stack;
  const personas = personasForSeed(opts.personaSeed, stack).map((p) => ({
    ...p,
    scope: "project" as const,
  }));
  const sub = await planSubagents(opts.root, personas, opts.platforms, {
    stack,
    repoName: config?.repo_name,
    layout: config?.layout,
  });
  return {
    personaSeed: opts.personaSeed,
    personaAliases: personas.map((p) => p.alias),
    stubEdits: sub.edits,
    skipped: sub.skipped,
  };
}

export function formatInitDryRunPreview(preview: InitDryRunPreview): string[] {
  const lines: string[] = [];
  lines.push("(dry-run) SQLite seed (tidak ditulis):");
  if (preview.personaSeed === "none") {
    lines.push("  personas: (lewati)");
  } else {
    lines.push(
      preview.personaAliases.length > 0
        ? `  personas: ${preview.personaAliases.join(", ")}`
        : "  personas: (kosong)",
    );
  }
  lines.push("  dokumen starter: blueprint, orchestrator, permissions, sync-board");
  lines.push("(dry-run) Stub agen (preview, belum ditulis):");
  if (preview.stubEdits.length === 0) {
    lines.push("  (tidak ada stub baru)");
  } else {
    for (const line of summarize(preview.stubEdits)) lines.push(`  ${line}`);
  }
  for (const path of preview.skipped) {
    lines.push(`! ${path} sudah ada dan bukan milik Catenext; dilewati.`);
  }
  return lines;
}
