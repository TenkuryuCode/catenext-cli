import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AgentAliasSchema,
  type CatenextConfig,
  IdSchema,
  TaskVerifyCommandSchema,
} from "@catenext/shared";
import { z } from "zod";
import { ApprovalSnapshotSchema } from "./approval-policy.js";
import {
  assertCleanRunHead,
  assertDescends,
  commitChanges,
  fullSha,
  localCommit,
} from "./epic-run-git.js";
import { LocalServiceError } from "./errors.js";
import type { LocalProject, LocalTask } from "./local-state.js";

const sha = z.string().regex(fullSha);
const planOptions = z.strictObject({
  base: z.string().min(1).max(255),
  check: TaskVerifyCommandSchema,
});
const start = planOptions.extend({ snapshot: ApprovalSnapshotSchema });
const feedback = z.string().trim().min(5).max(1000);
export const epicRunAction = z.discriminatedUnion("action", [
  planOptions.extend({ action: z.literal("preview") }),
  start.extend({ action: z.literal("start") }),
  z.strictObject({ action: z.literal("resume") }),
  z.strictObject({ action: z.literal("close") }),
  z.strictObject({ action: z.literal("pause"), reason: feedback }),
  z.strictObject({
    action: z.literal("review"),
    task: IdSchema,
    head: sha,
    reviewer: AgentAliasSchema,
    decision: z.enum(["accept", "request_changes"]),
    feedback,
  }),
  z.strictObject({
    action: z.literal("verify"),
    head: sha,
    path: z.string().max(1000),
    attempt: IdSchema,
    result: z.enum(["pass", "fail"]),
  }),
]);

const plannedTask = z.strictObject({
  id: IdSchema,
  title: z.string(),
  instruction: z.string(),
  dependencies: z.array(IdSchema).max(2),
  target: z.string().nullable(),
  persona: AgentAliasSchema,
  role: z.string().nullable(),
  position: z.number(),
  requires_approval: z.boolean(),
  scope: z.array(z.string()).min(1).max(20),
  verify: TaskVerifyCommandSchema,
  docs: z.array(z.string()).max(10),
  persona_definition: z.object({
    role: z.string(),
    rules: z.array(z.string()),
    repos: z.array(z.string()),
  }),
});
const planSchema = z.strictObject({
  epic_id: IdSchema,
  repo: z.string(),
  base: z.string(),
  base_sha: sha,
  check: TaskVerifyCommandSchema,
  tasks: z.array(plannedTask).min(2).max(3),
});
export type RunPlan = z.output<typeof planSchema>;
const reviewSchema = z.strictObject({
  task: IdSchema,
  head: sha,
  reviewer: AgentAliasSchema,
  decision: z.enum(["accept", "request_changes"]),
  feedback,
  revision: z.number().int().min(0).max(2),
  at: z.iso.datetime(),
});
const runSchema = z.strictObject({
  plan: planSchema,
  snapshot: ApprovalSnapshotSchema,
  authorized_at: z.iso.datetime(),
  status: z.enum(["RUNNING", "PAUSED", "READY_FOR_PR", "CLOSED"]),
  reason: z.string().optional(),
  reviews: z.array(reviewSchema).max(9),
  verification: z
    .array(
      z.strictObject({
        attempt: IdSchema,
        head: sha,
        result: z.enum(["pass", "fail"]),
        at: z.iso.datetime(),
      }),
    )
    .max(3),
  ready_head: sha.optional(),
});
export type EpicRun = z.output<typeof runSchema>;
export type RunReview = z.output<typeof reviewSchema>;
export const runPrefix = (epic: string) => `catenext/run/${epic}`;
export const runBranch = (epic: string, task: string) => `${runPrefix(epic)}/${task}`;
export const integrationBranch = (epic: string) => `${runPrefix(epic)}/integration`;

function fail(code: string, message: string): never {
  throw new LocalServiceError(code, message);
}

export function readRun(db: DatabaseSync, project: string, epic: string): EpicRun | undefined {
  const row = db
    .prepare("SELECT state_json FROM epic_runs WHERE project_id = ? AND epic_id = ?")
    .get(project, epic);
  if (!row) return;
  try {
    return runSchema.parse(JSON.parse(String(row.state_json)));
  } catch {
    fail("corrupt_state", "Invalid epic run journal; restore from backup.");
  }
}

export function saveRun(db: DatabaseSync, project: string, run: EpicRun) {
  db.prepare(`INSERT INTO epic_runs (project_id, epic_id, repo, closed, state_json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (project_id, epic_id) DO UPDATE SET closed = excluded.closed, state_json = excluded.state_json`).run(
    project,
    run.plan.epic_id,
    run.plan.repo,
    Number(run.status === "CLOSED"),
    JSON.stringify(runSchema.parse(run)),
  );
}

