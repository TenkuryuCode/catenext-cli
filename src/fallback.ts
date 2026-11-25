import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  ClaimTaskInput,
  CompleteHandoffInput,
  HANDOFF_LIMITS,
  type HandoffSummary,
  ManageTaskInput,
  type McpToolOutput,
  ReportBlockerInput,
  ReviewInput,
} from "@catenext/shared";
import type { AgentApi } from "./api-client.js";
import { PlanningInputError, prepare, readJsonInput } from "./planning.js";

/**
 * Fallback CLI untuk agen tanpa MCP (blueprint §4.3): `catenext next/claim/done/block`.
 * Endpoint, sensor secret, dan validasi Zod sama persis dengan tool MCP.
 */

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface GitState {
  branch: string | null;
  commit: string | null;
  /** File yang berubah di commit terakhir + perubahan yang belum di-commit. */
  changedFiles: string[];
}

export async function readGitState(cwd: string = process.cwd()): Promise<GitState> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const commit = await git(["rev-parse", "HEAD"], cwd);
  const lastCommit = (await git(["show", "--name-only", "--format=", "HEAD"], cwd)) ?? "";
  const dirty = (await git(["diff", "--name-only", "HEAD"], cwd)) ?? "";
  const changedFiles = [
    ...new Set([...dirty.split("\n"), ...lastCommit.split("\n")].filter(Boolean)),
  ];
  return { branch, commit, changedFiles };
}

export async function taskNext(
  api: AgentApi,
  opts: { as?: string; limit?: number; json?: boolean; lease?: string },
) {
  const res = await api.post<McpToolOutput<"get_ready_tasks">>("ready-tasks", {
    limit: opts.limit ?? 10,
    ...(opts.lease ? { lease_id: opts.lease } : {}),
    ...(opts.as ? { agent_alias: opts.as } : {}),
  });
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  if (res.tasks.length === 0) {
    return console.log(
      "Tidak ada task siap untuk repo ini. Cek Dashboard untuk task DRAFT/BLOCKED.",
    );
  }
  for (const t of res.tasks) {
    const tags = [t.persona ? `@${t.persona}` : null, t.role, t.revision ? "revisi" : null]
      .filter(Boolean)
      .join(", ");
    console.log(`${t.id}  ${t.title}${tags ? `  [${tags}]` : ""}`);
  }
  console.log(
    `\nAmbil satu: catenext claim ${res.tasks[0]?.id}${opts.as ? ` --as ${opts.as}` : ""} [--worktree]`,
  );
  console.log("  (Monorepo: --worktree wajib. Polyrepo: opsional.)");
}

export function renderClaim(res: McpToolOutput<"claim_task">): string {
  const out: string[] = [];
  out.push(`# Task: ${res.task.title}`, "");
  out.push(`- ID: ${res.task.id}`);
  out.push(`- Lease sampai: ${res.lease_expires_at} (diperpanjang setiap perintah catenext)`);
  if (res.lease_id)
    out.push(`- Gunakan --lease ${res.lease_id} saat memperbarui atau menyerahkan task.`);
  if (res.task.role) out.push(`- Role: ${res.task.role}`);
  if (res.task.revision_count > 0) out.push(`- Revisi ke-${res.task.revision_count}`);
  out.push("", "## Instruksi", "", res.task.prompt_instruction.trim(), "");
  if (res.persona) {
    out.push(`## Persona: ${res.persona.alias} (${res.persona.role})`, "");
    out.push("Patuhi aturan dan batas wilayah berikut:", "");
    for (const r of res.persona.rules) out.push(`- ${r}`);
    out.push("");
  }
  if (res.revision) {
    out.push("## Feedback revisi dari reviewer", "", res.revision.review_feedback.trim(), "");
  }
  if (res.dependencies.length > 0) {
    out.push("## Handoff dari task dependensi", "");
    for (const d of res.dependencies) {
      const h = d.handoff_summary;
      out.push(`### ${d.title}`, "");
      out.push(`- Branch/commit: ${h.git_branch} @ ${h.last_commit_hash}`);
      if (d.integrated_commit) {
        out.push(`- Terintegrasi: ${d.integrated_commit.branch} @ ${d.integrated_commit.sha}`);
      }
      if (h.files_modified.length) out.push(`- File: ${h.files_modified.join(", ")}`);
      for (const k of h.key_decisions) out.push(`- Keputusan: ${k}`);
      if (h.verification_command) out.push(`- Verifikasi: \`${h.verification_command}\``);
      out.push(`- Catatan: ${h.notes_for_next_agent}`, "");
    }
  }
  for (const w of res.warnings) out.push(`! ${w}`);
  out.push(
    "## Setelah selesai",
    "",
    "Commit di branch/worktree ini OK. Jangan merge ke default branch — serahkan lewat PR.",
    `catenext done ${res.task.id} --notes "<ringkasan>" --verify "<perintah tes>" --pr <url> --base <branch>${res.lease_id ? ` --lease ${res.lease_id}` : ""}`,
    `Bila buntu: catenext block ${res.task.id} --category <kategori> --reason "<alasan spesifik>"`,
  );
  return out.join("\n");
}

export async function taskClaim(
  api: AgentApi,
  taskId: string,
  opts: { as?: string; json?: boolean; worktree?: boolean },
) {
  if (!opts.worktree) {
    const ctx = await api.post<McpToolOutput<"get_project_context">>("context", {
      ...(opts.as ? { agent_alias: opts.as } : {}),
    });
    if (ctx.project.layout === "monorepo") {
      throw new PlanningInputError(
        "Proyek ini layout monorepo: claim wajib --worktree (branch/sesi terpisah). Contoh: catenext claim <id> --worktree",
      );
    }
  }
  const branch = opts.worktree
    ? await git(["symbolic-ref", "--short", "HEAD"], process.cwd())
    : null;
  if (opts.worktree && !branch)
    throw new PlanningInputError("Checkout branch kerja sebelum memakai --worktree.");
  const payload = prepare(
    ClaimTaskInput,
    {
      task_id: taskId,
      ...(opts.as ? { agent_alias: opts.as } : {}),
      ...(branch ? { worktree: { branch, session_id: randomUUID() } } : {}),
    },
    ["task_id", "session_id"],
  );
  const res = await api.post<McpToolOutput<"claim_task">>("claim", payload);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(renderClaim(res));
}

