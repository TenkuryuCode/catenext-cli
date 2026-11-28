#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  BLOCKER_CATEGORIES,
  DOCUMENT_KINDS,
  type PlatformId,
  PlatformIdSchema,
  ReleaseTaskInput,
  type SkillSourceId,
  SkillSourceIdSchema,
  SUPPORTED_PLATFORMS,
} from "@catenext/shared";
import { Command, InvalidArgumentError } from "commander";
import { BackupError, backupDatabase, restoreDatabase } from "./backup.js";
import {
  ConfigError,
  configuredPlatforms,
  findProjectRoot,
  readConfig,
  stateFilePath,
} from "./config.js";
import { checkpointDatabaseFile } from "./db/open.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import {
  type ClaimOptions,
  permissionGrant,
  permissionList,
  permissionRevoke,
  permissionSet,
  type TaskLogOptions,
  taskBlock,
  taskClaim,
  taskDone,
  taskLog,
  taskManage,
  taskNext,
  taskReview,
} from "./fallback.js";
import { applyInit, planInit, renderDiff } from "./init/index.js";
import { McpConfigError } from "./init/mcp-config.js";
import { formatInitDryRunPreview, planInitDryRunPreview } from "./init/preview.js";
import { LocalServiceError } from "./local-service.js";
import { PERMISSION_ACTIONS } from "./local-state.js";
import { applyFileEdits, planRemove, planSync, summarize } from "./maintenance.js";
import { MCP_ROLES, McpRoleSchema } from "./mcp/catalog.js";
import { runMcpServer } from "./mcp/run.js";
import { nodeLauncherWarning, stableNodeCommand } from "./node-command.js";
import {
  boardShow,
  cliService,
  docArchive,
  docGet,
  docList,
  docRestore,
  docSave,
  epicArchive,
  epicCreate,
  epicList,
  epicRestore,
  epicSummary,
  epicTemplates,
  epicUpdate,
  PlanningInputError,
  personaList,
  personaRemove,
  personaSet,
  prepare,
  regenPersonaSubagents,
  requireRoot,
  searchShow,
  taskCancel,
  taskCreate,
  taskDeps,
  taskUpdate,
} from "./planning.js";
import {
  discoverSkillCatalog,
  formatSkillCatalogSummary,
  loadCatalogSkill,
} from "./skill-catalog.js";
import { SkillError, skillCreate, skillList, skillRemove, skillSet } from "./skills.js";
import { planSubagents } from "./subagents.js";
import {
  buildTemplateBundle,
  formatImportSummary,
  importTemplateBundle,
  loadTemplateBundle,
  TemplateBundleError,
  warnRedactions,
  writeTemplateBundle,
} from "./template-bundle.js";
import { formatChecks, verifySetup } from "./verify.js";
import { runWatch } from "./watch.js";
import { formatWorktreeStatus, readWorktreeStatus } from "./worktree-status.js";
import {
  pruneWorktrees,
  readWorktreeInventory,
  type WorktreeEntry,
  WorktreeError,
} from "./worktrees.js";

/** Diisi build.mjs dari package.json; "dev" saat dijalankan lewat tsc/tsx. */
const VERSION = process.env.CATENEXT_BUILD_VERSION || "0.0.0-dev";

const program = new Command();

program
  .name("catenext")
  .description("Estafet tugas & konteks antar-agen AI coding")
  .version(VERSION);

