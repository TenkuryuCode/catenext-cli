import { type SkillSourceId, SkillSourceIdSchema } from "@catenext/shared";
import { type Command, InvalidArgumentError } from "commander";
import { findProjectRoot, readConfig } from "../config.js";
import { cliService, requireRoot } from "../planning.js";
import { loadCatalogSkill } from "../skill-catalog.js";
import { skillCreate, skillList, skillRemove, skillSet } from "../skills.js";
import {
  buildTemplateBundle,
  formatImportSummary,
  importTemplateBundle,
  loadTemplateBundle,
  TemplateBundleError,
  warnRedactions,
  writeTemplateBundle,
} from "../template-bundle.js";
import { friendly, PLATFORM_OPT, type PlatformOptions } from "./shared.js";

/** Register `skill` and `template` subcommands. */
export function registerSkillCommands(program: Command) {
  const skill = program
    .command("skill")
    .description("Kelola skill repo Markdown di .catenext/skills dan temukan skill native");

  skill
    .command("list")
    .description("Daftar skill valid di repo dan katalog skill native terpasang")
    .option(...PLATFORM_OPT)
    .option("--user-skills", "Sertakan penemuan read-only skill global pengguna")
    .option("--json", "Keluaran JSON")
    .action((opts: { json?: boolean; userSkills?: boolean } & PlatformOptions) =>
      friendly(async () =>
        skillList((await findProjectRoot()) ?? process.cwd(), {
          json: opts.json,
          platforms: opts.platform,
          includeUserGlobal: Boolean(opts.userSkills),
        }),
      ),
    );

  skill
    .command("create")
    .description("Buat skill baru (gagal bila nama sudah dipakai)")
    .argument("<name>", "Nama skill, mis. api-style")
    .requiredOption("--when-to-use <text>", "Kapan agen harus memuat skill ini")
    .requiredOption("--file <path>", "File Markdown isi skill (tanpa frontmatter)")
    .option("--json", "Keluaran JSON")
    .action((name: string, opts: { whenToUse: string; file: string; json?: boolean }) =>
      friendly(async () =>
        skillCreate(await requireRoot(), name, {
          whenToUse: opts.whenToUse,
          file: opts.file,
          json: opts.json,
        }),
      ),
    );

  skill
    .command("set")
    .description("Buat atau perbarui skill (field yang tidak diisi dipertahankan)")
    .argument("<name>")
    .option("--when-to-use <text>", "Perbarui petunjuk kapan memuat skill")
    .option("--file <path>", "File Markdown isi skill baru")
    .option("--json", "Keluaran JSON")
    .action((name: string, opts: { whenToUse?: string; file?: string; json?: boolean }) =>
      friendly(async () =>
        skillSet(await requireRoot(), name, {
          whenToUse: opts.whenToUse,
          file: opts.file,
          json: opts.json,
        }),
      ),
    );

  skill
    .command("remove")
    .description("Hapus file skill dari .catenext/skills")
    .argument("<name>")
    .option("--json", "Keluaran JSON")
    .action((name: string, opts: { json?: boolean }) =>
      friendly(async () => skillRemove(await requireRoot(), name, { json: opts.json })),
    );

  skill
    .command("load")
    .description("Baca skill dari katalog lokal atau revisi Git (.catenext/skills)")
    .argument("<name>")
    .option("--revision <sha>", "SHA commit Git untuk paritas lintas perangkat")
    .option(
      "--source <id>",
      "Pilih source_id spesifik bila ada kolisi nama skill",
      (val: string) => {
        const parsed = SkillSourceIdSchema.safeParse(val.trim());
        if (!parsed.success) {
          throw new InvalidArgumentError(`source_id tidak valid: ${JSON.stringify(val)}.`);
        }
        return parsed.data;
      },
    )
    .option(...PLATFORM_OPT)
    .option("--user-skills", "Izinkan memuat dari sumber skill global pengguna")
    .option("--json")
    .action(
      (
        name: string,
        opts: {
          revision?: string;
          source?: SkillSourceId;
          userSkills?: boolean;
          json?: boolean;
        } & PlatformOptions,
      ) =>
        friendly(async () => {
          const root = (await findProjectRoot()) ?? process.cwd();
          const config = await readConfig(root).catch(() => null);
          const skillBody = await loadCatalogSkill(root, name, {
            platforms: opts.platform?.length ? opts.platform : config?.platforms,
            includeUserGlobal: Boolean(opts.userSkills),
            sourceId: opts.source,
            revision: opts.revision,
          });
          console.log(
            opts.json
              ? JSON.stringify(
                  { ...skillBody, ...(opts.revision ? { revision: opts.revision } : {}) },
                  null,
                  2,
                )
              : skillBody.content,
          );
        }),
    );

  const templateCmd = program
    .command("template")
    .description("Ekspor/impor bundle persona + skill repo lintas proyek (disensor secret)");

  templateCmd
    .command("export")
    .description("Ekspor personas + skill repo ke JSON (secret di-scrub)")
    .option("-o, --out <file>", "Tulis ke file (default: stdout)")
    .option("--json", "Alias stdout JSON (sama seperti tanpa -o)")
    .action((opts: { out?: string; json?: boolean }) =>
      friendly(async () => {
        const root = await requireRoot();
        const config = await readConfig(root);
        const service = await cliService(root);
        const { bundle, redacted, redactions } = await buildTemplateBundle(service, root, config);
        warnRedactions(redacted, redactions);
        if (opts.out) {
          await writeTemplateBundle(opts.out, bundle);
          console.log(
            `✓ Template diekspor ke ${opts.out} (${bundle.personas.length} persona, ${bundle.skills.length} skill).`,
          );
          return;
        }
        console.log(JSON.stringify(bundle, null, 2));
      }),
    );

  templateCmd
    .command("import")
    .description("Impor bundle persona + skill (scrub ulang; upsert)")
    .argument("<file>", "Path JSON bundle (atau - untuk stdin)")
    .option("--personas-only", "Hanya impor personas")
    .option("--skills-only", "Hanya impor skills")
    .option("--dry-run", "Tampilkan ringkasan tanpa menulis")
    .option("--json", "Keluaran JSON")
    .action(
      (
        file: string,
        opts: { personasOnly?: boolean; skillsOnly?: boolean; dryRun?: boolean; json?: boolean },
      ) =>
        friendly(async () => {
          if (opts.personasOnly && opts.skillsOnly) {
            throw new TemplateBundleError(
              "Pilih --personas-only atau --skills-only, bukan keduanya.",
            );
          }
          const root = await requireRoot();
          const service = await cliService(root);
          const { bundle, redacted, redactions } = await loadTemplateBundle(file);
          warnRedactions(redacted, redactions);
          const result = await importTemplateBundle(service, root, bundle, {
            personas: !opts.skillsOnly,
            skills: !opts.personasOnly,
            dryRun: Boolean(opts.dryRun),
          });
          result.redacted = redacted;
          if (opts.json) return console.log(JSON.stringify(result, null, 2));
          console.log(formatImportSummary(result));
          if (result.personas.created.length)
            console.log(`  personas created: ${result.personas.created.join(", ")}`);
          if (result.personas.updated.length)
            console.log(`  personas updated: ${result.personas.updated.join(", ")}`);
          if (result.skills.created.length)
            console.log(`  skills created: ${result.skills.created.join(", ")}`);
          if (result.skills.updated.length)
            console.log(`  skills updated: ${result.skills.updated.join(", ")}`);
        }),
    );
}
