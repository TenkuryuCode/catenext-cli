#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  BLOCKER_CATEGORIES,
  DOCUMENT_KINDS,
  type McpToolOutput,
  ReleaseTaskInput,
} from "@catenext/shared";
import { Command } from "commander";
import { ApiRequestError } from "./api-client.js";
import { ConfigError, findProjectRoot, readConfig } from "./config.js";
import {
  CredentialsError,
  DEFAULT_API_URL,
  loadCredentials,
  resolveApiUrl,
  saveCredentials,
  validateApiKey,
} from "./credentials.js";
import { deviceLogin } from "./device-login.js";
import { taskBlock, taskClaim, taskDone, taskManage, taskNext, taskReview } from "./fallback.js";
import { applyInit, planInit, renderDiff } from "./init/index.js";
import { McpConfigError } from "./init/mcp-config.js";
import { applyFileEdits, planRemove, planSync, summarize, syncSkills } from "./maintenance.js";
import { runMcpServer } from "./mcp/run.js";
import { hasVersionedSegment, npxLaunch, stableNodeCommand } from "./node-command.js";
import {
  boardShow,
  cliApi,
  docGet,
  docList,
  docSave,
  epicCreate,
  epicList,
  PlanningInputError,
  personaList,
  personaSet,
  prepare,
  taskCreate,
} from "./planning.js";
import { loadSkill, SkillError } from "./skills.js";
import { planSubagents, SUBAGENTS_DIR } from "./subagents.js";
import { formatChecks, verifySetup } from "./verify.js";

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
      err instanceof CredentialsError ||
      err instanceof McpConfigError ||
      err instanceof SkillError ||
      err instanceof PlanningInputError
    ) {
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof ApiRequestError) {
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
  const viaNpx = npxLaunch(entry);
  if (viaNpx) return viaNpx;
  if (!existsSync(entry)) {
    console.error(
      `! ${entry} belum ada. Jalankan \`pnpm --filter catenext build\` agar IDE bisa menjalankan server MCP.`,
    );
  }
  const command = stableNodeCommand(process.execPath, process.env.PATH);
  if (command !== "node" && hasVersionedSegment(command)) {
    console.error(
      `! Entri MCP memakai ${command}, path berversi yang akan rusak saat Node di-update. ` +
        "Tambahkan node ke PATH lalu jalankan ulang, atau pakai --mcp-command.",
    );
  }
  return { command, args: [entry] };
}

function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((res, rej) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => {
        data += c;
      });
      process.stdin.on("end", () => res(data));
      process.stdin.on("error", rej);
    });
  }
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    process.stderr.write(prompt);
    // Jangan gemakan API key ke layar.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      res(answer);
    });
  });
}

program
  .command("login")
  .description("Login lewat browser dan simpan API key baru (atau tempel key dengan --with-key)")
  .option("--api-url <url>", "URL Catenext API, mis. https://catenext.mapan.digital")
  .option("--with-key", "Tempel API key dari Dashboard alih-alih login lewat browser")
  .option("--no-browser", "Jangan buka browser otomatis (mis. lewat SSH); tampilkan tautan saja")
  .action((opts: { apiUrl?: string; withKey?: boolean; browser: boolean }) =>
    friendly(async () => {
      let explicitUrl: string | undefined;
      if (opts.apiUrl) {
        try {
          explicitUrl = new URL(opts.apiUrl).toString().replace(/\/+$/, "");
        } catch {
          throw new CredentialsError("--api-url bukan URL yang valid.");
        }
      }
      const root = await findProjectRoot();
      const config = root ? await readConfig(root).catch(() => null) : null;
      const previous = await loadCredentials().catch(() => null);
      const apiUrl = explicitUrl ?? resolveApiUrl(config?.api_url, previous?.api_url);

      // Tempel key: diminta eksplisit, atau stdin bukan terminal (mis. echo "$KEY" | catenext login).
      const key =
        opts.withKey || !process.stdin.isTTY
          ? validateApiKey(
              await readSecret("Tempel API key (ctnx_...) dari Dashboard > Keamanan & Akses: "),
            )
          : validateApiKey(await deviceLogin({ apiUrl, browser: opts.browser }));

      // Simpan api_url hanya bila bukan default bawaan, agar default rilis berikutnya tetap berlaku.
      const path = await saveCredentials({
        api_key: key,
        ...(apiUrl !== DEFAULT_API_URL ? { api_url: apiUrl } : {}),
      });
      console.log(
        `✓ Login berhasil. API key tersimpan di ${path} (izin 0600, di luar folder proyek).`,
      );
      if (root) console.log(formatChecks(await verifySetup(root, await readConfig(root))));
    }),
  );