/** Error yang ditulis untuk manusia: cetak tanpa stack trace. */
async function friendly(fn: () => Promise<void>) {
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
function defaultMcpCommand(): { command: string; args: string[] } {
  const self = fileURLToPath(import.meta.url);
  const entry = self.endsWith(".ts") ? resolve(dirname(self), "../dist/index.js") : self;
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

const PLATFORM_OPT = [
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

type PlatformOptions = { platform?: PlatformId[] };

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
        const { runInitInterview } = await import("./interview.js");
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

        const { LocalService } = await import("./local-service.js");
        const config = await readConfig(root);
        const service = new LocalService(root, config);
        await service.ensureSeed({
          platforms,
          locale: answers.locale,
          personaSeed: answers.personaSeed,
          stack: answers.stack.length ? answers.stack : (config.stack ?? []),
        });
        const { planSubagents } = await import("./subagents.js");
        const personas = (await service.callTool("list_personas", {})).personas;
        const sub = await planSubagents(root, personas, platforms, {
          stack: config.stack ?? [],
          repoName: config.repo_name,
          layout: config.layout,
        });
        const agentEdits = sub.edits;
        if (agentEdits.length) {
          const { applyFileEdits } = await import("./maintenance.js");
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

// --- Perencanaan lokal (memakai state yang sama dengan tool MCP) ---

const epic = program.command("epic").description("Kelola epic proyek ini dari terminal");
const epicRun = epic
  .command("run")
  .description("Bounded local run; needs a human or trusted host to drive each step");
const runOutput = (result: unknown) => console.log(JSON.stringify(result, null, 2));
for (const action of ["preview", "start"] as const) {
  const cmd = epicRun
    .command(action)
    .argument("<epic_id>")
    .requiredOption("--base <local-branch>")
    .requiredOption(
      "--check <command>",
      "Trusted host's final verification command (not executed by Catenext)",
    );
  if (action === "start")
    cmd.requiredOption("--if-snapshot <sha256>", "Digest from exact preview shown to human");
  cmd.action((id: string, opts: { base: string; check: string; ifSnapshot: string }) =>
    friendly(async () => {
      const service = await cliService();
      const { base, check } = opts;
      const preview = await service.epicRun(id, { action: "preview", base, check });
      if (action === "preview") return runOutput(preview);
      if (!("max_worktrees" in preview) || preview.snapshot !== opts.ifSnapshot) {
        throw new LocalServiceError(
          "stale_approval",
          "Plan changed since preview; inspect it and ask for new confirmation.",
        );
      }
      console.error(JSON.stringify(preview, null, 2));
      if (!(await confirm(`Authorize this exact local run (${opts.ifSnapshot})? [y/N] `))) {
        throw new LocalServiceError(
          "human_approval_required",
          "Start requires interactive human confirmation; no non-interactive override.",
        );
      }
      runOutput(
        await service.epicRun(id, { action: "start", base, check, snapshot: opts.ifSnapshot }),
      );
    }),
  );
}
for (const action of ["resume", "close"] as const) {
  epicRun
    .command(action)
    .argument("<epic_id>")
    .description(
      action === "resume"
        ? "Reconcile local progress and show eligible steps; does not dispatch workers"
        : "End run governance; preserve tasks, branches and journal",
    )
    .action((id: string) =>
      friendly(async () => runOutput(await (await cliService()).epicRun(id, { action }))),
    );
}
epicRun
  .command("pause")
  .argument("<epic_id>")
  .requiredOption("--reason <text>")
  .action((id: string, { reason }: { reason: string }) =>
    friendly(async () =>
      runOutput(await (await cliService()).epicRun(id, { action: "pause", reason })),
    ),
  );
epicRun
  .command("review")
  .argument("<epic_id>")
  .requiredOption("--task <uuid>")
  .requiredOption("--head <sha>")
  .requiredOption("--reviewer <alias>")
  .requiredOption("--decision <accept|request_changes>")
  .requiredOption("--feedback <text>")
  .description("Record trusted host's delegated review result; not human approval")
  .action(
    (
      id: string,
      opts: {
        task: string;
        head: string;
        reviewer: string;
        decision: "accept" | "request_changes";
        feedback: string;
      },
    ) =>
      friendly(async () =>
        runOutput(await (await cliService()).epicRun(id, { action: "review", ...opts })),
      ),
  );
epicRun
  .command("verify")
  .argument("<epic_id>")
  .requiredOption("--head <sha>")
  .requiredOption("--path <absolute-checkout>")
  .requiredOption("--attempt <uuid>")
  .requiredOption("--result <pass|fail>")
  .description("Record trusted host's observed final check result at exact Git HEAD")
  .action(
    (id: string, opts: { head: string; path: string; attempt: string; result: "pass" | "fail" }) =>
      friendly(async () =>
        runOutput(await (await cliService()).epicRun(id, { action: "verify", ...opts })),
      ),
  );

epic
  .command("list")
  .description("Daftar epic beserta jumlah task per status")
  .option("--include-archived")
  .option("--json", "Keluaran JSON")
  .action((opts: { json?: boolean; includeArchived?: boolean }) =>
    friendly(async () => epicList(await cliService(), Boolean(opts.json), opts)),
  );
epic
  .command("templates")
  .description("Daftar template epic bawaan")
  .option("--json", "Keluaran JSON")
  .action((opts: { json?: boolean }) => friendly(async () => epicTemplates(Boolean(opts.json))));
epic
  .command("create")
  .description("Buat epic baru (opsional dari --template)")
  .argument("[title]", 'Judul epic, mis. "Fitur login" (wajib tanpa --template)')
  .option("-d, --description <text>", "Deskripsi / kriteria selesai")
  .option(
    "-t, --template <id>",
    "Buat epic + draft task dari template (mis. fitur-login, crud-api)",
  )
  .option("--json", "Keluaran JSON")
  .action(
    (
      title: string | undefined,
      opts: { description?: string; template?: string; json?: boolean },
    ) => friendly(async () => epicCreate(await cliService(), title, opts)),
  );
epic
  .command("update")
  .description("Perbarui judul atau deskripsi epic")
  .argument("<epic_id>", "ID epic yang ingin diperbarui")
  .option("--title <text>", "Judul baru")
  .option("-d, --description <text>", "Deskripsi baru")
  .option("--json", "Keluaran JSON")
  .action((epicId: string, opts: { title?: string; description?: string; json?: boolean }) =>
    friendly(async () => epicUpdate(await cliService(), epicId, opts)),
  );

epic
  .command("summary <id>")
  .option("--refresh")
  .option("--overview <text>")
  .option("--expected-version <n>")
  .option("--json")
  .action((id, opts) => friendly(async () => epicSummary(await cliService(), id, opts)));
epic
  .command("archive <id>")
  .option("--dry-run")
  .option("--json")
  .action((id, opts) => friendly(async () => epicArchive(await cliService(), id, opts)));
epic
  .command("restore <id>")
  .option("--json")
  .action((id, opts) => friendly(async () => epicRestore(await cliService(), id, opts)));
const task = program.command("task").description("Ajukan dan kelola rencana task (masuk DRAFT)");
task
  .command("create")
  .description(
    "Ajukan task berdependensi dari file JSON (--file / '-' stdin) atau inline (--title & --prompt)",
  )
  .requiredOption("--epic <id>", "epic_id tujuan (lihat `catenext epic list`)")
  .option("-f, --file <path>", "File rencana JSON, atau '-' untuk stdin")
  .option("--title <text>", "Judul task (mode inline)")
  .option("--prompt <text>", "Instruksi task (mode inline)")
  .option("--ref <ref>", "Referensi task lokal untuk mode inline (default: t1)")
  .option("--persona <alias>", "Alias persona penanggung jawab (mode inline)")
  .option("--role <role>", "Role task (mode inline)")
  .option("--repo <name>", "Target repo (mode inline)")
  .option("--depends-on <ids...>", "Daftar UUID dependensi (mode inline)")
  .option("--requires-approval", "Wajibkan persetujuan (mode inline)")
  .option("--json", "Keluaran JSON")
  .action(
    (opts: {
      epic: string;
      file?: string;
      title?: string;
      prompt?: string;
      ref?: string;
      persona?: string;
      role?: string;
      repo?: string;
      dependsOn?: string[];
      requiresApproval?: boolean;
      json?: boolean;
    }) => friendly(async () => taskCreate(await cliService(), opts)),
  );

task
  .command("update")
  .description("Perbarui detail task (judul, prompt, persona, role, repo, atau hapus stale)")
  .argument("<task_id>")
  .option("--title <text>", "Judul baru")
  .option("--prompt <text>", "Instruksi baru")
  .option("--persona <alias>", "Alias persona baru")
  .option("--role <role>", "Role baru")
  .option("--repo <name>", "Target repo baru")
  .option("--clear-stale", "Bersihkan flag stale (is_stale=false)")
  .option("--json", "Keluaran JSON")
  .action(
    (
      taskId: string,
      opts: {
        title?: string;
        prompt?: string;
        persona?: string;
        role?: string;
        repo?: string;
        clearStale?: boolean;
        json?: boolean;
      },
    ) => friendly(async () => taskUpdate(await cliService(), taskId, opts)),
  );

task
  .command("cancel")
  .description("Batalkan (hapus) task yang belum/tidak dikunci dan tanpa task dependen")
  .argument("<task_id>")
  .option("--json", "Keluaran JSON")
  .action((taskId: string, opts: { json?: boolean }) =>
    friendly(async () => taskCancel(await cliService(), taskId, opts)),
  );

task
  .command("deps")
  .description("Atur ulang daftar UUID dependensi task (validasi eksistensi & siklus DAG)")
  .argument("<task_id>")
  .argument("[dep_ids...]", "Daftar UUID dependensi baru (kosongkan untuk menghapus semua)")
  .option("--json", "Keluaran JSON")
  .action((taskId: string, depIds: string[], opts: { json?: boolean }) =>
    friendly(async () => taskDeps(await cliService(), taskId, depIds, opts)),
  );

task
  .command("approve")
  .description("Setujui rencana satu task lokal (DRAFT menjadi TODO)")
  .argument("<task_id>")
  .option("--if-snapshot <sha256>", "Tolak bila snapshot dari catenext brief sudah berubah")
  .option("--json", "Keluaran JSON")
  .action((taskId: string, opts: { json?: boolean; ifSnapshot?: string }) =>
    friendly(async () =>
      taskManage(
        await cliService(),
        { action: "approve_plan", task_id: taskId },
        Boolean(opts.json),
        opts.ifSnapshot,
      ),
    ),
  );

program
  .command("unblock")
  .description("Buka kembali task BLOCKED setelah hambatan teratasi")
  .argument("<task_id>")
  .option("--json", "Keluaran JSON")
  .action((taskId: string, opts: { json?: boolean }) =>
    friendly(async () =>
      taskManage(await cliService(), { action: "unblock", task_id: taskId }, Boolean(opts.json)),
    ),
  );

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

program
  .command("board")
  .option("--include-archived")
  .description("Orchestrator: papan proyek lintas repo (task, status, persona, repo)")
  .option("--epic <id>", "Batasi ke satu epic")
  .option("--task <id>", "Batasi ke satu task")
  .option(
    "--status <status>",
    "Filter status (boleh diulang)",
    (v: string, p: string[]) => [...p, v],
    [] as string[],
  )
  .option("--json", "Keluaran JSON")
  .action((opts: { epic?: string; task?: string; status: string[]; json?: boolean }) =>
    friendly(async () => boardShow(await cliService(), opts)),
  );

program
  .command("log")
  .description("Tampilkan riwayat audit event task lokal")
  .argument("[task_id]", "Filter berdasarkan ID task (opsional)")
  .option("-n, --limit <n>", "Jumlah maksimal event", Number, 20)
  .option("--event <type>", "Filter jenis event (cocok persis)")
  .option("--actor <actor>", "Filter pelaku (cocok persis)")
  .option(
    "--since <iso-or-relative>",
    "Sejak timestamp ISO dengan zona waktu atau durasi (24h, 7d, 30m)",
  )
  .option("--format <table|json|csv>", "Format keluaran (default: table)")
  .option("--json", "Keluaran JSON (alias --format json)")
  .action((taskId: string | undefined, opts: TaskLogOptions) =>
    friendly(async () => taskLog(await cliService(), taskId, opts)),
  );

program
  .command("brief")
  .description("Orchestrator: ringkasan sesi hemat token (ready/blocked/next ask)")
  .option("--verbose", "Teks blocker lebih panjang")
  .option("--json", "Keluaran JSON")
  .action((opts: { verbose?: boolean; json?: boolean }) =>
    friendly(async () => {
      const res = await (await cliService()).callTool("session_brief", {
        verbose: Boolean(opts.verbose),
      });
      if (opts.json) return console.log(JSON.stringify(res, null, 2));
      console.log(`ready=${res.ready_count} blocked=${res.blocked_count} draft=${res.draft_count}`);
      for (const line of res.lines) console.log(`[${line.kind}] ${line.text}`);
    }),
  );

program
  .command("watch")
  .description(
    "Monitor board, lease/worktree, persetujuan manusia, dan task_events (read-only, polling)",
  )
  .option(
    "--interval <ms>",
    "Interval polling dalam milidetik (default: 2000)",
    (value: string) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 250) {
        throw new InvalidArgumentError("--interval minimal 250 ms");
      }
      return Math.floor(n);
    },
    2000,
  )
  .option("--once", "Cetak satu snapshot lalu keluar")
  .option("--epic <id>", "Filter board/lease/approval/event untuk epic ini")
  .option("--json", "Keluaran JSON")
  .action((opts: { interval: number; once?: boolean; epic?: string; json?: boolean }) =>
    friendly(async () => {
      const root = await requireRoot(true);
      const config = await readConfig(root);
      await runWatch({
        root,
        config,
        intervalMs: opts.interval,
        once: Boolean(opts.once),
        epic: opts.epic,
        json: Boolean(opts.json),
      });
    }),
  );

const rootCmd = program
  .command("root")
  .description("Workspace roots di luar (atau di dalam) checkout; dimiliki persona");
rootCmd
  .command("list")
  .option("--json", "Keluaran JSON")
  .action((opts: { json?: boolean }) =>
    friendly(async () => {
      const res = await (await cliService()).callTool("manage_roots", { action: "list" });
      if (opts.json) return console.log(JSON.stringify(res, null, 2));
      if (!res.roots.length) return console.log("Belum ada workspace root.");
      for (const row of res.roots) {
        console.log(
          `${row.id}  ${row.path}  owner=${row.owner_persona ?? "-"}  ${row.label ?? ""}`.trim(),
        );
      }
    }),
  );
rootCmd
  .command("add")
  .argument("<path>", "Path absolut atau relatif")
  .option("--persona <alias>", "Persona pemilik root")
  .option("--label <text>", "Label singkat")
  .option("--json", "Keluaran JSON")
  .action((path: string, opts: { persona?: string; label?: string; json?: boolean }) =>
    friendly(async () => {
      const res = await (await cliService()).callTool("manage_roots", {
        action: "add",
        path,
        persona: opts.persona,
        label: opts.label,
      });
      if (opts.json) return console.log(JSON.stringify(res, null, 2));
      console.log(`✓ ${res.roots.length} root terdaftar`);
    }),
  );
rootCmd
  .command("remove")
  .argument("<pathOrId>", "Path atau root id")
  .option("--json", "Keluaran JSON")
  .action((pathOrId: string, opts: { json?: boolean }) =>
    friendly(async () => {
      const asId = /^[0-9a-f-]{36}$/i.test(pathOrId);
      const res = await (await cliService()).callTool("manage_roots", {
        action: "remove",
        ...(asId ? { root_id: pathOrId } : { path: pathOrId }),
      });
      if (opts.json) return console.log(JSON.stringify(res, null, 2));
      console.log(`✓ ${res.roots.length} root tersisa`);
    }),
  );

const permCmd = program.command("permission").description("Lihat dan atur matriks izin proyek ini");
permCmd
  .command("list", { isDefault: true })
  .description("Daftar izin saat ini per aksi")
  .option("--json", "Keluaran JSON")
  .action((opts: { json?: boolean }) =>
    friendly(async () => permissionList(await cliService(), Boolean(opts.json))),
  );
permCmd
  .command("set")
  .description(`Atur principal untuk aksi (${PERMISSION_ACTIONS.join(", ")})`)
  .argument("<action>", `Salah satu: ${PERMISSION_ACTIONS.join(", ")}`)
  .argument("<principals...>", "Principal yang diizinkan (mis. human orchestrator)")
  .option("--json", "Keluaran JSON")
  .action((action: string, principals: string[], opts: { json?: boolean }) =>
    friendly(async () => permissionSet(await cliService(), action, principals, Boolean(opts.json))),
  );
permCmd
  .command("grant")
  .description("Tambahkan principal ke aksi permission")
  .argument("<action>", `Salah satu: ${PERMISSION_ACTIONS.join(", ")}`)
  .argument("<principal>", "Principal yang ditambahkan (mis. human, orchestrator)")
  .option("--json", "Keluaran JSON")
  .action((action: string, principal: string, opts: { json?: boolean }) =>
    friendly(async () =>
      permissionGrant(await cliService(), action, principal, Boolean(opts.json)),
    ),
  );
permCmd
  .command("revoke")
  .description("Cabut principal dari aksi permission")
  .argument("<action>", `Salah satu: ${PERMISSION_ACTIONS.join(", ")}`)
  .argument("<principal>", "Principal yang dicabut (mis. orchestrator)")
  .option("--json", "Keluaran JSON")
  .action((action: string, principal: string, opts: { json?: boolean }) =>
    friendly(async () =>
      permissionRevoke(await cliService(), action, principal, Boolean(opts.json)),
    ),
  );

function parseIntRange(flag: string, min: number, max: number) {
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

program
  .command("index")
  .description("Bangun ulang indeks graf kode lokal (file/symbol/import) di SQLite")
  .option("--summary", "Cetak ringkasan arsitektur graf kode")
  .option(
    "--write-doc [slug]",
    "Simpan ringkasan arsitektur ke dokumen proyek (default: architecture)",
  )
  .option("--impact <path>", "Analisis file terdampak secara transitif untuk <path>")
  .option(
    "--depth <n>",
    "Kedalaman kelompok direktori (1-5) atau hop dampak (1-3)",
    parseIntRange("--depth", 1, 5),
    2,
  )
  .option(
    "--limit <n>",
    "Jumlah maksimal file terdampak untuk --impact (1-40)",
    parseIntRange("--limit", 1, 40),
    20,
  )
  .option(
    "--max-hubs <n>",
    "Jumlah maksimal hub arsitektur (1-30)",
    parseIntRange("--max-hubs", 1, 30),
    12,
  )
  .option("--include-tests", "Sertakan file test pada ringkasan dan analisis dampak")
  .option("--force", "Paksa re-index penuh meskipun indeks masih fresh")
  .option("--json", "Keluaran JSON")
  .action(
    (opts: {
      summary?: boolean;
      writeDoc?: string | boolean;
      impact?: string;
      depth: number;
      limit: number;
      maxHubs: number;
      includeTests?: boolean;
      force?: boolean;
      json?: boolean;
    }) =>
      friendly(async () => {
        if (opts.impact && opts.depth > 3) {
          throw new LocalServiceError(
            "invalid_input",
            "--impact hanya mendukung --depth 1-3 (gunakan --depth 1..3; --summary mendukung 1..5).",
          );
        }

        const root = await requireRoot();
        const config = await readConfig(root);
        const dbPath = stateFilePath(root, config);
        const service = await cliService(root);
        // Ensure DB + project row exist.
        await service.callTool("session_brief", {});
        const rootsRes = await service.callTool("manage_roots", { action: "list" });
        const rootDirs = [
          { rootId: null, dir: root },
          ...rootsRes.roots.map((r) => ({ rootId: r.id, dir: r.path })),
        ];

        const {
          getGraphCounts,
          getGraphIndexFastPathState,
          indexProjectGraph,
          MICRO_REINDEX_MAX_FILES,
          microReindexModifiedFiles,
        } = await import("./db/graph-index.js");
        const canFastPath = Boolean((opts.summary || opts.impact) && !opts.force);
        const fastState = canFastPath
          ? getGraphIndexFastPathState(dbPath, config.project_id, rootDirs)
          : undefined;
        const skippedIndex = Boolean(fastState && fastState.indexed_files > 0 && !fastState.stale);
        let result: Awaited<ReturnType<typeof indexProjectGraph>>;
        if (skippedIndex) {
          result = getGraphCounts(dbPath, config.project_id);
        } else if (
          canFastPath &&
          fastState &&
          fastState.indexed_files > 0 &&
          fastState.reason === "modified_files" &&
          fastState.modified_files &&
          fastState.modified_files.length > 0 &&
          fastState.modified_files.length <= MICRO_REINDEX_MAX_FILES
        ) {
          const micro = await microReindexModifiedFiles(
            dbPath,
            config.project_id,
            rootDirs,
            fastState.modified_files,
          );
          result = micro.applied
            ? micro.counts
            : await indexProjectGraph(dbPath, config.project_id, root, {
                rebuildEdges: opts.force,
              });
        } else {
          result = await indexProjectGraph(dbPath, config.project_id, root, {
            rebuildEdges: opts.force,
          });
        }

        const includeTests = Boolean(opts.includeTests);
        const wantDoc = opts.writeDoc !== undefined && opts.writeDoc !== false;
        const wantSummary = Boolean(opts.summary || wantDoc);
        let summary: Awaited<ReturnType<typeof service.callTool<"graph_summary">>> | undefined;
        let impact: Awaited<ReturnType<typeof service.callTool<"graph_impact">>> | undefined;
        let savedDoc: Awaited<ReturnType<typeof service.callTool<"save_document">>> | undefined;

        if (wantSummary) {
          summary = await service.callTool("graph_summary", {
            depth: opts.depth,
            max_hubs: opts.maxHubs,
            include_mermaid: true,
            include_tests: includeTests,
          });
        }

        if (opts.impact) {
          impact = await service.callTool("graph_impact", {
            path: opts.impact,
            depth: opts.depth,
            limit: opts.limit,
            include_tests: includeTests,
          });
        }

        if (wantDoc && summary) {
          const { renderArchitectureMarkdown } = await import("./db/graph-summary.js");
          const docSlug =
            typeof opts.writeDoc === "string" && opts.writeDoc.trim()
              ? opts.writeDoc.trim()
              : "architecture";
          const content = renderArchitectureMarkdown(summary, {
            depth: opts.depth,
            includeTests,
          });
          let expectedVersion: number | undefined;
          try {
            const existing = await service.callTool("get_document", {
              slug: docSlug,
              outline_only: true,
            });
            expectedVersion = existing.version;
          } catch (error) {
            if (!(error instanceof LocalServiceError && error.code === "not_found")) {
              throw error;
            }
          }
          savedDoc = await service.callTool("save_document", {
            slug: docSlug,
            title: "Project architecture",
            kind: "architecture",
            content,
            ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
          });
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                ...result,
                ...(skippedIndex ? { skipped: true } : {}),
                ...(summary ? { summary } : {}),
                ...(impact ? { impact } : {}),
                ...(savedDoc ? { document: savedDoc.document, created: savedDoc.created } : {}),
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log(
          skippedIndex
            ? `✓ index fresh (skipped re-index) files=${result.files} symbols=${result.symbols} edges=${result.edges}`
            : `✓ indexed files=${result.files} symbols=${result.symbols} edges=${result.edges}`,
        );
        if (opts.summary && summary) {
          const { renderArchitectureMarkdown } = await import("./db/graph-summary.js");
          console.log(
            `\n${renderArchitectureMarkdown(summary, { depth: opts.depth, includeTests }).trimEnd()}`,
          );
        }
        if (impact) {
          const { renderImpactMarkdown } = await import("./db/graph-summary.js");
          console.log(`\n${renderImpactMarkdown(impact).trimEnd()}`);
        }
        if (savedDoc) {
          console.log(
            `✓ Dokumen "${savedDoc.document.slug}" ${savedDoc.created ? "dibuat" : "diperbarui"} (v${savedDoc.document.version}).`,
          );
        }
      }),
  );

const doc = program
  .command("doc")
  .description("Dokumen proyek lokal (blueprint, ERD, arsitektur, keputusan)");
doc
  .command("list")
  .option("--include-archived", "Sertakan dokumen yang sudah diarsipkan")
  .option("--json", "Keluaran JSON")
  .action((opts: { json?: boolean; includeArchived?: boolean }) =>
    friendly(async () =>
      docList(await cliService(), {
        json: opts.json,
        includeArchived: opts.includeArchived,
      }),
    ),
  );
doc
  .command("get")
  .argument("<slug>")
  .option("--outline", "Hanya daftar heading Markdown (tanpa isi lengkap)")
  .option("--section <title>", "Hanya satu bagian yang cocok dengan judul heading")
  .option("--json", "Keluaran JSON")
  .action((slug: string, opts: { json?: boolean; outline?: boolean; section?: string }) =>
    friendly(async () =>
      docGet(await cliService(), slug, {
        json: opts.json,
        outline: opts.outline,
        section: opts.section,
      }),
    ),
  );
doc
  .command("archive")
  .argument("<slug>")
  .option("--json", "Keluaran JSON")
  .action((slug: string, opts: { json?: boolean }) =>
    friendly(async () => docArchive(await cliService(), slug, Boolean(opts.json))),
  );
doc
  .command("restore")
  .argument("<slug>")
  .option("--json", "Keluaran JSON")
  .action((slug: string, opts: { json?: boolean }) =>
    friendly(async () => docRestore(await cliService(), slug, Boolean(opts.json))),
  );
doc
  .command("save")
  .argument("<slug>", "Slug dokumen, mis. blueprint atau erd")
  .requiredOption("--file <path>", "File Markdown berisi dokumen")
  .option("--title <text>", "Judul dokumen (default: slug)")
  .option("--kind <kind>", `Salah satu: ${DOCUMENT_KINDS.join(", ")}`, "other")
  .option(
    "--expected-version <n>",
    "Versi yang Anda baca (0 = dokumen baru); mencegah menimpa sesi lain. Jangan pakai --version (bentrok flag versi CLI).",
  )
  .option("--json", "Keluaran JSON")
  .action(
    (
      slug: string,
      opts: {
        file: string;
        title?: string;
        kind: string;
        expectedVersion?: string;
        json?: boolean;
      },
    ) =>
      friendly(async () =>
        docSave(await cliService(), slug, {
          file: opts.file,
          title: opts.title,
          kind: opts.kind,
          version: opts.expectedVersion,
          json: opts.json,
        }),
      ),
  );

program
  .command("search")
  .description("Cari dokumen, skill, task, atau kode lokal")
  .argument("<query>", "Query pencarian")
  .option(
    "--source <src>",
    "Sumber: document|skill|task|code (bisa diulang)",
    (v, prev: string[]) => [...prev, v],
    [] as string[],
  )
  .option("-n, --limit <n>", "Jumlah hasil", (v) => Number.parseInt(v, 10), 8)
  .option("--json", "Keluaran JSON")
  .action((query: string, opts: { source: string[]; limit: number; json?: boolean }) =>
    friendly(async () =>
      searchShow(query, {
        source: opts.source.length ? opts.source : undefined,
        limit: opts.limit,
        json: opts.json,
      }),
    ),
  );

// --- Fallback untuk agen tanpa MCP (blok AGENTS.md menunjuk ke sini) ---------

const collect = (v: string, prev: string[]) => [...prev, v];
program
  .command("next")
  .description("Daftar task siap untuk repo ini (setara get_ready_tasks)")
  .option("-n, --limit <n>", "Jumlah maksimal", (v) => Number.parseInt(v, 10), 10)
  .option("--as <alias>", "Bekerja sebagai persona ini: hanya task miliknya (mis. adel)")
  .option("--lease <id>", "Perpanjang lease worktree yang aktif")
  .option("--json", "Keluaran JSON")
  .action((opts: { limit: number; as?: string; json?: boolean; lease?: string }) =>
    friendly(async () => taskNext(await cliService(), opts)),
  );

program
  .command("claim")
  .description("Kunci task dan cetak instruksi + handoff dependensinya (setara claim_task)")
  .argument("<task_id>")
  .option("--as <alias>", "Bekerja sebagai persona ini; task milik persona lain ditolak")
  .option("--worktree", "Reservasi branch checkout + lease sesi (wajib di proyek layout monorepo)")
  .option("--create-worktree", "Buat branch dan checkout baru, lalu claim dalam mode worktree")
  .option("--branch <branch>", "Branch baru untuk --create-worktree (default: catenext/<task_id>)")
  .option(
    "--path <path>",
    "Path checkout baru untuk --create-worktree (relatif terhadap root utama)",
  )
  .option("--base <branch>", "Base branch untuk --worktree atau --create-worktree")
  .option("--json", "Keluaran JSON")
  .action((taskId: string, opts: ClaimOptions) =>
    friendly(async () => {
      if (!opts.createWorktree) return taskClaim(await cliService(), taskId, opts);
      const root = await requireRoot(true);
      const config = await readConfig(root);
      return taskClaim(await cliService(root), taskId, { ...opts, project: { root, config } });
    }),
  );

const worktree = program
  .command("worktree")
  .description("Periksa dan bersihkan checkout kerja lokal");

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
        for (const path of result.skipped) console.error(`Tidak dihapus: ${JSON.stringify(path)}`);
      }
      if (result.skipped.length) process.exitCode = 1;
    }),
  );