export interface DoneOptions {
  notes?: string;
  decision: string[];
  file: string[];
  verify?: string;
  pr?: string;
  base?: string;
  lease?: string;
  /** File JSON berisi handoff_summary lengkap, atau '-' untuk stdin. */
  handoff?: string;
  json?: boolean;
}

/** Susun handoff dari flag + git lokal. Flag eksplisit selalu menang atas deteksi git. */
export function buildHandoff(opts: DoneOptions, gitState: GitState): Partial<HandoffSummary> {
  if (!opts.notes) {
    throw new PlanningInputError(
      "--notes wajib: tulis ringkasan untuk agen berikutnya (atau pakai --handoff <file.json>).",
    );
  }
  if (!gitState.branch || !gitState.commit) {
    throw new PlanningInputError(
      "Tidak bisa membaca branch/commit git. Jalankan di dalam repo git dan commit pekerjaan Anda dulu.",
    );
  }
  if (!opts.pr || !opts.base) {
    throw new PlanningInputError(
      "--pr dan --base wajib: buat PR di branch kerja lalu `catenext done … --pr <url> --base <branch>`.",
    );
  }
  const files = opts.file.length ? opts.file : gitState.changedFiles;
  return {
    files_modified: files.slice(0, HANDOFF_LIMITS.maxFilesModified),
    key_decisions: opts.decision,
    verification_command: opts.verify ?? null,
    notes_for_next_agent: opts.notes,
    git_branch: gitState.branch,
    last_commit_hash: gitState.commit,
    pull_request: { url: opts.pr, base_branch: opts.base, head_sha: gitState.commit },
  };
}

export async function taskDone(api: AgentApi, taskId: string, opts: DoneOptions) {
  const summary = opts.handoff
    ? await readJsonInput(opts.handoff)
    : buildHandoff(opts, await readGitState());
  const body = prepare(
    CompleteHandoffInput,
    { task_id: taskId, handoff_summary: summary, lease_id: opts.lease },
    ["task_id", "last_commit_hash", "head_sha", "lease_id"],
  );
  const res = await api.post<McpToolOutput<"complete_handoff">>("complete", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log("✓ Handoff + PR terkirim (NEEDS_REVIEW). Menunggu review/merge manusia.");
  console.log(`  ${res.next_step_hint}`);
}

export async function taskBlock(
  api: AgentApi,
  taskId: string,
  opts: { category: string; reason: string; json?: boolean; lease?: string },
) {
  const body = prepare(
    ReportBlockerInput,
    { task_id: taskId, category: opts.category, reason: opts.reason, lease_id: opts.lease },
    ["task_id", "category", "lease_id"],
  );
  const res = await api.post<McpToolOutput<"report_blocker">>("blocker", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log("✓ Task ditandai BLOCKED dan lock dilepas. Manusia akan meninjau di Dashboard.");
}

export async function taskReview(api: AgentApi, input: unknown, json: boolean) {
  const body = prepare(ReviewInput, input, ["task_id", "lease_id", "head_sha"]);
  const result = await api.post<McpToolOutput<"review_pull_request">>(
    body.action === "list" ? "review/list" : "review",
    body,
  );
  if (json) console.log(JSON.stringify(result, null, 2));
  else if ("reviews" in result) {
    if (!result.reviews.length) console.log("Belum ada PR yang bisa Anda review di repo ini.");
    for (const item of result.reviews)
      console.log(`${item.task_id}  ${item.title}  ${item.review.url}`);
  } else {
    console.log(`${result.title}  ${result.status} · ${result.review.stage}`);
    console.log(`${result.review.url} @ ${result.review.head_sha}`);
    if (result.lease_id)
      console.log(`Lease review: ${result.lease_id} (sampai ${result.lease_expires_at})`);
    if (result.notes_for_next_agent) console.log(result.notes_for_next_agent);
    if (result.warning) console.error(result.warning);
  }
  if ("warning" in result && result.warning) process.exitCode = 1;
}

/** Orchestrator: kembalikan task ke kolom Revisi atau tetapkan persona/role (manage_task). */
export async function taskManage(api: AgentApi, input: unknown, json: boolean) {
  const body = prepare(ManageTaskInput, input, ["action", "task_id", "agent_alias", "role"]);
  const res = await api.post<McpToolOutput<"manage_task">>("tasks/manage", body);
  if (json) return console.log(JSON.stringify(res, null, 2));
  const owner = res.persona ? `@${res.persona}` : res.role ? `role ${res.role}` : "tanpa persona";
  if (body.action === "request_revision") {
    console.log(
      `✓ Task dipindah ke kolom Revisi (revisi ke-${res.revision_count}) untuk ${owner}.`,
    );
    console.log(
      res.persona
        ? `  Delegasikan ke subagent ${res.persona}; ia akan mengambilnya lewat claim_task.`
        : "  Subagent dengan role yang cocok dapat mengambilnya lewat claim_task.",
    );
    if (res.stale_task_ids.length > 0)
      console.log(`  ${res.stale_task_ids.length} task hilir ditandai stale.`);
  } else {
    console.log(`✓ Penanggung jawab task: ${owner} (status ${res.status}).`);
  }
}
