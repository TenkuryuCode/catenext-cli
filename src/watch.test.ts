import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CatenextConfig,
  CatenextConfigSchema,
  LOCK_LEASE_MS,
  type McpToolInput,
} from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabaseAt } from "./db/open.js";
import { LocalService } from "./local-service.js";
import type { LocalProject, LocalTask } from "./local-state.js";
import {
  buildWatchSnapshot,
  collectWatchSnapshot,
  formatWatchSnapshot,
  runWatch,
} from "./watch.js";

const start = Date.parse("2026-01-01T09:00:00.000Z");

function task(partial: Partial<LocalTask> & Pick<LocalTask, "id" | "epicId" | "title">): LocalTask {
  return {
    instruction: "Do the work carefully.",
    status: "TODO",
    dependencies: [],
    target: "be",
    role: "backend",
    persona: "be",
    position: 0,
    requiresApproval: true,
    revision: 0,
    stale: false,
    ...partial,
  };
}

function project(overrides: Partial<LocalProject> = {}): LocalProject {
  const epicId = overrides.epics?.[0]?.id ?? "11111111-1111-4111-8111-111111111111";
  return {
    repos: ["be"],
    epics: [{ id: epicId, title: "Watch epic", description: null }],
    personas: [{ alias: "be", role: "backend", rules: ["Own API"], repos: ["be"] }],
    tasks: [],
    documents: [],
    permissions: [],
    workspace_roots: [],
    session_prefs: {},
    platform_setup: ["cursor"],
    ...overrides,
  };
}

describe("buildWatchSnapshot", () => {
  it("summarizes board counts, active leases, approvals, and events", () => {
    const epicA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const epicB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const draftId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const progressId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const reviewId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const expiredId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    const snap = buildWatchSnapshot(
      "project-1",
      project({
        epics: [
          { id: epicA, title: "Alpha", description: null },
          { id: epicB, title: "Beta", description: null },
        ],
        tasks: [
          task({
            id: draftId,
            epicId: epicA,
            title: "Draft plan",
            status: "DRAFT",
            instruction: "Approve this draft plan first.",
          }),
          task({
            id: progressId,
            epicId: epicA,
            title: "Implement watch",
            status: "IN_PROGRESS",
            persona: "be",
            lease: {
              id: "sha256.abc",
              repo: "be",
              alias: "be",
              expiresAt: new Date(start + 60_000).toISOString(),
              worktree: {
                session: "11111111-1111-4111-8111-111111111111",
                worktree_path: "/tmp/wt-watch",
                base_branch: "main",
              },
            },
            branch: {
              repo: "be",
              name: "feat/watch",
              worktree_path: "/tmp/wt-watch",
              base_branch: "main",
            },
          }),
          task({
            id: expiredId,
            epicId: epicA,
            title: "Expired lease",
            status: "IN_PROGRESS",
            lease: {
              id: "sha256.old",
              repo: "be",
              expiresAt: new Date(start - 1).toISOString(),
            },
            branch: { repo: "be", name: "feat/old" },
          }),
          task({
            id: reviewId,
            epicId: epicB,
            title: "Review handoff",
            status: "NEEDS_REVIEW",
            handoff: {
              files_modified: ["apps/cli/src/watch.ts"],
              key_decisions: ["Read-only poll"],
              verification_command: "pnpm test",
              notes_for_next_agent: "Check watch output",
              git_branch: "feat/review",
              last_commit_hash: "a".repeat(40),
            },
          }),
        ],
      }),
      [
        {
          id: 1,
          project_id: "project-1",
          task_id: progressId,
          task_title: "Implement watch",
          event: "claim",
          actor: "be",
          note: "claimed",
          detail: null,
          created_at: new Date(start).toISOString(),
        },
      ],
      { now: start },
    );

    expect(snap.status_totals).toMatchObject({
      DRAFT: 1,
      IN_PROGRESS: 2,
      NEEDS_REVIEW: 1,
    });
    expect(snap.leases).toHaveLength(1);
    expect(snap.leases[0]).toMatchObject({
      task_id: progressId,
      branch: "feat/watch",
      worktree_path: "/tmp/wt-watch",
      base_branch: "main",
    });
    expect(snap.approvals.map((row) => row.status).sort()).toEqual(["DRAFT", "NEEDS_REVIEW"]);
    expect(snap.events).toHaveLength(1);

    const filtered = buildWatchSnapshot(
      "project-1",
      project({
        epics: [
          { id: epicA, title: "Alpha", description: null },
          { id: epicB, title: "Beta", description: null },
        ],
        tasks: [
          task({ id: draftId, epicId: epicA, title: "Draft plan", status: "DRAFT" }),
          task({
            id: reviewId,
            epicId: epicB,
            title: "Review handoff",
            status: "NEEDS_REVIEW",
            handoff: {
              files_modified: ["x"],
              key_decisions: ["y"],
              verification_command: "pnpm test",
              notes_for_next_agent: "ok",
              git_branch: "feat/review",
              last_commit_hash: "a".repeat(40),
            },
          }),
        ],
      }),
      [
        {
          id: 2,
          project_id: "project-1",
          task_id: reviewId,
          task_title: "Review handoff",
          event: "complete",
          actor: "be",
          note: null,
          detail: null,
          created_at: new Date(start).toISOString(),
        },
      ],
      { now: start, epic: epicA },
    );
    expect(filtered.epics).toHaveLength(1);
    expect(filtered.approvals).toHaveLength(1);
    expect(filtered.approvals[0]?.status).toBe("DRAFT");
    expect(filtered.events).toHaveLength(0);
  });

  it("formats a compact terminal summary", () => {
    const text = formatWatchSnapshot({
      generated_at: new Date(start).toISOString(),
      project_id: "p",
      epic_filter: null,
      epics: [{ id: "e", title: "Epic", counts: { TODO: 1, DRAFT: 1 } }],
      status_totals: { TODO: 1, DRAFT: 1 },
      leases: [
        {
          task_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          title: "Implement watch",
          persona: "be",
          repo: "be",
          branch: "feat/watch",
          worktree_path: "/tmp/wt",
          base_branch: "main",
          session: "s",
          expires_at: new Date(start + 60_000).toISOString(),
        },
      ],
      approvals: [
        {
          task_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          title: "Draft",
          status: "DRAFT",
          summary: "Approve me",
        },
      ],
      events: [
        {
          created_at: new Date(start).toISOString(),
          event: "claim",
          actor: "be",
          task_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          task_title: "Implement watch",
          note: "ok",
        },
      ],
    });
    expect(text).toContain("## Board");
    expect(text).toContain("## Active leases / worktrees");
    expect(text).toContain("@be");
    expect(text).toContain("## Pending human approvals");
    expect(text).toContain("DRAFT");
    expect(text).toContain("## Recent task_events");
    expect(text).toContain("claim");
  });
});