program
  .command("done")
  .description("Selesaikan task dengan handoff terstruktur (setara complete_handoff)")
  .argument("<task_id>")
  .option("--notes <text>", "Ringkasan untuk agen berikutnya (maks. 500 karakter)")
  .option(
    "--decision <text>",
    "Keputusan penting (boleh diulang, maks. 5)",
    collect,
    [] as string[],
  )
  .option(
    "--file <path>",
    "File yang diubah (boleh diulang; default dari git)",
    collect,
    [] as string[],
  )
  .option("--verify <cmd>", "Perintah verifikasi, mis. pnpm test")
  .option("--pr <url>", "URL pull/merge request (opsional, harus bersama --base)")
  .option("--base <branch>", "Branch tujuan PR (opsional, harus bersama --pr)")
  .option("--lease <id>", "Lease worktree dari claim")
  .option("--handoff <file>", "File JSON handoff_summary lengkap, atau '-' untuk stdin")
  .option("--json", "Keluaran JSON")
  .action(
    (
      taskId: string,
      opts: {
        notes?: string;
        decision: string[];
        file: string[];
        verify?: string;
        handoff?: string;
        pr?: string;
        base?: string;
        lease?: string;
        json?: boolean;
      },
    ) => friendly(async () => taskDone(await cliService(), taskId, opts)),
  );

