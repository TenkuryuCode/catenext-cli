import type { Command } from "commander";
import {
  cliService,
  personaList,
  personaRemove,
  personaSet,
  regenPersonaSubagents,
  requireRoot,
} from "../planning.js";
import { friendly, PLATFORM_OPT, type PlatformOptions } from "./shared.js";

/** Register `persona` subcommands. */
export function registerPersonaCommands(program: Command) {
  const persona = program.command("persona").description("Kelola persona agen untuk proyek ini");
  persona
    .command("list")
    .description("Daftar persona (alias, role, aturan) yang berlaku di proyek ini")
    .option("--json", "Keluaran JSON")
    .action((opts: { json?: boolean }) =>
      friendly(async () => personaList(await cliService(), Boolean(opts.json))),
    );

  persona
    .command("set")
    .description("Buat atau perbarui persona khusus proyek ini (aturan lama diganti)")
    .argument("<alias>", "Nama panggilan, mis. bambang")
    .requiredOption("--role <role>", "Role, mis. backend, ui, architect")
    .option(
      "--rule <text>",
      "Aturan kerja (boleh diulang)",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--repo <name>",
      "Repo yang dipegang persona di proyek ini, mis. be (boleh diulang)",
      (v: string, prev: string[] | undefined) => [...(prev ?? []), v],
    )
    .option("--json", "Keluaran JSON")
    .option("--no-sync", "Lewati regenerasi stub agen IDE setelah perubahan persona")
    .option(...PLATFORM_OPT)
    .action(
      (
        alias: string,
        opts: {
          role: string;
          rule: string[];
          repo?: string[];
          json?: boolean;
          noSync?: boolean;
        } & PlatformOptions,
      ) =>
        friendly(async () => {
          const root = await requireRoot();
          const service = await cliService(root);
          await personaSet(service, alias, opts.role, opts.rule, Boolean(opts.json), opts.repo);
          if (!opts.noSync) {
            await regenPersonaSubagents(root, service, {
              platforms: opts.platform,
              quiet: Boolean(opts.json),
            });
          }
        }),
    );

  persona
    .command("remove")
    .description("Hapus persona dari proyek ini (gagal bila lease aktif atau punya workspace root)")
    .argument("<alias>", "Alias persona yang dihapus")
    .option("--json", "Keluaran JSON")
    .option("--no-sync", "Lewati regenerasi stub agen IDE setelah perubahan persona")
    .option(...PLATFORM_OPT)
    .action((alias: string, opts: { json?: boolean; noSync?: boolean } & PlatformOptions) =>
      friendly(async () => {
        const root = await requireRoot();
        const service = await cliService(root);
        await personaRemove(service, alias, Boolean(opts.json));
        if (!opts.noSync) {
          await regenPersonaSubagents(root, service, {
            platforms: opts.platform,
            quiet: Boolean(opts.json),
          });
        }
      }),
    );
}
