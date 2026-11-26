import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  briefText,
  ClaimTaskInput,
  CompleteHandoffInput,
  GetReadyTasksInput,
  HANDOFF_LIMITS,
  type HandoffSummary,
  IdSchema,
  ManageTaskInput,
  type McpToolOutput,
  ReportBlockerInput,
  ReviewInput,
} from "@catenext/shared";
import { z } from "zod";
import { isMissingFile } from "./config.js";
import type { LocalService } from "./local-service.js";
import { type LocalPermission, PERMISSION_ACTIONS } from "./local-state.js";
import { PlanningInputError, prepare, readJsonInput } from "./planning.js";

/**
 * Fallback CLI untuk agen tanpa MCP (blueprint §4.3): `catenext next/claim/done/block`.
 * State lokal, sensor secret, dan validasi Zod sama seperti tool MCP.
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

async function gitRaw(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout.replace(/[\r\n]+$/, "");
  } catch {
    return null;
  }
}

function parsePorcelainPaths(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length >= 4)
    .map((line) => {
      const entry = line.slice(3).trim();
      const renamed = entry.includes(" -> ") ? (entry.split(" -> ").pop() ?? entry) : entry;
      return renamed.replace(/^"(.*)"$/, "$1");
    })
    .filter(Boolean);
}

export async function readOrCreateCliSessionId(root: string = process.cwd()): Promise<string> {
  const file = join(root, ".catenext", "cache", "cli-session-id");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (IdSchema.safeParse(existing).success) return existing;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const id = randomUUID();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${id}\n`, "utf8");
  return id;
}

async function detectBaseBranch(cwd: string, currentBranch: string): Promise<string | undefined> {
  const originHead = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (originHead) {
    const base = originHead.replace(/^origin\//, "");
    if (base && base !== currentBranch) return base;
  }
  for (const candidate of ["main", "master"]) {
    const exists = await git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], cwd);
    if (exists !== null && candidate !== currentBranch) return candidate;
  }
  return undefined;
}

export interface GitState {
  branch: string | null;
  commit: string | null;
  /** File yang berubah di commit terakhir + perubahan yang belum di-commit. */
  changedFiles: string[];
  /** Perubahan belum di-commit dari `git status --porcelain` atau diff vs `HEAD`. */
  dirtyFiles?: string[];
}

export async function readGitState(cwd: string = process.cwd()): Promise<GitState> {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const commit = await git(["rev-parse", "HEAD"], cwd);
  const lastCommit = (await git(["show", "--name-only", "--format=", "HEAD"], cwd)) ?? "";
  const dirty = (await git(["diff", "--name-only", "HEAD"], cwd)) ?? "";
  const porcelain = (await gitRaw(["status", "--porcelain"], cwd)) ?? "";
  const dirtyFiles = [
    ...new Set([...dirty.split("\n").filter(Boolean), ...parsePorcelainPaths(porcelain)]),
  ];
  const changedFiles = [
    ...new Set([...dirty.split("\n"), ...lastCommit.split("\n")].filter(Boolean)),
  ];
  return { branch, commit, changedFiles, ...(dirtyFiles.length ? { dirtyFiles } : {}) };
}

