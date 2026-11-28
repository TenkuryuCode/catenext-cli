import type { Command } from "commander";
import { readConfig } from "../config.js";
import { applyInit, planInit, renderDiff } from "../init/index.js";
import { formatInitDryRunPreview, planInitDryRunPreview } from "../init/preview.js";
import { summarize } from "../maintenance.js";
import { discoverSkillCatalog, formatSkillCatalogSummary } from "../skill-catalog.js";
import { formatChecks, verifySetup } from "../verify.js";
import { defaultMcpCommand, friendly, PLATFORM_OPT, type PlatformOptions } from "./shared.js";

/** Register the `init` command. */
export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Siapkan orkestrasi lokal dan pasang entri MCP untuk platform pilihan")
    .option(...PLATFORM_OPT)
    .option("--project <id>", "UUID proyek yang sudah ada (opsional; default: buat ID lokal baru)")
    .option("--project-name <name>", "Nama proyek untuk konteks/ringkasan lokal (opsional)")
    .option("--repo <name>", "repo_name untuk repo ini (default: nama folder)")
    .option("--mcp-command <cmd>", 'Perintah untuk menjalankan CLI ini, mis. "catenext"')
    .option("--no-agents-md", "Jangan tulis blok Catenext di AGENTS.md")
    .option(
      "--user-skills",
      "Sertakan penemuan read-only skill global pengguna untuk platform pilihan",
    )
    .option("--dry-run", "Tampilkan diff tanpa menulis ke disk")
    .option("-y, --yes", "Lewati interview TTY; pakai rekomendasi / flag")
    .addHelpText(
      "after",
      "\nUntuk layout monorepo atau state bersama lintas repo, atur layout dan state_file di .catenext/config.yaml. Path state_file relatif terhadap root repo. State default: .catenext/catenext.sqlite.",
    )
    .action(
      (
        opts: {
          project?: string;
          projectName?: string;
          repo?: string;
          mcpCommand?: string;
          agentsMd?: boolean;
          userSkills?: boolean;
          dryRun?: boolean;
          yes?: boolean;
        } & PlatformOptions,
      ) =>
        friendly(async () => {
          const root = process.cwd();
          const { runInitInterview } = await import("../interview.js");
          const answers = await runInitInterview(root, {
            yes: Boolean(opts.yes || opts.dryRun),
            platforms: opts.platform,
          });
          const custom = opts.mcpCommand?.trim().split(/\s+/).filter(Boolean);
          const mcpCommand = custom?.[0]
            ? { command: custom[0], args: custom.slice(1) }
            : defaultMcpCommand();
          const platforms = opts.platform?.length ? opts.platform : answers.platforms;
          const changes = await planInit({
            root,
            projectId: opts.project,
            projectName: opts.projectName,
            repoName: opts.repo,
            platforms,
            mcpCommand,
            replaceMcpCommand: Boolean(custom?.[0]),
            agentsMd: opts.agentsMd,
          });

          if (changes.length === 0) {
            console.log("✓ Tidak ada perubahan: Catenext sudah terpasang di repo ini.");
          } else if (opts.dryRun) {
            console.log(renderDiff(changes));
            const preview = await planInitDryRunPreview({
              root,
              changes,
              platforms,
              personaSeed: answers.personaSeed,
              stack: answers.stack,
              includeUserGlobalSkills: Boolean(opts.userSkills),
            });
            for (const line of formatInitDryRunPreview(preview)) console.log(line);
            console.log(`(dry-run) ${changes.length} file akan berubah. Tidak ada yang ditulis.`);
            return;
          } else {
            await applyInit(root, changes);
            for (const c of changes)
              console.log(`${c.before === null ? "+ dibuat " : "~ diubah "} ${c.path}`);
          }
          if (opts.dryRun) return;

          const { LocalService } = await import("../local-service.js");
          const config = await readConfig(root);
          const service = new LocalService(root, config);
          await service.ensureSeed({
            platforms,
            locale: answers.locale,
            personaSeed: answers.personaSeed,
            stack: answers.stack.length ? answers.stack : (config.stack ?? []),
          });
          const { planSubagents } = await import("../subagents.js");
          const personas = (await service.callTool("list_personas", {})).personas;
          const sub = await planSubagents(root, personas, platforms, {
            stack: config.stack ?? [],
            repoName: config.repo_name,
            layout: config.layout,
          });
          const agentEdits = sub.edits;
          if (agentEdits.length) {
            const { applyFileEdits } = await import("../maintenance.js");
            await applyFileEdits(root, agentEdits);
            for (const line of summarize(agentEdits)) console.log(line);
          }

          const skillCatalog = await discoverSkillCatalog(root, {
            platforms,
            includeUserGlobal: Boolean(opts.userSkills),
          });
          for (const line of formatSkillCatalogSummary(skillCatalog)) console.log(line);

          console.log("");
          console.log(formatChecks(await verifySetup(root, config, platforms)));
          console.log(
            `\nMulai ulang klien MCP agar server "catenext" terbaca. Log server: stderr \`catenext mcp\`.`,
          );
        }),
    );
}
