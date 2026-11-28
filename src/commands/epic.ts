import type { Command } from "commander";
import { LocalServiceError } from "../local-service.js";
import {
  cliService,
  epicArchive,
  epicCreate,
  epicList,
  epicRestore,
  epicSummary,
  epicTemplates,
  epicUpdate,
} from "../planning.js";
import { confirm, friendly } from "./shared.js";

/** Register `epic` and its `run` subcommands. */
export function registerEpicCommands(program: Command) {
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
      (
        id: string,
        opts: { head: string; path: string; attempt: string; result: "pass" | "fail" },
      ) =>
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
}
