import { BLOCKER_CATEGORIES, ReleaseTaskInput } from "@catenext/shared";
import type { Command } from "commander";
import { readConfig } from "../config.js";
import {
  type ClaimOptions,
  taskBlock,
  taskClaim,
  taskDone,
  taskManage,
  taskNext,
} from "../fallback.js";
import {
  cliService,
  prepare,
  requireRoot,
  taskCancel,
  taskCreate,
  taskDeps,
  taskUpdate,
} from "../planning.js";
import { collect, friendly } from "./shared.js";

/** Register `task` subcommands and `unblock`. */
export function registerTaskCommands(program: Command) {
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
}

/** Register `next` and `claim` fallback commands. */
export function registerNextClaimCommands(program: Command) {
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
    .option(
      "--worktree",
      "Reservasi branch checkout + lease sesi (wajib di proyek layout monorepo)",
    )
    .option("--create-worktree", "Buat branch dan checkout baru, lalu claim dalam mode worktree")
    .option(
      "--branch <branch>",
      "Branch baru untuk --create-worktree (default: catenext/<task_id>)",
    )
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
}

/** Register `done`, `block`, `release`, `revise`, and `assign` commands. */
export function registerHandoffCommands(program: Command) {
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
      (
        taskId: string,
        opts: { category: string; reason: string; json?: boolean; lease?: string },
      ) => friendly(async () => taskBlock(await cliService(), taskId, opts)),
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
}
