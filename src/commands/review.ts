import { type Command, Option } from "commander";
import { taskManage, taskReview } from "../fallback.js";
import { cliService } from "../planning.js";
import { friendly } from "./shared.js";

/** Register `review` subcommands. */
export function registerReviewCommands(program: Command) {
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
              ...(opts.includeContext !== undefined
                ? { include_context: opts.includeContext }
                : {}),
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
              ...(opts.includeContext !== undefined
                ? { include_context: opts.includeContext }
                : {}),
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
    .addOption(
      new Option("--decision <approve|request_changes>")
        .choices(["approve", "request_changes"])
        .makeOptionMandatory(),
    )
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
}