program
  .command("block")
  .description("Lepas lock dan tandai task BLOCKED (setara report_blocker)")
  .argument("<task_id>")
  .requiredOption("--category <category>", `Salah satu: ${BLOCKER_CATEGORIES.join(", ")}`)
  .requiredOption("--reason <text>", "Alasan spesifik (min. 10 karakter)")
  .option("--lease <id>", "Lease worktree dari claim")
  .option("--json", "Keluaran JSON")
  .action(
    (taskId: string, opts: { category: string; reason: string; json?: boolean; lease?: string }) =>
      friendly(async () => taskBlock(await cliService(), taskId, opts)),
  );

program
  .command("release")
  .description("Lepas task untuk sesi lain")
  .argument("<task_id>")
  .option("--lease <id>", "Lease worktree dari claim")
  .action((taskId: string, opts: { lease?: string }) =>
    friendly(async () => {
      const input = prepare(ReleaseTaskInput, { task_id: taskId, lease_id: opts.lease }, [
        "task_id",
        "lease_id",
      ]);
      const service = await cliService();
      console.log(JSON.stringify(await service.callTool("release_task", input), null, 2));
    }),
  );

program
  .command("revise")
  .description(
    "Orchestrator: kembalikan task NEEDS_REVIEW/DONE ke kolom Revisi (bukan task baru; setara manage_task)",
  )
  .argument("<task_id>")
  .requiredOption("--feedback <text>", "Apa yang harus diperbaiki (min. 5 karakter)")
  .option("--to <alias>", "Ganti persona penanggung jawab revisi")
  .option("--json", "Keluaran JSON")
  .action((taskId: string, opts: { feedback: string; to?: string; json?: boolean }) =>
    friendly(async () =>
      taskManage(
        await cliService(),
        {
          action: "request_revision",
          task_id: taskId,
          feedback: opts.feedback,
          ...(opts.to ? { agent_alias: opts.to } : {}),
        },
        Boolean(opts.json),
      ),
    ),
  );