describe("collectWatchSnapshot + runWatch", () => {
  let root: string;
  let config: CatenextConfig;
  let service: LocalService;

  const plan = (
    ref: string,
    options: Partial<McpToolInput<"create_tasks">["tasks"][number]> = {},
  ) => ({
    ref,
    title: `Task ${ref}`,
    prompt_instruction: `Instructions for ${ref}.`,
    ...options,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-watch-"));
    config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: randomUUID(),
      project_name: "Watch",
      repo_name: "be",
    });
    service = new LocalService(root, config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("reads via LocalStore without creating a writer lock", async () => {
    const { epic } = await service.callTool("create_epic", { title: "Watch lane" });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [plan("draft"), plan("active")],
    });
    const draftId = created.find((row) => row.ref === "draft")?.task_id;
    const activeId = created.find((row) => row.ref === "active")?.task_id;
    if (!draftId || !activeId) throw new Error("missing tasks");
    await service.callTool("manage_task", { action: "approve_plan", task_id: activeId });
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    await service.callTool("claim_task", {
      task_id: activeId,
      worktree: {
        session_id: randomUUID(),
        branch: "feat/watch-test",
        worktree_path: join(root, "wt"),
        base_branch: "main",
      },
    });
    clock.mockReturnValue(start + 1_000);

    mkdirSync(join(root, ".catenext"), { recursive: true });
    const lockPath = `${service.stateFile}.lock`;
    // Ensure no lock remains from seed/claim; then collect while another read-only open is fine.
    const before = openDatabaseAt(service.stateFile, { readOnly: true });
    before.close();

    const snap = await collectWatchSnapshot(root, config, {
      now: start + 1_000,
      epic: epic.id,
    });
    expect(snap.epic_filter).toBe(epic.id);
    expect(snap.status_totals.DRAFT).toBe(1);
    expect(snap.status_totals.IN_PROGRESS).toBe(1);
    expect(snap.leases).toHaveLength(1);
    expect(snap.leases[0]?.task_id).toBe(activeId);
    expect(snap.approvals.some((row) => row.task_id === draftId)).toBe(true);
    expect(snap.events.some((ev) => ev.event === "claim")).toBe(true);
    expect(lockPath.endsWith(".lock")).toBe(true);

    // Expired leases drop out of the active list.
    const expired = await collectWatchSnapshot(root, config, {
      now: start + LOCK_LEASE_MS + 5_000,
      epic: epic.id,
    });
    expect(expired.leases).toHaveLength(0);
  });

  it("runWatch --once writes one formatted snapshot", async () => {
    await service.callTool("create_epic", { title: "Once" });
    const chunks: string[] = [];
    const snap = await runWatch({
      root,
      config,
      once: true,
      write: (text) => {
        chunks.push(text);
      },
      clear: () => {
        throw new Error("clear should not run for --once");
      },
      sleep: async () => {
        throw new Error("sleep should not run for --once");
      },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("## Board");
    expect(snap.epics).toHaveLength(1);
  });

  it("runWatch polls until abort and respects interval", async () => {
    await service.callTool("create_epic", { title: "Loop" });
    const sleeps: number[] = [];
    const controller = new AbortController();
    let ticks = 0;
    const collect = vi.fn(async () => {
      ticks += 1;
      if (ticks >= 2) controller.abort();
      return {
        generated_at: new Date(start).toISOString(),
        project_id: config.project_id,
        epic_filter: null,
        epics: [],
        status_totals: {},
        leases: [],
        approvals: [],
        events: [],
      };
    });
    await runWatch({
      root,
      config,
      intervalMs: 500,
      signal: controller.signal,
      collect,
      write: () => {},
      clear: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(collect).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([500]);
  });

  it("wires config state_file for collectWatchSnapshot", async () => {
    const custom = join(root, "custom-state.sqlite");
    const altConfig = { ...config, state_file: "custom-state.sqlite" };
    const alt = new LocalService(root, altConfig);
    await alt.callTool("create_epic", { title: "Custom state" });
    writeFileSync(join(root, "marker"), "ok");
    const snap = await collectWatchSnapshot(root, altConfig, { now: start });
    expect(snap.epics[0]?.title).toBe("Custom state");
    expect(custom.endsWith("custom-state.sqlite")).toBe(true);
  });
});