program
  .command("init")
  .description("Tulis .catenext/config.yaml dan pasang entri MCP untuk Claude Code & Cursor")
  .option("--project <id>", "project_id dari Dashboard (wajib saat pertama kali)")
  .option("--repo <name>", "repo_name untuk repo ini (default: nama folder)")
  .option("--api-url <url>", "Simpan api_url di config (opsional)")
  .option("--mcp-command <cmd>", 'Perintah untuk menjalankan CLI ini, mis. "catenext"')
  .option("--no-agents-md", "Jangan tulis blok Catenext di AGENTS.md")
  .option("--dry-run", "Tampilkan diff tanpa menulis ke disk")
  .action(
    (opts: {
      project?: string;
      repo?: string;
      apiUrl?: string;
      mcpCommand?: string;
      agentsMd?: boolean;
      dryRun?: boolean;
    }) =>
      friendly(async () => {
        const root = process.cwd();
        const custom = opts.mcpCommand?.trim().split(/\s+/).filter(Boolean);
        const mcpCommand = custom?.[0]
          ? { command: custom[0], args: custom.slice(1) }
          : defaultMcpCommand();
        const changes = await planInit({
          root,
          projectId: opts.project,
          repoName: opts.repo,
          apiUrl: opts.apiUrl,
          mcpCommand,
          agentsMd: opts.agentsMd,
        });

        if (changes.length === 0) {
          console.log("✓ Tidak ada perubahan: Catenext sudah terpasang di repo ini.");
        } else if (opts.dryRun) {
          console.log(renderDiff(changes));
          console.log(`(dry-run) ${changes.length} file akan berubah. Tidak ada yang ditulis.`);
          return;
        } else {
          await applyInit(root, changes);
          for (const c of changes)
            console.log(`${c.before === null ? "+ dibuat " : "~ diubah "} ${c.path}`);
        }
        if (opts.dryRun) return;

        console.log("");
        console.log(formatChecks(await verifySetup(root, await readConfig(root))));
        console.log(
          `\nMulai ulang Claude Code / Cursor agar server MCP "catenext" terbaca. Log server: stderr \`catenext mcp\`.`,
        );
      }),
  );

// --- Perencanaan tanpa Web UI (memakai endpoint yang sama dengan tool MCP) ---

const epic = program.command("epic").description("Kelola epic proyek ini dari terminal");
epic
  .command("list")
  .description("Daftar epic beserta jumlah task per status")
  .option("--json", "Keluaran JSON")
  .action((opts: { json?: boolean }) =>
    friendly(async () => epicList(await cliApi(), Boolean(opts.json))),
  );
epic
  .command("create")
  .description("Buat epic baru")
  .argument("<title>", 'Judul epic, mis. "Fitur login"')
  .option("-d, --description <text>", "Deskripsi / kriteria selesai")
  .option("--json", "Keluaran JSON")
  .action((title: string, opts: { description?: string; json?: boolean }) =>
    friendly(async () => epicCreate(await cliApi(), title, opts.description, Boolean(opts.json))),
  );

const task = program.command("task").description("Ajukan rencana task (masuk DRAFT)");
task
  .command("create")
  .description(
    "Ajukan task berdependensi dari file JSON (array task atau { tasks: [...] }); pakai '-' untuk stdin",
  )
  .requiredOption("--epic <id>", "epic_id tujuan (lihat `catenext epic list`)")
  .requiredOption("-f, --file <path>", "File rencana JSON, atau '-' untuk stdin")
  .option("--json", "Keluaran JSON")
  .action((opts: { epic: string; file: string; json?: boolean }) =>
    friendly(async () => taskCreate(await cliApi(), opts.epic, opts.file, Boolean(opts.json))),
  );