program
  .command("assign")
  .description(
    "Orchestrator: tetapkan persona atau role penanggung jawab task (setara manage_task)",
  )
  .argument("<task_id>")
  .option("--to <alias>", "Persona penanggung jawab")
  .option("--role <role>", "Role task tanpa persona tertentu")
  .option("--unassign", "Lepas persona (task diambil berdasarkan role)")
  .option("--json", "Keluaran JSON")
  .action(
    (taskId: string, opts: { to?: string; role?: string; unassign?: boolean; json?: boolean }) =>
      friendly(async () =>
        taskManage(
          await cliService(),
          {
            action: "assign",
            task_id: taskId,
            ...(opts.unassign ? { agent_alias: null } : opts.to ? { agent_alias: opts.to } : {}),
            ...(opts.role ? { role: opts.role } : {}),
          },
          Boolean(opts.json),
        ),
      ),
  );

const review = program
  .command("review")
  .description("Antrean dan keputusan review PR lokal; tidak memeriksa status merge");
review
  .command("approve")
  .description(
    "Catat persetujuan akhir lokal (NEEDS_REVIEW menjadi DONE); tidak memverifikasi merge PR",
  )
  .argument("<task_id>")
  .option("--if-snapshot <sha256>", "Tolak bila snapshot dari catenext brief sudah berubah")
  .option("--json", "Keluaran JSON")
  .action((taskId: string, opts: { json?: boolean; ifSnapshot?: string }) =>
    friendly(async () =>
      taskManage(
        await cliService(),
        { action: "approve", task_id: taskId },
        Boolean(opts.json),
        opts.ifSnapshot,
      ),
    ),
  );
