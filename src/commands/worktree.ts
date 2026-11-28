import type { Command } from "commander";
import { readConfig } from "../config.js";
import { requireRoot } from "../planning.js";
import { formatWorktreeStatus, readWorktreeStatus } from "../worktree-status.js";
import { pruneWorktrees, readWorktreeInventory, type WorktreeEntry } from "../worktrees.js";
import { friendly } from "./shared.js";

function printWorktrees(entries: WorktreeEntry[]) {
  for (const entry of entries) {
    const flags = [
      entry.current && "current",
      entry.managed && "managed",
      entry.locked && "locked",
      entry.prunable && "missing/prunable",
      entry.dirty && "dirty",
      entry.eligible && "eligible",
    ].filter(Boolean);
    console.log(
      `${entry.status}  ${JSON.stringify(entry.path)}  ${JSON.stringify(entry.branch)}${flags.length ? `  [${flags.join(", ")}]` : ""}`,
    );
  }
}

/** Register `worktree` subcommands. */
export function registerWorktreeCommands(program: Command) {
  const worktree = program
    .command("worktree")
    .description("Periksa dan bersihkan checkout kerja lokal");

  worktree
    .command("list")
    .description("Lihat worktree Git beserta status lease SQLite (tanpa perubahan)")
    .option("--json", "Keluaran JSON")
    .action((opts: { json?: boolean }) =>
      friendly(async () => {
        const root = await requireRoot(true);
        const worktrees = await readWorktreeInventory({ root, config: await readConfig(root) });
        if (opts.json) console.log(JSON.stringify({ worktrees }, null, 2));
        else printWorktrees(worktrees);
      }),
    );

  worktree
    .command("status")
    .description("Lihat status dirty dan potensi konflik file antar worktree Git (read-only)")
    .option("--json", "Keluaran JSON")
    .action((opts: { json?: boolean }) =>
      friendly(async () => {
        const result = await readWorktreeStatus(process.cwd());
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.log(formatWorktreeStatus(result));
      }),
    );

  worktree
    .command("prune")
    .description("Pratinjau penghapusan worktree Catenext yang bersih dan tidak aktif")
    .option("--apply", "Hapus checkout yang memenuhi syarat; branch tidak dihapus")
    .option("--json", "Keluaran JSON")
    .action((opts: { apply?: boolean; json?: boolean }) =>
      friendly(async () => {
        const root = await requireRoot(true);
        const result = await pruneWorktrees(
          { root, config: await readConfig(root) },
          Boolean(opts.apply),
        );
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else {
          printWorktrees(result.worktrees);
          if (!opts.apply)
            console.log(
              "Pratinjau saja. Gunakan --apply untuk menghapus checkout berlabel eligible.",
            );
          for (const path of result.removed) console.log(`Dihapus: ${JSON.stringify(path)}`);
          for (const path of result.skipped)
            console.error(`Tidak dihapus: ${JSON.stringify(path)}`);
        }
        if (result.skipped.length) process.exitCode = 1;
      }),
    );
}