const persona = program.command("persona").description("Kelola persona agen untuk proyek ini");
persona
  .command("list")
  .description("Daftar persona (alias, role, aturan) yang berlaku di proyek ini")
  .option("--json", "Keluaran JSON")
  .action((opts: { json?: boolean }) =>
    friendly(async () => personaList(await cliApi(), Boolean(opts.json))),
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
  .action(
    (alias: string, opts: { role: string; rule: string[]; repo?: string[]; json?: boolean }) =>
      friendly(async () =>
        personaSet(await cliApi(), alias, opts.role, opts.rule, Boolean(opts.json), opts.repo),
      ),
  );

program
  .command("board")
  .description("Orchestrator: papan proyek lintas repo (task, status, persona, repo)")
  .option("--epic <id>", "Batasi ke satu epic")
  .option(
    "--status <status>",
    "Filter status (boleh diulang)",
    (v: string, p: string[]) => [...p, v],
    [] as string[],
  )
  .option("--json", "Keluaran JSON")
  .action((opts: { epic?: string; status: string[]; json?: boolean }) =>
    friendly(async () => boardShow(await cliApi(), opts)),
  );

const doc = program
  .command("doc")
  .description("Dokumen proyek di Cloud (blueprint, ERD, arsitektur, keputusan)");
doc
  .command("list")
  .option("--json", "Keluaran JSON")
  .action((opts: { json?: boolean }) =>
    friendly(async () => docList(await cliApi(), Boolean(opts.json))),
  );
doc
  .command("get")
  .argument("<slug>")
  .option("--json", "Keluaran JSON")
  .action((slug: string, opts: { json?: boolean }) =>
    friendly(async () => docGet(await cliApi(), slug, Boolean(opts.json))),
  );
doc
  .command("save")
  .argument("<slug>", "Slug dokumen, mis. blueprint atau erd")
  .requiredOption("--file <path>", "File Markdown berisi dokumen")
  .option("--title <text>", "Judul dokumen (default: slug)")
  .option("--kind <kind>", `Salah satu: ${DOCUMENT_KINDS.join(", ")}`, "other")
  .option("--version <n>", "Versi yang Anda baca (0 = dokumen baru); mencegah menimpa sesi lain")
  .option("--json", "Keluaran JSON")
  .action(
    (
      slug: string,
      opts: { file: string; title?: string; kind: string; version?: string; json?: boolean },
    ) => friendly(async () => docSave(await cliApi(), slug, opts)),
  );

// --- Fallback untuk agen tanpa MCP (blok AGENTS.md menunjuk ke sini) ---------

const collect = (v: string, prev: string[]) => [...prev, v];
const AGENT_OPT = [
  "--agent <name>",
  "Nama agen untuk log aktivitas, mis. codex",
  "catenext-cli",
] as const;

program
  .command("next")
  .description("Daftar task siap untuk repo ini (setara get_ready_tasks)")
  .option("-n, --limit <n>", "Jumlah maksimal", (v) => Number.parseInt(v, 10), 10)
  .option("--as <alias>", "Bekerja sebagai persona ini: hanya task miliknya (mis. adel)")
  .option("--lease <id>", "Perpanjang lease worktree yang aktif")
  .option(...AGENT_OPT)
  .option("--json", "Keluaran JSON")
  .action((opts: { limit: number; as?: string; agent: string; json?: boolean; lease?: string }) =>
    friendly(async () => taskNext(await cliApi(opts.agent), opts)),
  );

program
  .command("claim")
  .description("Kunci task dan cetak instruksi + handoff dependensinya (setara claim_task)")
  .argument("<task_id>")
  .option("--as <alias>", "Bekerja sebagai persona ini; task milik persona lain ditolak")
  .option("--worktree", "Reservasi branch checkout dan ambil lease sesi terpisah")
  .option(...AGENT_OPT)
  .option("--json", "Keluaran JSON")
  .action(
    (taskId: string, opts: { as?: string; agent: string; json?: boolean; worktree?: boolean }) =>
      friendly(async () => taskClaim(await cliApi(opts.agent), taskId, opts)),
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
  .option("--pr <url>", "URL pull request GitHub")
  .option("--base <branch>", "Branch tujuan PR")
  .option("--lease <id>", "Lease worktree dari claim")
  .option("--handoff <file>", "File JSON handoff_summary lengkap, atau '-' untuk stdin")
  .option(...AGENT_OPT)
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
        agent: string;
        json?: boolean;
      },
    ) => friendly(async () => taskDone(await cliApi(opts.agent), taskId, opts)),
  );