review
  .command("list")
  .option("-n, --limit <n>", "Jumlah maksimal", Number, 10)
  .option("--json")
  .action((opts: { limit: number; json?: boolean }) =>
    friendly(async () =>
      taskReview(await cliService(), { action: "list", limit: opts.limit }, Boolean(opts.json)),
    ),
  );
review
  .command("claim")
  .argument("<task_id>")
  .option("--as <alias>", "Persona reviewer")
  .option("--sha <sha>", "Pastikan head SHA handoff masih cocok")
  .option("--include-context", "Sertakan review_context_pack terikat batas byte")
  .option("--compact", "Ringkas konteks dan catatan review")
  .option("--json")
  .action(
    (
      taskId: string,
      opts: {
        as?: string;
        sha?: string;
        includeContext?: boolean;
        compact?: boolean;
        json?: boolean;
      },
    ) =>
      friendly(async () =>
        taskReview(
          await cliService(),
          {
            action: "claim",
            task_id: taskId,
            agent_alias: opts.as,
            ...(opts.sha !== undefined ? { head_sha: opts.sha } : {}),
            ...(opts.includeContext !== undefined ? { include_context: opts.includeContext } : {}),
            ...(opts.compact !== undefined ? { compact: opts.compact } : {}),
          },
          Boolean(opts.json),
        ),
      ),
  );
