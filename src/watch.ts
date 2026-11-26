import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { briefText, type CatenextConfig, TASK_STATUSES, type TaskStatus } from "@catenext/shared";
import { LocalStore } from "./db/store.js";
import { queryTaskEvents, type TaskEventRecord } from "./db/task-events.js";
import type { LocalProject, LocalTask } from "./local-state.js";
import { scrubText } from "./scrubber.js";

export type WatchOptions = {
  epic?: string;
  eventLimit?: number;
  now?: number;
};

export type WatchStatusCounts = Partial<Record<TaskStatus, number>>;

export type WatchEpicSummary = {
  id: string;
  title: string;
  counts: WatchStatusCounts;
};

export type WatchLeaseRow = {
  task_id: string;
  title: string;
  persona: string | null;
  repo: string;
  branch: string | null;
  worktree_path: string | null;
  base_branch: string | null;
  session: string | null;
  expires_at: string;
};

export type WatchApprovalRow = {
  task_id: string;
  title: string;
  status: "DRAFT" | "NEEDS_REVIEW";
  summary: string;
};

export type WatchEventRow = {
  created_at: string;
  event: string;
  actor: string;
  task_id: string;
  task_title: string | null;
  note: string | null;
};

export type WatchSnapshot = {
  generated_at: string;
  project_id: string;
  epic_filter: string | null;
  epics: WatchEpicSummary[];
  status_totals: WatchStatusCounts;
  leases: WatchLeaseRow[];
  approvals: WatchApprovalRow[];
  events: WatchEventRow[];
};

function emptyCounts(): WatchStatusCounts {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as WatchStatusCounts;
}

function bump(counts: WatchStatusCounts, status: TaskStatus): void {
  counts[status] = (counts[status] ?? 0) + 1;
}

function activeLease(task: LocalTask, now: number): LocalTask["lease"] | undefined {
  if (!task.lease) return undefined;
  return Date.parse(task.lease.expiresAt) > now ? task.lease : undefined;
}

