import { type Command, InvalidArgumentError } from "commander";
import { backupDatabase, restoreDatabase } from "../backup.js";
import {
  ConfigError,
  configuredPlatforms,
  findProjectRoot,
  readConfig,
  stateFilePath,
} from "../config.js";
import { formatDoctorReport, runDoctor } from "../doctor.js";
import { applyFileEdits, planRemove, planSync, summarize } from "../maintenance.js";
import { MCP_ROLES, McpRoleSchema } from "../mcp/catalog.js";
import { runMcpServer } from "../mcp/run.js";
import { cliService, requireRoot } from "../planning.js";
import { discoverSkillCatalog, formatSkillCatalogSummary } from "../skill-catalog.js";
import { planSubagents } from "../subagents.js";
import { formatChecks, verifySetup } from "../verify.js";
import {
  confirm,
  defaultMcpCommand,
  friendly,
  PLATFORM_OPT,
  type PlatformOptions,
} from "./shared.js";

/** Register `verify`, `sync`, `remove`, `doctor`, `backup`, `restore`, `mcp`, and `config` commands. */
export function registerOpsCommands(program: Command, version: string) {
  program
    .command("verify")
    .description("Verifikasi config, state, batas persetujuan, skill lokal, dan entri MCP")
    .option(...PLATFORM_OPT)
    .action((opts: PlatformOptions) =>
      friendly(async () => {
        const root = await requireRoot();
        const checks = await verifySetup(root, await readConfig(root), opts.platform);
        console.log(formatChecks(checks));
        if (checks.some((check) => !check.ok)) process.exitCode = 1;
      }),
    );

  program
    .command("sync")
    .description("Selaraskan entri MCP, .gitignore, dan petunjuk agen; periksa skill repo lokal")
    .option(...PLATFORM_OPT)
    .option(
      "--user-skills",
      "Sertakan penemuan read-only skill global pengguna untuk platform pilihan",
    )
    .option("--dry-run", "Tampilkan perubahan tanpa menulis ke disk")
    .option("--fix", "Perbaiki entri MCP yang duplikat, basi (path hilang), atau file yang rusak")
    .option("--force", "Paksa perbarui entri MCP, CATENEXT.md, pointer platform, dan stub agen")
    .action(
      (
        opts: {
          dryRun?: boolean;
          fix?: boolean;
          force?: boolean;
          userSkills?: boolean;
        } & PlatformOptions,
      ) =>
        friendly(async () => {
          const root = await requireRoot();
          const config = await readConfig(root);
          const platforms = opts.platform?.length ? opts.platform : configuredPlatforms(config);
          const plan = await planSync({
            root,
            platforms: opts.platform,
            fix: Boolean(opts.fix),
            force: Boolean(opts.force),
            defaultCommand: defaultMcpCommand,
          });
          for (const f of plan.findings)
            console.log(`${f.level === "ok" ? "•" : "!"} ${f.message}`);

          const skillCatalog = await discoverSkillCatalog(root, {
            platforms,
            includeUserGlobal: Boolean(opts.userSkills),
          });
          for (const line of formatSkillCatalogSummary(skillCatalog)) console.log(line);
          for (const l of summarize(plan.edits)) console.log(l);
          if (opts.dryRun) {
            console.log(
              `(dry-run) ${plan.edits.length} file akan berubah. Tidak ada yang ditulis.`,
            );
            return;
          }
          await applyFileEdits(root, plan.edits);
          const fixable = plan.findings.some((f) => f.level === "fixable");
          if (plan.edits.length === 0 && !fixable) console.log("✓ File lokal sudah selaras.");

          {
            const service = await cliService(root);
            const { personas } = await service.callTool("list_personas", {});
            const sub = await planSubagents(
              root,
              personas,
              platforms,
              {
                stack: config.stack ?? [],
                repoName: config.repo_name,
                layout: config.layout,
              },
              { force: Boolean(opts.force) },
            );
            const { planEntryPointers } = await import("../agents/entry-pointers.js");
            const pointers = await planEntryPointers(root, platforms, {
              force: Boolean(opts.force),
            });
            const agentEdits = [...sub.edits, ...pointers];
            await applyFileEdits(root, agentEdits);
            for (const l of summarize(agentEdits)) console.log(l);
            for (const path of sub.skipped)
              console.log(`! ${path} already exists and is not Catenext-managed; skipped.`);
            console.log(
              `✓ ${personas.length} persona(s) + orchestrator stubs for: ${platforms.join(", ") || "none"}. New session → CATENEXT.md then AGENTS.md.`,
            );
          }
          const checks = await verifySetup(root, await readConfig(root), opts.platform);
          console.log(`\n${formatChecks(checks)}`);
          if (fixable || checks.some((check) => !check.ok)) process.exitCode = 1;
        }),
    );

  program
    .command("remove")
    .description("Hapus setup Catenext dari repo ini, atau hapus entri MCP platform pilihan")
    .option(...PLATFORM_OPT)
    .option("--dry-run", "Tampilkan yang akan dihapus tanpa menulis")
    .option("-y, --yes", "Jangan minta konfirmasi")
    .action((opts: { dryRun?: boolean; yes?: boolean } & PlatformOptions) =>
      friendly(async () => {
        const root = (await findProjectRoot()) ?? process.cwd();
        const edits = await planRemove({ root, platforms: opts.platform });
        if (edits.length === 0) {
          console.log("✓ Tidak ada jejak Catenext di repo ini.");
          return;
        }
        for (const l of summarize(edits)) console.log(l);
        console.log("  Skill repo dan file state tetap disimpan.");
        if (opts.dryRun) {
          console.log(`(dry-run) ${edits.length} file akan berubah. Tidak ada yang ditulis.`);
          return;
        }
        if (!opts.yes && !(await confirm(`Lanjutkan di ${root}? [y/N] `))) {
          console.log("Dibatalkan. (Tanpa terminal interaktif, pakai --yes.)");
          process.exitCode = 1;
          return;
        }
        await applyFileEdits(root, edits);
        console.log(
          "✓ Perubahan penghapusan diterapkan. Mulai ulang klien MCP untuk memuat konfigurasi baru.",
        );
      }),
    );

  program
    .command("doctor")
    .description("Diagnose local Catenext setup without changing project files")
    .option("--json", "Print a machine-readable report")
    .option("--fix", "Tighten mode on the owned, regular SQLite state file")
    .action(async (opts: { json?: boolean; fix?: boolean }) => {
      const report = await runDoctor({ ...opts, version });
      console.log(opts.json ? JSON.stringify(report) : formatDoctorReport(report));
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command("backup")
    .description("Create a consistent SQLite snapshot of local Catenext state (0600)")
    .argument("<out>", "Output backup file path")
    .option("--force", "Overwrite existing non-empty target file")
    .option("--json", "Print machine-readable JSON output")
    .action((out: string, opts: { force?: boolean; json?: boolean }) =>
      friendly(async () => {
        const root = await requireRoot(true);
        const config = await readConfig(root);
        const result = await backupDatabase({
          stateFile: stateFilePath(root, config),
          outPath: out,
          force: Boolean(opts.force),
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`✓ Backup written to ${result.out} (${result.bytes} bytes)`);
      }),
    );

  program
    .command("restore")
    .description("Validate and restore local Catenext SQLite state from a backup")
    .argument("<file>", "Source backup SQLite file path")
    .option("--force", "Replace existing SQLite state after saving a timestamped safety copy")
    .option("--json", "Print machine-readable JSON output")
    .action((file: string, opts: { force?: boolean; json?: boolean }) =>
      friendly(async () => {
        const root = await requireRoot(true);
        const config = await readConfig(root);
        const result = await restoreDatabase({
          stateFile: stateFilePath(root, config),
          fromPath: file,
          force: Boolean(opts.force),
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`✓ State restored to ${result.stateFile} (schema v${result.schemaVersion})`);
        if (result.safetyBackup) {
          console.log(`  Safety backup saved: ${result.safetyBackup}`);
        }
      }),
    );

  program
    .command("mcp")
    .description("Jalankan server MCP lokal (stdio)")
    .option(
      "--allow-crud",
      "Trust every client of this MCP instance to edit or cancel tasks and edit epics (not available for workers)",
    )
    .option("--root <path>", "Root repo (default: cari .catenext/config.yaml dari folder saat ini)")
    .option(
      "--role <role>",
      `Filter tool MCP per peran (${MCP_ROLES.join(" | ")})`,
      (v: string) => {
        const parsed = McpRoleSchema.safeParse(v.trim());
        if (!parsed.success) {
          throw new InvalidArgumentError(
            `Role tidak valid: ${JSON.stringify(v)}. Pilih: ${MCP_ROLES.join(", ")}.`,
          );
        }
        return parsed.data;
      },
    )
    .action((opts: { root?: string; role?: "orchestrator" | "worker"; allowCrud?: boolean }) =>
      runMcpServer({ root: opts.root, role: opts.role, allowCrud: opts.allowCrud, version }),
    );

  program
    .command("config")
    .description("Validasi .catenext/config.yaml di folder ini")
    .action(async () => {
      try {
        const cfg = await readConfig();
        console.log(`✓ Config valid: repo "${cfg.repo_name}" (project ${cfg.project_id})`);
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(`✗ ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}