function taskPlan(project: LocalProject, task: LocalTask) {
  const definition = project.personas.find(({ alias }) => alias === task.persona);
  return plannedTask.safeParse({
    id: task.id,
    title: task.title,
    instruction: task.instruction,
    dependencies: [...task.dependencies].sort(),
    target: task.target,
    persona: task.persona,
    role: task.role,
    position: task.position,
    requires_approval: task.requiresApproval,
    scope: [...(task.scope_files ?? [])].sort(),
    verify: task.verify_command,
    docs: task.doc_refs ?? [],
    persona_definition: definition && {
      role: definition.role,
      rules: definition.rules,
      repos: definition.repos,
    },
  });
}

// Literal files only; fail closed for globs, ambiguous paths, and governance/automation paths.
export function safeScope(path: string): boolean {
  return (
    !isAbsolute(path) &&
    path
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_.@-]+$/.test(part) &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git",
      ) &&
    !/^(?:\.|(?:AGENTS|CATENEXT|CLAUDE|GEMINI)\.md$)/i.test(path)
  );
}

// Conservative heuristic, not semantic risk detection. Host must stop on other risky changes.
function risk(path: string): boolean {
  return /(?:^|[/.@_-])(?:api|openapi|swagger|db|database|schema|migrations?|prisma|drizzle|sql)(?:$|[/.@_-])/i.test(
    path,
  );
}