function formatCounts(counts: WatchStatusCounts): string {
  return TASK_STATUSES.filter((status) => (counts[status] ?? 0) > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(", ");
}

/** Pure snapshot builder — used by CLI polling and unit tests. */
export function buildWatchSnapshot(
  projectId: string,
  project: LocalProject,
  events: readonly TaskEventRecord[],
  options: WatchOptions = {},
): WatchSnapshot {
  const now = options.now ?? Date.now();
  const epicFilter = options.epic ?? null;
  const tasks = project.tasks.filter((task) => !epicFilter || task.epicId === epicFilter);
  const taskIds = new Set(tasks.map((task) => task.id));

  const status_totals = emptyCounts();
  for (const task of tasks) bump(status_totals, task.status);

  const epics = project.epics
    .filter((epic) => !epicFilter || epic.id === epicFilter)
    .map((epic) => {
      const counts = emptyCounts();
      for (const task of project.tasks.filter((row) => row.epicId === epic.id)) {
        bump(counts, task.status);
      }
      return { id: epic.id, title: epic.title, counts };
    });

  const leases: WatchLeaseRow[] = [];
  for (const task of tasks) {
    const lease = activeLease(task, now);
    if (!lease || task.status !== "IN_PROGRESS") continue;
    leases.push({
      task_id: task.id,
      title: briefText(task.title, 80),
      persona: task.persona ?? lease.alias ?? null,
      repo: lease.repo,
      branch: task.branch?.name ?? null,
      worktree_path: lease.worktree?.worktree_path ?? task.branch?.worktree_path ?? null,
      base_branch: lease.worktree?.base_branch ?? task.branch?.base_branch ?? null,
      session: lease.worktree?.session ?? null,
      expires_at: lease.expiresAt,
    });
  }

  const approvals: WatchApprovalRow[] = [];
  for (const task of tasks) {
    if (task.status === "DRAFT") {
      approvals.push({
        task_id: task.id,
        title: briefText(task.title, 80),
        status: "DRAFT",
        summary: briefText(task.instruction, 100),
      });
    } else if (task.status === "NEEDS_REVIEW") {
      approvals.push({
        task_id: task.id,
        title: briefText(task.title, 80),
        status: "NEEDS_REVIEW",
        summary: briefText(
          task.handoff?.notes_for_next_agent ??
            task.handoff?.verification_command ??
            "Needs review",
          100,
        ),
      });
    }
  }

  const eventRows: WatchEventRow[] = events
    .filter((ev) => !epicFilter || taskIds.has(ev.task_id))
    .map((ev) => ({
      created_at: ev.created_at,
      event: ev.event,
      actor: scrubText(ev.actor),
      task_id: ev.task_id,
      task_title: ev.task_title ? briefText(scrubText(ev.task_title), 40) : null,
      note: ev.note ? briefText(scrubText(ev.note), 80) : null,
    }));

  return {
    generated_at: new Date(now).toISOString(),
    project_id: projectId,
    epic_filter: epicFilter,
    epics,
    status_totals,
    leases,
    approvals: approvals.slice(0, 10),
    events: eventRows,
  };
}

/** Read-only SQLite poll — does not acquire `.lock` or rewrite state. */
export async function collectWatchSnapshot(
  root: string,
  config: CatenextConfig,
  options: WatchOptions = {},
): Promise<WatchSnapshot> {
  const stateFile = resolve(root, config.state_file ?? ".catenext/catenext.sqlite");
  const store = new LocalStore(stateFile);
  const eventLimit = Math.max(1, Math.min(50, options.eventLimit ?? 10));
  return await store.read(config.project_id, (project, db) => {
    const events = queryTaskEvents(db, config.project_id, { limit: eventLimit });
    return buildWatchSnapshot(config.project_id, project, events, options);
  });
}

export function formatWatchSnapshot(snapshot: WatchSnapshot): string {
  const lines: string[] = [];
  const filter = snapshot.epic_filter ? ` · epic=${snapshot.epic_filter.slice(0, 8)}` : "";
  lines.push(`catenext watch  ${snapshot.generated_at}${filter}`);
  lines.push("");

  lines.push("## Board");
  if (snapshot.epics.length === 0) {
    lines.push("  (no epics)");
  } else {
    for (const epic of snapshot.epics) {
      const counts = formatCounts(epic.counts) || "empty";
      lines.push(`  # ${briefText(epic.title, 60)}  {${counts}}`);
    }
  }
  const totals = formatCounts(snapshot.status_totals);
  if (totals) lines.push(`  totals: ${totals}`);

  lines.push("");
  lines.push("## Active leases / worktrees");
  if (snapshot.leases.length === 0) {
    lines.push("  (none)");
  } else {
    for (const lease of snapshot.leases) {
      const who = lease.persona ?? "?";
      const branch = lease.branch
        ? lease.base_branch
          ? `${lease.branch} (base=${lease.base_branch})`
          : lease.branch
        : "no-branch";
      const path = lease.worktree_path ? ` · ${lease.worktree_path}` : "";
      lines.push(
        `  ${lease.task_id.slice(0, 8)}  @${who}  ${branch}${path}  exp=${lease.expires_at}`,
      );
      lines.push(`    ${lease.title}`);
    }
  }

  lines.push("");
  lines.push("## Pending human approvals");
  if (snapshot.approvals.length === 0) {
    lines.push("  (none)");
  } else {
    for (const row of snapshot.approvals) {
      lines.push(
        `  ${row.status.padEnd(12)} ${row.task_id.slice(0, 8)}  ${row.title}  — ${row.summary}`,
      );
    }
  }

  lines.push("");
  lines.push("## Recent task_events");
  if (snapshot.events.length === 0) {
    lines.push("  (none)");
  } else {
    for (const ev of snapshot.events) {
      const title = ev.task_title ? ` (${ev.task_title})` : "";
      const note = ev.note ? `  — ${ev.note}` : "";
      lines.push(
        `  ${ev.created_at}  ${ev.event.padEnd(16)}  ${ev.actor}  ${ev.task_id.slice(0, 8)}${title}${note}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export type WatchRunOptions = {
  root: string;
  config: CatenextConfig;
  intervalMs?: number;
  once?: boolean;
  epic?: string;
  eventLimit?: number;
  json?: boolean;
  signal?: AbortSignal;
  write?: (text: string) => void;
  clear?: () => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  collect?: typeof collectWatchSnapshot;
};

const DEFAULT_INTERVAL_MS = 2000;

function defaultClear(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[H\x1b[2J");
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}

/** Poll read-only snapshots until --once, AbortSignal, or SIGINT. */
export async function runWatch(options: WatchRunOptions): Promise<WatchSnapshot> {
  const intervalMs = Math.max(250, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const clear = options.clear ?? defaultClear;
  const sleep = options.sleep ?? defaultSleep;
  const collect = options.collect ?? collectWatchSnapshot;
  const watchOpts: WatchOptions = {
    epic: options.epic,
    eventLimit: options.eventLimit,
  };

  let stop = false;
  const onSigInt = () => {
    stop = true;
  };
  if (!options.signal) {
    process.once("SIGINT", onSigInt);
  }

  let latest: WatchSnapshot | undefined;
  try {
    for (;;) {
      if (options.signal?.aborted || stop) break;
      latest = await collect(options.root, options.config, {
        ...watchOpts,
        now: Date.now(),
      });
      if (!options.once && !options.json) clear();
      write(options.json ? `${JSON.stringify(latest, null, 2)}\n` : formatWatchSnapshot(latest));
      if (options.once || options.signal?.aborted || stop) break;
      try {
        await sleep(intervalMs, options.signal);
      } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          break;
        }
        throw error;
      }
      if (stop || options.signal?.aborted) break;
    }
  } finally {
    if (!options.signal) {
      process.off("SIGINT", onSigInt);
    }
  }

  if (!latest) {
    latest = await collect(options.root, options.config, {
      ...watchOpts,
      now: Date.now(),
    });
  }
  return latest;
}