program
  .command("block")
  .description("Lepas lock dan tandai task BLOCKED (setara report_blocker)")
  .argument("<task_id>")
  .requiredOption("--category <category>", `Salah satu: ${BLOCKER_CATEGORIES.join(", ")}`)
  .requiredOption("--reason <text>", "Alasan spesifik (min. 10 karakter)")
  .option("--lease <id>", "Lease worktree dari claim")
  .option(...AGENT_OPT)
  .option("--json", "Keluaran JSON")
  .action(
    (
      taskId: string,
      opts: { category: string; reason: string; agent: string; json?: boolean; lease?: string },
    ) => friendly(async () => taskBlock(await cliApi(opts.agent), taskId, opts)),
  );

program
  .command("release")
  .description("Lepas task untuk sesi lain")
  .argument("<task_id>")
  .option("--lease <id>", "Lease worktree dari claim")
  .option(...AGENT_OPT)
  .action((taskId: string, opts: { agent: string; lease?: string }) =>
    friendly(async () => {
      const input = prepare(ReleaseTaskInput, { task_id: taskId, lease_id: opts.lease }, [
        "task_id",
        "lease_id",
      ]);
      const api = await cliApi(opts.agent);
      console.log(JSON.stringify(await api.post("release", input), null, 2));
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
  .option(...AGENT_OPT)
  .option("--json", "Keluaran JSON")
  .action(
    (taskId: string, opts: { feedback: string; to?: string; agent: string; json?: boolean }) =>
      friendly(async () =>
        taskManage(
          await cliApi(opts.agent),
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
  .option(...AGENT_OPT)
  .option("--json", "Keluaran JSON")
  .action(
    (
      taskId: string,
      opts: { to?: string; role?: string; unassign?: boolean; agent: string; json?: boolean },
    ) =>
      friendly(async () =>
        taskManage(
          await cliApi(opts.agent),
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

const review = program.command("review").description("Antrean dan keputusan review pull request");
review
  .command("list")
  .option("-n, --limit <n>", "Jumlah maksimal", Number, 10)
  .option(...AGENT_OPT)
  .option("--json")
  .action((opts: { limit: number; agent: string; json?: boolean }) =>
    friendly(async () =>
      taskReview(
        await cliApi(opts.agent),
        { action: "list", limit: opts.limit },
        Boolean(opts.json),
      ),
    ),
  );
review
  .command("claim")
  .argument("<task_id>")
  .option("--as <alias>", "Persona reviewer")
  .option(...AGENT_OPT)
  .option("--json")
  .action((taskId: string, opts: { as?: string; agent: string; json?: boolean }) =>
    friendly(async () =>
      taskReview(
        await cliApi(opts.agent),
        { action: "claim", task_id: taskId, agent_alias: opts.as },
        Boolean(opts.json),
      ),
    ),
  );
review
  .command("refresh")
  .argument("<task_id>")
  .option(...AGENT_OPT)
  .option("--json")
  .action((taskId: string, opts: { agent: string; json?: boolean }) =>
    friendly(async () =>
      taskReview(
        await cliApi(opts.agent),
        { action: "refresh", task_id: taskId },
        Boolean(opts.json),
      ),
    ),
  );
review
  .command("submit")
  .argument("<task_id>")
  .requiredOption("--lease <id>")
  .requiredOption("--sha <sha>")
  .requiredOption("--decision <approve|request_changes>")
  .requiredOption("--feedback <text>")
  .option(...AGENT_OPT)
  .option("--json")
  .action(
    (
      taskId: string,
      opts: {
        lease: string;
        sha: string;
        decision: string;
        feedback: string;
        agent: string;
        json?: boolean;
      },
    ) =>
      friendly(async () =>
        taskReview(
          await cliApi(opts.agent),
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

program
  .command("skill")
  .description("Baca skill repo dari checkout atau revisi Git")
  .command("load")
  .argument("<name>")
  .option("--revision <sha>", "SHA commit Git untuk paritas lintas perangkat")
  .option("--json")
  .action((name: string, opts: { revision?: string; json?: boolean }) =>
    friendly(async () => {
      const skill = await loadSkill(await requireRoot(), name, opts.revision);
      console.log(
        opts.json ? JSON.stringify({ ...skill, revision: opts.revision }, null, 2) : skill.content,
      );
    }),
  );

/** Root repo (berisi .catenext/config.yaml) atau error yang ramah manusia. */
async function requireRoot(): Promise<string> {
  const root = await findProjectRoot();
  if (!root) {
    throw new ConfigError(
      "Tidak ada .catenext/config.yaml di folder ini atau induknya. Jalankan `catenext init --project <project_id>` dulu.",
    );
  }
  return root;
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) =>
    rl.question(question, (a) => {
      rl.close();
      res(/^(y|ya|yes)$/i.test(a.trim()));
    }),
  );
}

program
  .command("sync")
  .description("Selaraskan entri MCP, .gitignore, blok AGENTS.md, dan indeks skill dengan Cloud")
  .option("--dry-run", "Tampilkan perubahan tanpa menulis atau mengirim apa pun")
  .option("--fix", "Perbaiki entri MCP yang duplikat, basi (path hilang), atau file yang rusak")
  .action((opts: { dryRun?: boolean; fix?: boolean }) =>
    friendly(async () => {
      const root = await requireRoot();
      const config = await readConfig(root);
      const plan = await planSync({
        root,
        fix: Boolean(opts.fix),
        defaultCommand: defaultMcpCommand,
      });
      for (const f of plan.findings) console.log(`${f.level === "ok" ? "•" : "!"} ${f.message}`);
      if (opts.dryRun) {
        for (const l of summarize(plan.edits)) console.log(l);
        const { count, invalid, skipped } = await syncSkills(root, null);
        console.log(
          `(dry-run) ${plan.edits.length} file akan berubah; ${skipped ? "indeks skill tidak akan diubah." : `indeks ${count} skill akan dikirim.`}`,
        );
        for (const i of invalid) console.log(`! Skill dilewati: ${i.error}`);
        return;
      }
      await applyFileEdits(root, plan.edits);
      for (const l of summarize(plan.edits)) console.log(l);
      const fixable = plan.findings.some((f) => f.level === "fixable");
      if (plan.edits.length === 0 && !fixable) console.log("✓ File lokal sudah selaras.");

      try {
        const api = await cliApi();
        const { count, invalid, skipped } = await syncSkills(root, api);
        console.log(
          skipped
            ? "• Indeks Cloud mengikuti branch utama origin. Sinkronkan dari checkout branch itu setelah fetch."
            : `✓ Indeks ${count} skill tersinkron ke Cloud (isi skill tetap di Git).`,
        );
        for (const i of invalid) console.log(`! Skill dilewati: ${i.error}`);
        const { personas } = await api.post<McpToolOutput<"list_personas">>("personas/list");
        const sub = await planSubagents(root, personas);
        await applyFileEdits(root, sub.edits);
        for (const l of summarize(sub.edits)) console.log(l);
        for (const s of sub.skipped)
          console.log(`! ${s} sudah ada dan bukan buatan Catenext; tidak ditimpa.`);
        console.log(
          `✓ ${personas.length} persona tersedia sebagai subagent Claude Code di ${SUBAGENTS_DIR}/.`,
        );
      } catch (err) {
        if (!(err instanceof CredentialsError || err instanceof ApiRequestError)) throw err;
        console.log(`! Skill/persona belum tersinkron: ${err.message}`);
      }
      console.log("");
      console.log(formatChecks(await verifySetup(root, config)));
      if (fixable) process.exitCode = 1;
    }),
  );

program
  .command("remove")
  .description("Hapus Catenext dari repo ini secara bersih (entri MCP, config, blok AGENTS.md)")
  .option("--all", "Hapus juga skill repo di .catenext/skills/")
  .option("--dry-run", "Tampilkan yang akan dihapus tanpa menulis")
  .option("-y, --yes", "Jangan minta konfirmasi")
  .action((opts: { all?: boolean; dryRun?: boolean; yes?: boolean }) =>
    friendly(async () => {
      const root = (await findProjectRoot()) ?? process.cwd();
      const edits = await planRemove({ root, all: Boolean(opts.all) });
      if (edits.length === 0) {
        console.log("✓ Tidak ada jejak Catenext di repo ini.");
        return;
      }
      for (const l of summarize(edits)) console.log(l);
      if (!opts.all)
        console.log("  (skill di .catenext/skills/ disimpan; tambah --all untuk ikut menghapus)");
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
        "✓ Catenext dihapus dari repo ini. Kredensial global (~/.catenext) tidak disentuh.",
      );
      console.log("  Mulai ulang Claude Code / Cursor agar server MCP berhenti dimuat.");
    }),
  );

program
  .command("mcp")
  .description("Jalankan server MCP lokal (stdio)")
  .option("--root <path>", "Root repo (default: cari .catenext/config.yaml dari folder saat ini)")
  .action((opts: { root?: string }) => runMcpServer({ root: opts.root, version: VERSION }));

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

await program.parseAsync();