function tasksOf(project: LocalProject, id: string) {
  return project.tasks
    .filter((task) => task.epicId === id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function previewRun(
  root: string,
  config: CatenextConfig,
  project: LocalProject,
  db: DatabaseSync,
  epic: string,
  options: z.output<typeof planOptions>,
) {
  if (!project.epics.some(({ id }) => id === epic)) fail("not_found", "Epic not found.");
  const tasks = tasksOf(project, epic);
  const ids = new Set(tasks.map(({ id }) => id));
  const seen = new Set<string>();
  if (tasks.length < 2 || tasks.length > 3) fail("run_plan", "Local run needs exactly 2–3 tasks.");
  const rows = tasks.map((task) => {
    const parsed = taskPlan(project, task);
    if (
      !parsed.success ||
      (parsed.data.persona_definition.repos.length > 0 &&
        !parsed.data.persona_definition.repos.includes(config.repo_name)) ||
      (task.target && task.target !== config.repo_name) ||
      task.dependencies.some((id) => !ids.has(id)) ||
      task.stale ||
      task.revision !== 0 ||
      task.branch ||
      (task.status !== "TODO" && task.status !== "DRAFT")
    ) {
      fail(
        "run_plan",
        "Use fresh local DRAFT/TODO tasks with named personas, literal scope, checks, and only in-epic dependencies.",
      );
    }
    for (const path of parsed.data.scope) {
      if (!safeScope(path) || risk(path))
        fail("run_risk", "Unsafe or DB/API scope; use manual planning and review.");
      if (seen.has(path.toLowerCase()))
        fail("run_plan", "Run tasks must have disjoint file scopes.");
      seen.add(path.toLowerCase());
    }
    return parsed.data;
  });
  const plan: RunPlan = {
    epic_id: epic,
    repo: config.repo_name,
    base: options.base,
    base_sha: localCommit(root, options.base),
    check: options.check,
    tasks: rows,
  };
  const event = db.prepare(
    "SELECT max(id) AS id FROM task_events WHERE project_id = ? AND task_id = ?",
  );
  const snapshot = createHash("sha256")
    .update(
      JSON.stringify([
        config.project_id,
        plan,
        project.epics.find(({ id }) => id === epic),
        tasks.map(({ id, status }) => [status, event.get(config.project_id, id)?.id ?? null]),
      ]),
    )
    .digest("hex");
  return {
    plan,
    snapshot,
    integration_branch: integrationBranch(epic),
    max_worktrees: 2,
    max_revisions_per_task: 2,
  };
}

const startEvent = `COALESCE((SELECT max(id) FROM task_events
  WHERE project_id = ? AND task_id = ? AND event = 'epic_run_start'), 0)`;

export function leaseFailures(
  db: DatabaseSync,
  project: string,
  task: LocalTask,
  now: number,
): number {
  const recorded = db
    .prepare(`SELECT count(*) AS count FROM task_events WHERE project_id = ? AND task_id = ?
    AND event IN ('lease_expired', 'release') AND id > ${startEvent}`)
    .get(project, task.id, project, task.id);
  return (
    Number(recorded?.count ?? 0) +
    Number(Boolean(task.lease && Date.parse(task.lease.expiresAt) <= now))
  );
}

export function runIssue(
  run: EpicRun,
  project: LocalProject,
  db: DatabaseSync,
  projectId: string,
): string | undefined {
  if (run.status === "PAUSED") return run.reason ?? "Run paused.";
  const tasks = tasksOf(project, run.plan.epic_id);
  if (tasks.length !== run.plan.tasks.length) return "Epic membership changed.";
  const changed = db.prepare(`SELECT 1 FROM task_events WHERE project_id = ? AND task_id = ?
    AND event IN ('update', 'set_dependencies', 'assign', 'cancel') AND id > ${startEvent} LIMIT 1`);
  for (const [index, task] of tasks.entries()) {
    const parsed = taskPlan(project, task);
    if (
      !parsed.success ||
      JSON.stringify(parsed.data) !== JSON.stringify(run.plan.tasks[index]) ||
      task.stale ||
      task.status === "DRAFT" ||
      changed.get(projectId, task.id, projectId, task.id)
    ) {
      return "Approved task plan or dependencies changed.";
    }
    if (task.status === "BLOCKED") return `Task ${task.id} reported a blocker.`;
    if (task.revision > 2) return `Task ${task.id} exceeded revision limit.`;
    if (leaseFailures(db, projectId, task, Date.now()) >= 2)
      return `Task ${task.id} repeatedly lost or released its lease.`;
  }
  return undefined;
}

export function assertRunHealthy(
  run: EpicRun,
  project: LocalProject,
  db: DatabaseSync,
  projectId: string,
) {
  const issue = runIssue(run, project, db, projectId);
  if (issue) fail("run_paused", `${issue} Inspect with catenext epic run resume.`);
  if (run.status !== "RUNNING") fail("run_state", `Run is ${run.status}.`);
}

export function acceptedReview(run: EpicRun, task: LocalTask) {
  const last = run.reviews.findLast((review) => review.task === task.id);
  return last?.decision === "accept" &&
    last.head === task.handoff?.last_commit_hash &&
    last.revision === task.revision
    ? last
    : undefined;
}

/** Inspect Git, not handoff's self-reported file list. Dependency post-images may be inherited. */
export function runTaskChanges(
  root: string,
  run: EpicRun,
  project: LocalProject,
  task: LocalTask,
  head: string,
): Map<string, string> {
  const planned = run.plan.tasks.find(({ id }) => id === task.id);
  if (!planned) fail("run_plan", "Task is outside approved run.");
  assertDescends(root, run.plan.base_sha, head);
  const diff = commitChanges(root, run.plan.base_sha, head);
  const own = new Map<string, string>();
  const deps = new Set<string>();
  const queue = [...planned.dependencies];
  for (const id of queue) {
    if (deps.has(id)) continue;
    deps.add(id);
    queue.push(...(run.plan.tasks.find((part) => part.id === id)?.dependencies ?? []));
  }
  for (const [path, image] of diff) {
    if (!safeScope(path) || risk(path) || !/^(?:000000|100644|100755) /.test(image)) {
      fail("run_risk", "Git change contains risky path or object type.");
    }
    if (planned.scope.includes(path)) own.set(path, image);
    else {
      const dep = project.tasks.find(
        (row) =>
          deps.has(row.id) &&
          run.plan.tasks.find((part) => part.id === row.id)?.scope.includes(path),
      );
      const accepted = dep?.status === "DONE" && acceptedReview(run, dep);
      if (!accepted || commitChanges(root, run.plan.base_sha, accepted.head).get(path) !== image) {
        fail(
          "run_scope",
          "Git change exceeds confirmed scope or alters a dependency's reviewed result.",
        );
      }
    }
  }
  if (own.size === 0) fail("run_scope", "Task has no changes in its approved scope.");
  return own;
}

export function assertIntegration(
  root: string,
  run: EpicRun,
  project: LocalProject,
  path: string,
  head: string,
) {
  if (!isAbsolute(path)) fail("run_worktree", "Integration checkout path must be absolute.");
  const branch = integrationBranch(run.plan.epic_id);
  assertCleanRunHead(root, runPrefix(run.plan.epic_id), branch, path, head);
  assertDescends(root, run.plan.base_sha, head);
  const expected = new Map<string, string>();
  for (const part of run.plan.tasks) {
    const task = project.tasks.find(({ id }) => id === part.id);
    const review = task?.status === "DONE" && acceptedReview(run, task);
    if (!review || !task)
      fail(
        "run_review",
        "All tasks need delegated acceptance and separate human handoff approval.",
      );
    for (const [file, object] of runTaskChanges(root, run, project, task, review.head))
      expected.set(file, object);
  }
  const actual = commitChanges(root, run.plan.base_sha, head);
  if (
    expected.size !== actual.size ||
    [...expected].some(([file, object]) => actual.get(file) !== object)
  ) {
    fail("run_scope", "Integration tree must match exact reviewed task changes.");
  }
}
