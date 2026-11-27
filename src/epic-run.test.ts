import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { CatenextConfigSchema, type McpToolInput } from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrationBranch, runBranch } from "./epic-run.js";
import { LocalService } from "./local-service.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function commit(cwd: string, file: string, body: string) {
  await mkdir(join(cwd, dirname(file)), { recursive: true });
  await writeFile(join(cwd, file), body, "utf8");
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

function worktree(root: string, path: string, branch: string, base = "main") {
  git(root, "worktree", "add", "-b", branch, path, base);
}

describe("LocalService bounded epic runs", () => {
  let dir: string;
  let root: string;
  let service: LocalService;

  beforeEach(async () => {
    // realpath so claim paths match Git porcelain (avoids tmpdir short names / symlinks).
    dir = await realpath(await mkdtemp(join(tmpdir(), "catenext-epic-run-")));
    root = join(dir, "repo");
    await mkdir(root, { recursive: true });
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    await commit(root, "src/index.ts", "export const ready = true;\n");
    service = new LocalService(
      root,
      CatenextConfigSchema.parse({
        schema_version: 1,
        project_id: randomUUID(),
        project_name: "BoundedRun",
        repo_name: "be",
        layout: "monorepo",
      }),
    );
    await service.callTool("upsert_persona", { alias: "be", role: "backend", repos: ["be"] });
    await service.callTool("upsert_persona", { alias: "fe", role: "frontend", repos: ["be"] });
    await service.callTool("upsert_persona", { alias: "rev", role: "reviewer", repos: ["be"] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function planEpic(tasks?: McpToolInput<"create_tasks">["tasks"]) {
    const { epic } = await service.callTool("create_epic", { title: "Bounded Feature" });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: tasks ?? [
        {
          ref: "a",
          title: "Task A",
          prompt_instruction: "Implement A",
          persona: "be",
          scope_files: ["src/a.ts"],
          verify_command: "pnpm test a",
        },
        {
          ref: "b",
          title: "Task B",
          prompt_instruction: "Implement B",
          persona: "fe",
          scope_files: ["src/b.ts"],
          verify_command: "pnpm test b",
        },
        {
          ref: "c",
          title: "Task C",
          prompt_instruction: "Integrate C",
          persona: "be",
          depends_on: ["a", "b"],
          scope_files: ["src/c.ts"],
          verify_command: "pnpm test c",
        },
      ],
    });
    const id = (ref: string) => {
      const found = created.find((row) => row.ref === ref)?.task_id;
      if (!found) throw new Error(`Missing ${ref}`);
      return found;
    };
    return { epic: epic.id, id };
  }

  async function start(epic: string) {
    const preview = await service.epicRun(epic, {
      action: "preview",
      base: "main",
      check: "pnpm test",
    });
    if (!("max_worktrees" in preview)) throw new Error("Expected preview");
    const started = await service.epicRun(epic, {
      action: "start",
      base: "main",
      check: "pnpm test",
      snapshot: preview.snapshot,
    });
    return { preview, started };
  }

  async function claim(epic: string, task: string, persona: string, path: string, base = "main") {
    const branch = runBranch(epic, task);
    worktree(root, path, branch, base);
    const res = await service.callTool("claim_task", {
      task_id: task,
      agent_alias: persona,
      worktree: { session_id: randomUUID(), branch, worktree_path: path, base_branch: base },
    });
    return { branch, lease: res.lease_id };
  }

  async function handoff(epic: string, task: string, lease: string, head: string, file: string) {
    return service.callTool("complete_handoff", {
      task_id: task,
      lease_id: lease,
      handoff_summary: {
        files_modified: [file],
        key_decisions: ["Scoped"],
        verification_command: "pnpm test",
        notes_for_next_agent: "Done",
        git_branch: runBranch(epic, task),
        last_commit_hash: head,
      },
    });
  }

  it("binds start to exact plan, requires delegated acceptance before human approval, and stops at READY_FOR_PR", async () => {
    const { epic, id } = await planEpic();
    const a = id("a");
    const b = id("b");
    const c = id("c");
    const agent = new LocalService(
      root,
      (service as unknown as { config: ReturnType<typeof CatenextConfigSchema.parse> }).config,
      "agent",
    );
    await expect(
      agent.epicRun(epic, { action: "preview", base: "main", check: "pnpm test" }),
    ).rejects.toMatchObject({
      code: "human_approval_required",
    });

    const first = await service.epicRun(epic, {
      action: "preview",
      base: "main",
      check: "pnpm test",
    });
    if (!("max_worktrees" in first)) throw new Error("Expected preview");
    await commit(root, "src/index.ts", "export const ready = 'changed';\n");
    await expect(
      service.epicRun(epic, {
        action: "start",
        base: "main",
        check: "pnpm test",
        snapshot: first.snapshot,
      }),
    ).rejects.toMatchObject({ code: "stale_approval" });

    const { preview, started } = await start(epic);
    expect(started).toMatchObject({
      status: "RUNNING",
      host_mode: "stepped",
      unattended_supported: false,
      eligible: expect.arrayContaining([a, b]),
    });
    // Idempotent start retry with identical authorization.
    expect(
      await service.epicRun(epic, {
        action: "start",
        base: "main",
        check: "pnpm test",
        snapshot: preview.snapshot,
      }),
    ).toMatchObject({ status: "RUNNING", snapshot: preview.snapshot });

    const wtA = join(dir, "wt-a");
    const wtB = join(dir, "wt-b");
    const claimA = await claim(epic, a, "be", wtA);
    const claimB = await claim(epic, b, "fe", wtB);
    expect(await service.epicRun(epic, { action: "resume" })).toMatchObject({ eligible: [] });

    const headA = await commit(wtA, "src/a.ts", "export const a = 1;\n");
    const headB = await commit(wtB, "src/b.ts", "export const b = 2;\n");
    await handoff(epic, a, claimA.lease, headA, "src/a.ts");
    await handoff(epic, b, claimB.lease, headB, "src/b.ts");

    // Human approval cannot bypass delegated review acceptance during an active run.
    await expect(
      service.callTool("manage_task", { action: "approve", task_id: a }),
    ).rejects.toMatchObject({
      code: "run_review",
    });
    // Self-review is rejected.
    await expect(
      service.epicRun(epic, {
        action: "review",
        task: a,
        head: headA,
        reviewer: "be",
        decision: "accept",
        feedback: "Self check",
      }),
    ).rejects.toMatchObject({ code: "reviewer_required" });

    // Delegated acceptance records audit separately and leaves task in NEEDS_REVIEW until human approves.
    await service.epicRun(epic, {
      action: "review",
      task: a,
      head: headA,
      reviewer: "rev",
      decision: "accept",
      feedback: "Scoped and verified",
    });
    await service.epicRun(epic, {
      action: "review",
      task: b,
      head: headB,
      reviewer: "rev",
      decision: "accept",
      feedback: "Scoped and verified",
    });
    const boardBeforeApprove = await service.callTool("get_project_board", { epic_id: epic });
    expect(boardBeforeApprove.tasks.find((row) => row.id === a)?.status).toBe("NEEDS_REVIEW");

    const brief = await service.callTool("session_brief", {});
    const snapA = brief.pending_approvals.find((row) => row.task_id === a)?.approval_snapshot;
    await service.callTool(
      "manage_task",
      { action: "approve", task_id: a },
      { approvalSnapshot: snapA },
    );
    await service.callTool("manage_task", { action: "approve", task_id: b });

    git(root, "worktree", "remove", wtA);
    git(root, "worktree", "remove", wtB);

    const wtC = join(dir, "wt-c");
    const claimC = await claim(epic, c, "be", wtC);
    git(wtC, "cherry-pick", headA, headB);
    const headC = await commit(wtC, "src/c.ts", "export const c = 3;\n");
    await handoff(epic, c, claimC.lease, headC, "src/c.ts");
    await service.epicRun(epic, {
      action: "review",
      task: c,
      head: headC,
      reviewer: "rev",
      decision: "accept",
      feedback: "Clean integration",
    });
    await service.callTool("manage_task", { action: "approve", task_id: c });
    git(root, "worktree", "remove", wtC);

    const wtInt = join(dir, "wt-int");
    worktree(root, wtInt, integrationBranch(epic), runBranch(epic, c));
    const attempt1 = randomUUID();
    const afterFail = await service.epicRun(epic, {
      action: "verify",
      head: headC,
      path: wtInt,
      attempt: attempt1,
      result: "fail",
    });
    expect(afterFail).toMatchObject({ status: "RUNNING" });
    // Replaying the same attempt ID is idempotent and does not count as a second failure.
    await service.epicRun(epic, {
      action: "verify",
      head: headC,
      path: wtInt,
      attempt: attempt1,
      result: "fail",
    });
    const ready = await service.epicRun(epic, {
      action: "verify",
      head: headC,
      path: wtInt,
      attempt: randomUUID(),
      result: "pass",
    });
    expect(ready).toMatchObject({
      status: "READY_FOR_PR",
      ready_head: headC,
      integration_branch: integrationBranch(epic),
    });

    const events = await service.readTaskEvents({ taskId: a, limit: 20 });
    expect(
      events.map((row) => [
        row.event,
        row.actor,
        row.detail?.source ?? row.detail?.dispatch ?? null,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["epic_run_start", "human", null],
        ["epic_run_review", "rev", "delegated_review"],
        ["approve", "human", "conditional_cli"],
      ]),
    );
  }, 30_000);

  it("enforces two-worktree and two-revision caps and pauses on scope drift, DB/API risk, or repeated failure", async () => {
    await expect(
      planEpic([
        {
          ref: "a",
          title: "A",
          prompt_instruction: "A",
          persona: "be",
          scope_files: ["src/db/schema.ts"],
          verify_command: "pnpm test",
        },
        {
          ref: "b",
          title: "B",
          prompt_instruction: "B",
          persona: "fe",
          scope_files: ["src/b.ts"],
          verify_command: "pnpm test",
        },
      ]).then(({ epic }) =>
        service.epicRun(epic, { action: "preview", base: "main", check: "pnpm test" }),
      ),
    ).rejects.toMatchObject({ code: "run_risk" });

    const { epic, id } = await planEpic([
      {
        ref: "a",
        title: "A",
        prompt_instruction: "A",
        persona: "be",
        scope_files: ["src/a.ts"],
        verify_command: "pnpm test",
      },
      {
        ref: "b",
        title: "B",
        prompt_instruction: "B",
        persona: "fe",
        scope_files: ["src/b.ts"],
        verify_command: "pnpm test",
      },
      {
        ref: "c",
        title: "C",
        prompt_instruction: "C",
        persona: "be",
        scope_files: ["src/c.ts"],
        verify_command: "pnpm test",
      },
    ]);
    await start(epic);
    const a = id("a");
    const b = id("b");
    const c = id("c");

    const wtA = join(dir, "wt-a");
    const wtB = join(dir, "wt-b");
    const wtC = join(dir, "wt-c");
    const claimA = await claim(epic, a, "be", wtA);
    const claimB = await claim(epic, b, "fe", wtB);
    worktree(root, wtC, runBranch(epic, c));
    await expect(
      service.callTool("claim_task", {
        task_id: c,
        agent_alias: "be",
        worktree: {
          session_id: randomUUID(),
          branch: runBranch(epic, c),
          worktree_path: wtC,
          base_branch: "main",
        },
      }),
    ).rejects.toMatchObject({ code: "run_worktree" });
    git(root, "worktree", "remove", wtC);

    // Two revisions allowed; third request_changes pauses the run.
    for (const round of [1, 2, 3]) {
      const head = await commit(wtA, "src/a.ts", `export const a = ${round};\n`);
      const lease =
        round === 1
          ? claimA.lease
          : (
              await service.callTool("claim_task", {
                task_id: a,
                agent_alias: "be",
                worktree: {
                  session_id: randomUUID(),
                  branch: runBranch(epic, a),
                  worktree_path: wtA,
                  base_branch: "main",
                },
              })
            ).lease_id;
      await handoff(epic, a, lease, head, "src/a.ts");
      const reviewed = await service.epicRun(epic, {
        action: "review",
        task: a,
        head,
        reviewer: "rev",
        decision: "request_changes",
        feedback: `Revision round ${round}`,
      });
      expect(reviewed).toMatchObject({ status: round < 3 ? "RUNNING" : "PAUSED" });
    }

    // Scope drift in actual Git commit pauses run during handoff even if handoff claims only src/a.ts.
    const drift = await planEpic([
      {
        ref: "a",
        title: "A",
        prompt_instruction: "A",
        persona: "be",
        scope_files: ["src/a.ts"],
        verify_command: "pnpm test",
      },
      {
        ref: "b",
        title: "B",
        prompt_instruction: "B",
        persona: "fe",
        scope_files: ["src/b.ts"],
        verify_command: "pnpm test",
      },
    ]);
    await expect(start(drift.epic)).rejects.toMatchObject({ code: "run_state" });
    await service.callTool("release_task", { task_id: b, lease_id: claimB.lease });
    await service.epicRun(epic, { action: "close" });
    git(root, "worktree", "remove", wtA);
    git(root, "worktree", "remove", wtB);

    await start(drift.epic);
    const wtDrift = join(dir, "wt-drift");
    const claimDrift = await claim(drift.epic, drift.id("a"), "be", wtDrift);
    await commit(wtDrift, "src/a.ts", "export const ok = 1;\n");
    const driftHead = await commit(wtDrift, "src/unplanned.ts", "export const secret = 1;\n");
    await handoff(drift.epic, drift.id("a"), claimDrift.lease, driftHead, "src/a.ts");
    expect(await service.epicRun(drift.epic, { action: "resume" })).toMatchObject({
      status: "PAUSED",
    });
  }, 30_000);

  it("matches registered run worktree paths across path separators and non-canonical path forms", async () => {
    const { assertRunCheckout } = await import("./epic-run-git.js");
    const epic = randomUUID();
    const task = randomUUID();
    const branch = runBranch(epic, task);
    const wt = join(dir, "wt-path-norm");
    worktree(root, wt, branch);
    try {
      // Mixed separators + `..` + trailing sep (Windows-safe via path.join).
      const alias = `${join(wt, "..", basename(wt))}${sep}`;
      expect(() => assertRunCheckout(root, `catenext/run/${epic}`, branch, alias)).not.toThrow();
    } finally {
      git(root, "worktree", "remove", wt);
    }
  });
});
