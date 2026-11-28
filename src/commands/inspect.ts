import { type Command, InvalidArgumentError } from "commander";
import { readConfig } from "../config.js";
import { type TaskLogOptions, taskLog } from "../fallback.js";
import { boardShow, cliService, requireRoot } from "../planning.js";
import { runWatch } from "../watch.js";
import { friendly } from "./shared.js";

/** Register `board`, `log`, `brief`, and `watch` commands. */
export function registerInspectCommands(program: Command) {
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
        console.log(
          `ready=${res.ready_count} blocked=${res.blocked_count} draft=${res.draft_count}`,
        );
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
}