export async function taskNext(
  service: LocalService,
  opts: { as?: string; limit?: number; json?: boolean; lease?: string },
) {
  const body = prepare(
    GetReadyTasksInput,
    { limit: opts.limit, lease_id: opts.lease, agent_alias: opts.as },
    ["limit", "lease_id", "agent_alias"],
  );
  const res = await service.callTool("get_ready_tasks", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  if (res.tasks.length === 0) {
    return console.log(
      "Tidak ada task siap untuk repo ini. Cek `catenext board` untuk task DRAFT/BLOCKED.",
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
  out.push(
    `- Lease sampai: ${res.lease_expires_at} (perpanjang lewat catenext next --lease bila ada ID lease)`,
  );
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
    "Commit pekerjaan Anda di branch kerja. Jangan merge ke default branch tanpa izin pengguna.",
    `catenext done ${res.task.id} --notes "<ringkasan>" --verify "<perintah tes>"${res.lease_id ? ` --lease ${res.lease_id}` : ""}`,
    "Jika ada PR, tambahkan --pr <url> --base <branch>. Handoff lokal tidak memerlukan PR.",
    `Bila buntu: catenext block ${res.task.id} --category <kategori> --reason "<alasan spesifik>"${res.lease_id ? ` --lease ${res.lease_id}` : ""}`,
  );
  return out.join("\n");
}

export async function taskClaim(
  service: LocalService,
  taskId: string,
  opts: { as?: string; json?: boolean; worktree?: boolean; base?: string; cwd?: string },
) {
  if (opts.base && !opts.worktree) {
    throw new PlanningInputError("--base hanya berlaku bersama --worktree.");
  }
  const cwd = opts.cwd ?? process.cwd();
  const branch = opts.worktree ? await git(["symbolic-ref", "--short", "HEAD"], cwd) : null;
  if (opts.worktree && !branch)
    throw new PlanningInputError("Checkout branch kerja sebelum memakai --worktree.");
  const worktreeRoot = opts.worktree
    ? ((await git(["rev-parse", "--show-toplevel"], cwd)) ?? cwd)
    : undefined;
  const sessionId = worktreeRoot ? await readOrCreateCliSessionId(worktreeRoot) : undefined;
  const baseBranch =
    opts.worktree && branch ? (opts.base ?? (await detectBaseBranch(cwd, branch))) : undefined;
  const payload = prepare(
    ClaimTaskInput,
    {
      task_id: taskId,
      ...(opts.as ? { agent_alias: opts.as } : {}),
      ...(branch && sessionId
        ? {
            worktree: {
              branch,
              session_id: sessionId,
              ...(worktreeRoot ? { worktree_path: worktreeRoot } : {}),
              ...(baseBranch ? { base_branch: baseBranch } : {}),
            },
          }
        : {}),
    },
    ["task_id", "session_id", "agent_alias", "branch", "worktree_path", "base_branch"],
  );
  const res = await service.callTool("claim_task", payload);
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
  cwd?: string;
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
  if ((opts.pr !== undefined || opts.base !== undefined) && (!opts.pr || !opts.base)) {
    throw new PlanningInputError("--pr dan --base opsional, tetapi harus diberikan bersama.");
  }
  const files = opts.file.length ? opts.file : gitState.changedFiles;
  return {
    files_modified: files.slice(0, HANDOFF_LIMITS.maxFilesModified),
    key_decisions: opts.decision,
    verification_command: opts.verify ?? null,
    notes_for_next_agent: opts.notes,
    git_branch: gitState.branch,
    last_commit_hash: gitState.commit,
    ...(opts.pr && opts.base
      ? { pull_request: { url: opts.pr, base_branch: opts.base, head_sha: gitState.commit } }
      : {}),
  };
}

export async function taskDone(service: LocalService, taskId: string, opts: DoneOptions) {
  if (opts.handoff && (opts.pr !== undefined || opts.base !== undefined)) {
    throw new PlanningInputError(
      "Sertakan metadata PR di JSON handoff, bukan lewat --pr atau --base bersamaan dengan --handoff.",
    );
  }
  const gitState = await readGitState(opts.cwd);
  if (gitState.dirtyFiles?.length) {
    const preview = gitState.dirtyFiles.slice(0, 5).join(", ");
    const more =
      gitState.dirtyFiles.length > 5 ? ` (+${gitState.dirtyFiles.length - 5} lainnya)` : "";
    console.error(
      `! Peringatan: ada ${gitState.dirtyFiles.length} perubahan belum di-commit (${preview}${more}). ` +
        `Commit pekerjaan Anda agar last_commit_hash (${gitState.commit ?? "HEAD"}) mencakup seluruh perubahan.`,
    );
  }
  const summary = opts.handoff ? await readJsonInput(opts.handoff) : buildHandoff(opts, gitState);
  const body = prepare(
    CompleteHandoffInput,
    { task_id: taskId, handoff_summary: summary, lease_id: opts.lease },
    ["task_id", "last_commit_hash", "head_sha", "lease_id"],
  );
  const res = await service.callTool("complete_handoff", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(
    "✓ Handoff disimpan (NEEDS_REVIEW). Tinjau lalu catat keputusan dengan `catenext review`.",
  );
  console.log(`  ${res.next_step_hint}`);
}

export async function taskBlock(
  service: LocalService,
  taskId: string,
  opts: { category: string; reason: string; json?: boolean; lease?: string },
) {
  const body = prepare(
    ReportBlockerInput,
    { task_id: taskId, category: opts.category, reason: opts.reason, lease_id: opts.lease },
    ["task_id", "category", "lease_id"],
  );
  const res = await service.callTool("report_blocker", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(
    "✓ Task ditandai BLOCKED dan lock dilepas. Setelah hambatan teratasi, gunakan `catenext unblock`.",
  );
}

export async function taskReview(service: LocalService, input: unknown, json: boolean) {
  const body = prepare(ReviewInput, input, [
    "action",
    "task_id",
    "lease_id",
    "head_sha",
    "decision",
    "agent_alias",
  ]);
  const result = await service.callTool("review_pull_request", { request: body });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if ("reviews" in result) {
    if (!result.reviews.length) console.log("Belum ada PR yang bisa Anda review di repo ini.");
    for (const item of result.reviews) {
      const target = item.review.url ?? `(lokal base: ${item.review.base_branch})`;
      console.log(`${item.task_id}  ${item.title}  ${target}`);
    }
  } else {
    console.log(`${result.title}  ${result.status} · ${result.review.stage}`);
    const target = result.review.url ?? `(lokal base: ${result.review.base_branch})`;
    console.log(`${target} @ ${result.review.head_sha}`);
    if (result.lease_id)
      console.log(`Lease review: ${result.lease_id} (sampai ${result.lease_expires_at})`);
    if (result.notes_for_next_agent) console.log(result.notes_for_next_agent);
    if (result.warning) console.error(result.warning);
  }
  if ("warning" in result && result.warning) process.exitCode = 1;
}

/** Orchestrator: kembalikan task ke kolom Revisi atau tetapkan persona/role (manage_task). */
export async function taskManage(service: LocalService, input: unknown, json: boolean) {
  const body = prepare(ManageTaskInput, input, ["action", "task_id", "agent_alias", "role"]);
  const res = await service.callTool("manage_task", body);
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
  } else if (body.action === "assign") {
    console.log(`✓ Penanggung jawab task: ${owner} (status ${res.status}).`);
  } else {
    console.log(`✓ Task ${res.task_id}: ${res.status}.`);
    if (body.action === "approve")
      console.log("  Persetujuan dicatat lokal; status merge PR tidak diverifikasi.");
  }
}

const TaskLogInput = z.strictObject({
  task_id: IdSchema.optional(),
  limit: z.number().int().min(1).max(200).default(20),
});

export async function taskLog(
  service: LocalService,
  taskId?: string,
  opts: { limit?: number; json?: boolean } = {},
) {
  const body = prepare(
    TaskLogInput,
    {
      ...(taskId !== undefined ? { task_id: taskId } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    },
    ["task_id", "limit"],
  );
  const events = await service.readTaskEvents({
    taskId: body.task_id,
    limit: body.limit,
  });
  if (opts.json) return console.log(JSON.stringify({ events }, null, 2));
  if (events.length === 0) {
    return console.log(
      body.task_id
        ? `Belum ada event audit untuk task ${body.task_id}.`
        : "Belum ada event audit task.",
    );
  }
  for (const ev of events) {
    const taskPart = body.task_id
      ? ""
      : `  ${ev.task_id.slice(0, 8)}${ev.task_title ? ` (${briefText(ev.task_title, 40)})` : ""}`;
    const notePart = ev.note ? `  — ${briefText(ev.note, 80)}` : "";
    console.log(`${ev.created_at}  ${ev.event.padEnd(12)}  ${ev.actor}${taskPart}${notePart}`);
  }
}

function renderPermissions(permissions: LocalPermission[]): void {
  if (permissions.length === 0) {
    console.log("Belum ada aturan permission.");
    return;
  }
  const byAction = new Map<string, string[]>();
  for (const row of permissions) {
    const list = byAction.get(row.action) ?? [];
    list.push(row.principal);
    byAction.set(row.action, list);
  }
  for (const action of PERMISSION_ACTIONS) {
    const principals = byAction.get(action) ?? [];
    console.log(`${action.padEnd(16)} ${principals.length ? principals.join(", ") : "(none)"}`);
  }
}

export async function permissionList(service: LocalService, asJson: boolean): Promise<void> {
  const permissions = await service.listPermissions();
  if (asJson) return console.log(JSON.stringify({ permissions }, null, 2));
  renderPermissions(permissions);
}

export async function permissionSet(
  service: LocalService,
  action: string,
  principals: string[],
  asJson: boolean,
): Promise<void> {
  const permissions = await service.setPermissions(action, principals);
  if (asJson) return console.log(JSON.stringify({ permissions }, null, 2));
  const current = permissions.filter((row) => row.action === action).map((row) => row.principal);
  console.log(`✓ Permission ${action}: ${current.join(", ") || "(none)"}`);
}

export async function permissionGrant(
  service: LocalService,
  action: string,
  principal: string,
  asJson: boolean,
): Promise<void> {
  const permissions = await service.grantPermission(action, principal);
  if (asJson) return console.log(JSON.stringify({ permissions }, null, 2));
  const current = permissions.filter((row) => row.action === action).map((row) => row.principal);
  console.log(`✓ Permission ${action}: ${current.join(", ") || "(none)"}`);
}

export async function permissionRevoke(
  service: LocalService,
  action: string,
  principal: string,
  asJson: boolean,
): Promise<void> {
  const permissions = await service.revokePermission(action, principal);
  if (asJson) return console.log(JSON.stringify({ permissions }, null, 2));
  const current = permissions.filter((row) => row.action === action).map((row) => row.principal);
  console.log(`✓ Permission ${action}: ${current.join(", ") || "(none)"}`);
}