review
  .command("refresh")
  .description("Baca informasi PR yang tercatat lokal; tidak meminta status dari host Git")
  .argument("<task_id>")
  .option("--sha <sha>", "Pastikan head SHA handoff masih cocok")
  .option("--include-context", "Sertakan review_context_pack terikat batas byte")
  .option("--compact", "Ringkas konteks dan catatan review")
  .option("--json")
  .action(
    (
      taskId: string,
      opts: {
        sha?: string;
        includeContext?: boolean;
        compact?: boolean;
        json?: boolean;
      },
    ) =>
      friendly(async () =>
        taskReview(
          await cliService(),
          {
            action: "refresh",
            task_id: taskId,
            ...(opts.sha !== undefined ? { head_sha: opts.sha } : {}),
            ...(opts.includeContext !== undefined ? { include_context: opts.includeContext } : {}),
            ...(opts.compact !== undefined ? { compact: opts.compact } : {}),
          },
          Boolean(opts.json),
        ),
      ),
  );
review
  .command("submit")
  .description("Catat rekomendasi reviewer lokal atau minta revisi; bukan persetujuan akhir")
  .argument("<task_id>")
  .requiredOption("--lease <id>")
  .requiredOption("--sha <sha>")
  .requiredOption("--decision <approve|request_changes>")
  .requiredOption("--feedback <text>")
  .option("--json")
  .action(
    (
      taskId: string,
      opts: {
        lease: string;
        sha: string;
        decision: string;
        feedback: string;
        json?: boolean;
      },
    ) =>
      friendly(async () =>
        taskReview(
          await cliService(),
          {
            action: "submit",
            task_id: taskId,
            lease_id: opts.lease,
            head_sha: opts.sha,
            decision: opts.decision,
            feedback: opts.feedback,
          },
          Boolean(opts.json),
        ),
      ),
  );

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
  .option("--source <id>", "Pilih source_id spesifik bila ada kolisi nama skill", (val: string) => {
    const parsed = SkillSourceIdSchema.safeParse(val.trim());
    if (!parsed.success) {
      throw new InvalidArgumentError(`source_id tidak valid: ${JSON.stringify(val)}.`);
    }
    return parsed.data;
  })
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

function confirm(question: string): Promise<boolean> {
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
        for (const f of plan.findings) console.log(`${f.level === "ok" ? "•" : "!"} ${f.message}`);

        const skillCatalog = await discoverSkillCatalog(root, {
          platforms,
          includeUserGlobal: Boolean(opts.userSkills),
        });
        for (const line of formatSkillCatalogSummary(skillCatalog)) console.log(line);
        for (const l of summarize(plan.edits)) console.log(l);
        if (opts.dryRun) {
          console.log(`(dry-run) ${plan.edits.length} file akan berubah. Tidak ada yang ditulis.`);
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
          const { planEntryPointers } = await import("./agents/entry-pointers.js");
          const pointers = await planEntryPointers(root, platforms, { force: Boolean(opts.force) });
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
    const report = await runDoctor({ ...opts, version: VERSION });
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
  .option("--role <role>", `Filter tool MCP per peran (${MCP_ROLES.join(" | ")})`, (v: string) => {
    const parsed = McpRoleSchema.safeParse(v.trim());
    if (!parsed.success) {
      throw new InvalidArgumentError(
        `Role tidak valid: ${JSON.stringify(v)}. Pilih: ${MCP_ROLES.join(", ")}.`,
      );
    }
    return parsed.data;
  })
  .action((opts: { root?: string; role?: "orchestrator" | "worker"; allowCrud?: boolean }) =>
    runMcpServer({ root: opts.root, role: opts.role, allowCrud: opts.allowCrud, version: VERSION }),
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

const READ_ONLY_OR_DAEMON_TOP_COMMANDS = new Set(["doctor", "watch", "mcp", "config", "verify"]);

program.hook("postAction", async (_thisCommand, actionCommand) => {
  if (
    actionCommand.parent === program &&
    READ_ONLY_OR_DAEMON_TOP_COMMANDS.has(actionCommand.name())
  ) {
    return;
  }
  try {
    const root = await findProjectRoot(undefined, { managedWorktree: true });
    if (!root) return;
    const config = await readConfig(root);
    checkpointDatabaseFile(stateFilePath(root, config), { onlyIfSidecarExists: true });
  } catch {
    /* ignore shutdown checkpoint errors; never fail CLI exit */
  }
});

await program.parseAsync();
