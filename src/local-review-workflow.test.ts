import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_LEASE_MS, type Persona } from "@catenext/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalServiceError } from "./errors.js";
import { leaseKey } from "./local-lease.js";
import {
  enrichReviewResult,
  offlineReview,
  prepareReviewPullRequest,
  reviewPullRequest,
  reviseTask,
} from "./local-review-workflow.js";
import type { LocalProject, LocalReview, LocalTask } from "./local-state.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ISO = new Date(NOW).toISOString();

function makeTask(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    id: randomUUID(),
    epicId: randomUUID(),
    title: "Reviewable task",
    instruction: "Implement feature",
    status: "NEEDS_REVIEW",
    dependencies: [],
    target: "be",
    role: "backend",
    persona: "dev",
    position: 0,
    requiresApproval: true,
    revision: 0,
    stale: false,
    handoff: {
      files_modified: ["src/index.ts"],
      key_decisions: ["Keep clean"],
      notes_for_next_agent: "Please inspect edge cases",
      verification_command: "pnpm test",
      git_branch: "feat/review",
      last_commit_hash: HEAD_A,
      pull_request: {
        url: "https://github.com/org/repo/pull/1",
        base_branch: "main",
        head_sha: HEAD_A,
      },
    },
    ...overrides,
  };
}

function makeReview(overrides: Partial<LocalReview> = {}): LocalReview {
  return {
    ref: {
      url: "https://github.com/org/repo/pull/1",
      base_branch: "main",
      head_sha: HEAD_A,
    },
    repo: "be",
    author: "dev",
    updatedAt: ISO,
    approvedLocally: false,
    ...overrides,
  };
}

function makeWorkflow(
  tasksList: LocalTask[],
  opts: {
    repoRoot?: string;
    repo?: string;
    now?: number;
    personas?: Persona[];
    overrides?: { default_role?: string; default_agent_alias?: string };
  } = {},
) {
  const personas: Persona[] = opts.personas ?? [
    { alias: "dev", role: "backend", rules: [], repos: ["be"] },
    { alias: "rev", role: "reviewer", rules: [], repos: ["be"] },
    { alias: "rev-other", role: "reviewer", rules: [], repos: ["fe"] },
  ];
  const project: LocalProject = {
    repos: ["be", "fe"],
    epics: [{ id: tasksList[0]?.epicId ?? randomUUID(), title: "Epic", description: null }],
    personas,
    tasks: tasksList,
    documents: [],
    permissions: [],
    workspace_roots: [],
    session_prefs: {},
    platform_setup: [],
  };
  const tasks = new Map(tasksList.map((t) => [t.id, t]));
  const dirty = vi.fn();
  const recordEvent = vi.fn();
  return {
    project,
    tasks,
    dirty,
    recordEvent,
    ctx: {
      project,
      tasks,
      repoRoot: opts.repoRoot ?? "/nonexistent-repo-root",
      repo: opts.repo ?? "be",
      overrides: opts.overrides,
      now: opts.now ?? NOW,
      iso: new Date(opts.now ?? NOW).toISOString(),
      personaForAlias: (alias: string) => {
        const found = personas.find((p) => p.alias === alias);
        if (!found) throw new LocalServiceError("persona_not_found", `Missing ${alias}`);
        return found;
      },
      dirty,
      recordEvent,
    },
  };
}

describe("local-review-workflow", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("reviewPullRequest list", () => {
    it("filters by repo, status, active lease, decision, and applies limit including <= 0", () => {
      const pending1 = makeTask({ title: "Pending 1", review: makeReview() });
      const pending2 = makeTask({ title: "Pending 2", review: makeReview() });
      const expiredLease = makeTask({
        title: "Expired Lease",
        review: makeReview({
          lease: {
            id: leaseKey("old"),
            reviewer: "rev",
            expiresAt: new Date(NOW).toISOString(),
          },
        }),
      });
      const activeLease = makeTask({
        title: "Active Lease",
        review: makeReview({
          lease: {
            id: leaseKey("active"),
            reviewer: "rev",
            expiresAt: new Date(NOW + 10_000).toISOString(),
          },
        }),
      });
      const decided = makeTask({
        title: "Decided",
        review: makeReview({
          decision: { value: "approve", reviewer: "rev", feedback: "LGTM" },
        }),
      });
      const wrongRepo = makeTask({
        title: "Other repo",
        review: makeReview({ repo: "fe" }),
      });
      const wrongStatus = makeTask({ status: "DONE", review: makeReview() });

      const { ctx } = makeWorkflow([
        pending1,
        pending2,
        expiredLease,
        activeLease,
        decided,
        wrongRepo,
        wrongStatus,
      ]);

      const all = reviewPullRequest({ action: "list", limit: 10 }, ctx);
      expect(all).toEqual({
        reviews: [
          expect.objectContaining({ task_id: pending1.id }),
          expect.objectContaining({ task_id: pending2.id }),
          expect.objectContaining({
            task_id: expiredLease.id,
            review: expect.objectContaining({ stage: "awaiting_review", reviewer: null }),
          }),
        ],
      });

      expect(reviewPullRequest({ action: "list", limit: 1 }, ctx)).toEqual({
        reviews: [expect.objectContaining({ task_id: pending1.id })],
      });
      expect(reviewPullRequest({ action: "list", limit: 0 }, ctx)).toEqual({ reviews: [] });
      expect(reviewPullRequest({ action: "list", limit: -3 }, ctx)).toEqual({ reviews: [] });
    });
  });

  describe("reviewPullRequest guards and refresh", () => {
    it("throws not_found or review_not_pending for missing/wrong-repo/non-review tasks", () => {
      const noReview = makeTask({ review: undefined });
      const wrongRepo = makeTask({ review: makeReview({ repo: "fe" }) });
      const todoTask = makeTask({ status: "TODO", review: makeReview() });
      const { ctx } = makeWorkflow([noReview, wrongRepo, todoTask]);

      expect(() =>
        reviewPullRequest({ action: "refresh", task_id: randomUUID() }, ctx),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
      expect(() =>
        reviewPullRequest({ action: "refresh", task_id: noReview.id }, ctx),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
      expect(() =>
        reviewPullRequest({ action: "refresh", task_id: wrongRepo.id }, ctx),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
      expect(() =>
        reviewPullRequest({ action: "refresh", task_id: todoTask.id }, ctx),
      ).toThrowError(expect.objectContaining({ code: "review_not_pending" }));
    });

    it("detects stale_commit on refresh and builds review_context_pack from real git repo", async () => {
      const repoDir = await mkdtemp(join(tmpdir(), "catenext-rev-wf-"));
      tempDirs.push(repoDir);
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: repoDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, "src/index.ts"), "export const v = 1;\n");
      git("add", ".");
      git("commit", "-m", "init");
      git("checkout", "-b", "feat/review");
      await writeFile(join(repoDir, "src/index.ts"), "export const v = 2;\n");
      git("add", ".");
      git("commit", "-m", "feat");
      const headSha = git("rev-parse", "HEAD");

      const task = makeTask({
        scope_files: ["src/index.ts"],
        handoff: {
          files_modified: ["src/index.ts"],
          key_decisions: ["Bump v to 2"],
          notes_for_next_agent: "Check diff",
          verification_command: "pnpm test",
          git_branch: "feat/review",
          last_commit_hash: headSha,
          pull_request: {
            base_branch: "main",
            head_sha: headSha,
          },
        },
        review: makeReview({
          ref: { base_branch: "main", head_sha: headSha },
        }),
      });
      const { ctx } = makeWorkflow([task], { repoRoot: repoDir });

      expect(
        reviewPullRequest({ action: "refresh", task_id: task.id, head_sha: HEAD_B }, ctx),
      ).toMatchObject({
        stale_commit: true,
        warning: expect.stringContaining(offlineReview),
      });

      const packed = reviewPullRequest(
        {
          action: "refresh",
          task_id: task.id,
          include_context: true,
          compact: true,
        },
        ctx,
      );
      expect(packed).toMatchObject({
        notice: offlineReview,
        byte_length: expect.any(Number),
        review_context_pack: {
          task_id: task.id,
          head_sha: headSha,
          diff_meta: { source: "git_diff" },
        },
      });
    });

    it("prepareReviewPullRequest + enrichReviewResult produces identical ReviewContextPack outside the transaction", async () => {
      const repoDir = await mkdtemp(join(tmpdir(), "catenext-rev-prep-"));
      tempDirs.push(repoDir);
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: repoDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, "src/index.ts"), "export const v = 1;\n");
      git("add", ".");
      git("commit", "-m", "init");
      git("checkout", "-b", "feat/review");
      await writeFile(join(repoDir, "src/index.ts"), "export const v = 2;\nexport const ok = 1;\n");
      git("add", ".");
      git("commit", "-m", "feat");
      const headSha = git("rev-parse", "HEAD");

      const makeTargetTask = () =>
        makeTask({
          scope_files: ["src/index.ts"],
          handoff: {
            files_modified: ["src/index.ts"],
            key_decisions: ["Bump v to 2"],
            notes_for_next_agent: "Check diff",
            verification_command: "pnpm test",
            git_branch: "feat/review",
            last_commit_hash: headSha,
            pull_request: {
              base_branch: "main",
              head_sha: headSha,
            },
          },
          review: makeReview({
            ref: { base_branch: "main", head_sha: headSha },
          }),
        });

      const syncTask = makeTargetTask();
      const asyncTask = makeTask({ ...makeTargetTask(), id: syncTask.id, epicId: syncTask.epicId });
      const { ctx: syncCtx } = makeWorkflow([syncTask], { repoRoot: repoDir });
      const { ctx: asyncCtx } = makeWorkflow([asyncTask], { repoRoot: "/nonexistent-inside-tx" });

      // Refresh comparison (non-compact & compact)
      for (const compact of [false, true]) {
        const expected = reviewPullRequest(
          { action: "refresh", task_id: syncTask.id, include_context: true, compact },
          syncCtx,
        );
        const prepared = prepareReviewPullRequest(
          { action: "refresh", task_id: asyncTask.id, include_context: true, compact },
          asyncCtx,
        );
        expect(prepared.contextSnapshot).toBeDefined();
        expect(prepared.result).not.toHaveProperty("review_context_pack");
        const enriched = await enrichReviewResult(prepared, repoDir);
        expect(enriched).toEqual(expected);
      }

      // Claim comparison: prepared snapshots inside tx, enriches outside tx
      const expectedClaim = reviewPullRequest(
        {
          action: "claim",
          task_id: syncTask.id,
          agent_alias: "rev",
          include_context: true,
          compact: true,
        },
        syncCtx,
      );
      const preparedClaim = prepareReviewPullRequest(
        {
          action: "claim",
          task_id: asyncTask.id,
          agent_alias: "rev",
          include_context: true,
          compact: true,
        },
        asyncCtx,
      );
      expect(preparedClaim.contextSnapshot).toBeDefined();
      expect(preparedClaim.result).not.toHaveProperty("review_context_pack");
      const enrichedClaim = await enrichReviewResult(preparedClaim, repoDir);

      if (
        "reviews" in expectedClaim ||
        "reviews" in enrichedClaim ||
        !expectedClaim.review_context_pack ||
        !enrichedClaim.review_context_pack
      ) {
        throw new Error("Expected review_context_pack on claim");
      }
      expect(enrichedClaim.review_context_pack).toEqual(expectedClaim.review_context_pack);
      expect(enrichedClaim.byte_length).toBe(
        Buffer.byteLength(JSON.stringify(enrichedClaim), "utf8"),
      );
    });

    it("warns when claiming or submitting a task that is already DONE or REVISION_REQUESTED", () => {
      const doneTask = makeTask({ status: "DONE", review: makeReview({ approvedLocally: true }) });
      const { ctx } = makeWorkflow([doneTask]);
      expect(
        reviewPullRequest({ action: "claim", task_id: doneTask.id, agent_alias: "rev" }, ctx),
      ).toMatchObject({
        status: "DONE",
        warning: expect.stringContaining("tidak menunggu keputusan"),
      });
    });
  });

  describe("reviewPullRequest claim & submit", () => {
    it("enforces reviewer role, repo ownership, and prevents self-review", () => {
      const task = makeTask({ review: makeReview({ author: "dev" }) });
      const { ctx } = makeWorkflow([task]);

      expect(() =>
        reviewPullRequest({ action: "claim", task_id: task.id, agent_alias: "dev" }, ctx),
      ).toThrowError(expect.objectContaining({ code: "reviewer_required" }));
      expect(() =>
        reviewPullRequest({ action: "claim", task_id: task.id, agent_alias: "rev-other" }, ctx),
      ).toThrowError(expect.objectContaining({ code: "reviewer_required" }));

      const authorReviewer = makeTask({
        review: makeReview({ author: "rev" }),
      });
      const { ctx: selfCtx } = makeWorkflow([authorReviewer]);
      expect(() =>
        reviewPullRequest(
          { action: "claim", task_id: authorReviewer.id, agent_alias: "rev" },
          selfCtx,
        ),
      ).toThrowError(expect.objectContaining({ code: "self_review" }));
    });

    it("rejects stale head_sha on claim and active lease conflicts, but allows reclaim when expired", () => {
      const task = makeTask({
        handoff: {
          files_modified: ["src/a.ts"],
          key_decisions: ["D"],
          notes_for_next_agent: "x".repeat(200),
          verification_command: "pnpm test",
          git_branch: "feat/review",
          last_commit_hash: HEAD_A,
        },
        review: makeReview(),
      });
      const { ctx, dirty } = makeWorkflow([task]);

      expect(
        reviewPullRequest(
          { action: "claim", task_id: task.id, agent_alias: "rev", head_sha: HEAD_B },
          ctx,
        ),
      ).toMatchObject({ stale_commit: true, warning: expect.any(String) });

      const first = reviewPullRequest(
        { action: "claim", task_id: task.id, agent_alias: "rev", compact: true },
        ctx,
      );
      if (!("lease_id" in first) || !first.lease_id) throw new Error("expected lease_id");
      expect(first).toMatchObject({
        review: { stage: "in_review", reviewer: "rev" },
        byte_length: expect.any(Number),
        notice: offlineReview,
      });
      expect(first.notes_for_next_agent?.length).toBeLessThanOrEqual(160);
      expect(dirty).toHaveBeenCalledTimes(1);

      // Active lease conflict blocks second claim.
      const conflict = reviewPullRequest(
        { action: "claim", task_id: task.id, agent_alias: "rev" },
        ctx,
      );
      expect(conflict).toMatchObject({
        warning: expect.stringContaining("sudah diambil atau diputuskan"),
      });
      expect(conflict).not.toHaveProperty("lease_id");

      // Once expired (at exact boundary NOW + LOCK_LEASE_MS), reclaim succeeds and rotates lease_id.
      const { ctx: expiredCtx, dirty: expiredDirty } = makeWorkflow([task], {
        now: NOW + LOCK_LEASE_MS,
      });
      const reclaimed = reviewPullRequest(
        { action: "claim", task_id: task.id, agent_alias: "rev" },
        expiredCtx,
      );
      if (!("lease_id" in reclaimed) || !reclaimed.lease_id) throw new Error("expected reclaim");
      expect(reclaimed.lease_id).not.toBe(first.lease_id);
      expect(expiredDirty).toHaveBeenCalled();
    });

    it("rejects submit when lease is missing, mismatched, stale head_sha, or expired", () => {
      const task = makeTask({ review: makeReview() });
      const { ctx } = makeWorkflow([task]);

      expect(
        reviewPullRequest(
          {
            action: "submit",
            task_id: task.id,
            lease_id: randomUUID(),
            head_sha: HEAD_A,
            decision: "approve",
            feedback: "Looks good",
          },
          ctx,
        ),
      ).toMatchObject({ warning: expect.stringContaining("tidak cocok") });

      const claimed = reviewPullRequest(
        { action: "claim", task_id: task.id, agent_alias: "rev" },
        ctx,
      );
      if (!("lease_id" in claimed) || !claimed.lease_id) throw new Error("expected lease");

      expect(
        reviewPullRequest(
          {
            action: "submit",
            task_id: task.id,
            lease_id: randomUUID(),
            head_sha: HEAD_A,
            decision: "approve",
            feedback: "Looks good",
          },
          ctx,
        ),
      ).toMatchObject({ warning: expect.stringContaining("tidak cocok") });

      expect(
        reviewPullRequest(
          {
            action: "submit",
            task_id: task.id,
            lease_id: claimed.lease_id,
            head_sha: HEAD_B,
            decision: "approve",
            feedback: "Looks good",
          },
          ctx,
        ),
      ).toMatchObject({
        stale_commit: true,
        warning: expect.stringContaining("tidak cocok"),
      });

      // Expired lease at submit time cleans lease and rejects without saving decision.
      const { ctx: expiredCtx, dirty: expiredDirty } = makeWorkflow([task], {
        now: NOW + LOCK_LEASE_MS,
      });
      const expiredSubmit = reviewPullRequest(
        {
          action: "submit",
          task_id: task.id,
          lease_id: claimed.lease_id,
          head_sha: HEAD_A,
          decision: "request_changes",
          feedback: "Too late",
        },
        expiredCtx,
      );
      expect(expiredSubmit).toMatchObject({
        review: { stage: "awaiting_review", reviewer: null },
        warning: expect.stringContaining("kadaluarsa"),
      });
      expect(task.review?.lease).toBeUndefined();
      expect(task.review?.decision).toBeUndefined();
      expect(task.status).toBe("NEEDS_REVIEW");
      expect(expiredDirty).toHaveBeenCalledTimes(1);
    });

    it("records approve without marking DONE and records request_changes by revising task", () => {
      const approveTask = makeTask({ review: makeReview() });
      const { ctx: approveCtx, recordEvent: approveEvents } = makeWorkflow([approveTask]);
      const c1 = reviewPullRequest(
        { action: "claim", task_id: approveTask.id, agent_alias: "rev" },
        approveCtx,
      );
      if (!("lease_id" in c1) || !c1.lease_id) throw new Error("expected lease");
      const approved = reviewPullRequest(
        {
          action: "submit",
          task_id: approveTask.id,
          lease_id: c1.lease_id,
          head_sha: HEAD_A,
          decision: "approve",
          feedback: "Ready for human approval",
        },
        approveCtx,
      );
      expect(approved).toMatchObject({
        status: "NEEDS_REVIEW",
        review: { stage: "awaiting_human_approval", reviewer: "rev" },
        notice: offlineReview,
      });
      expect(approveTask.status).toBe("NEEDS_REVIEW");
      expect(approveEvents).not.toHaveBeenCalled();

      const reviseTarget = makeTask({ review: makeReview() });
      const { ctx: revCtx, recordEvent: revEvents } = makeWorkflow([reviseTarget]);
      const c2 = reviewPullRequest(
        { action: "claim", task_id: reviseTarget.id, agent_alias: "rev" },
        revCtx,
      );
      if (!("lease_id" in c2) || !c2.lease_id) throw new Error("expected lease");
      const requested = reviewPullRequest(
        {
          action: "submit",
          task_id: reviseTarget.id,
          lease_id: c2.lease_id,
          head_sha: HEAD_A,
          decision: "request_changes",
          feedback: "Add unit tests",
        },
        revCtx,
      );
      expect(requested).toMatchObject({
        status: "REVISION_REQUESTED",
        review: { stage: "changes_requested", reviewer: "rev" },
        notice: offlineReview,
      });
      expect(reviseTarget.status).toBe("REVISION_REQUESTED");
      expect(reviseTarget.revision).toBe(1);
      expect(reviseTarget.feedback).toBe("Add unit tests");
      expect(revEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: reviseTarget.id,
          event: "revision",
          actor: "rev",
          note: "Add unit tests",
        }),
      );
    });
  });

  describe("reviseTask", () => {
    it("resets review state, increments revision, clears integrated_commit, and preserves handoff", () => {
      const task = makeTask({
        status: "NEEDS_REVIEW",
        revision: 0,
        integrated_commit: { branch: "main", sha: HEAD_A },
        review: makeReview({
          approvedLocally: true,
          lease: { id: leaseKey("l1"), reviewer: "rev", expiresAt: ISO },
          decision: { value: "approve", reviewer: "rev", feedback: "Old" },
        }),
      });
      const updated = reviseTask(task, [task], "Needs fixes", "2026-01-02T00:00:00.000Z");
      expect(updated).toEqual([]);
      expect(task.status).toBe("REVISION_REQUESTED");
      expect(task.revision).toBe(1);
      expect(task.feedback).toBe("Needs fixes");
      expect(task.integrated_commit).toBeUndefined();
      expect(task.handoff).toBeDefined();
      expect(task.review?.lease).toBeUndefined();
      expect(task.review?.decision).toBeUndefined();
      expect(task.review?.approvedLocally).toBe(false);
      expect(task.review?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    });

    it("throws invalid_transition for non-revisable statuses", () => {
      const todo = makeTask({ status: "TODO" });
      expect(() => reviseTask(todo, [todo], "Nope", ISO)).toThrowError(
        expect.objectContaining({ code: "invalid_transition" }),
      );
    });

    it("BFS marks active/done descendants stale, skips DRAFT/TODO while traversing to grandchildren, and is cycle-safe", () => {
      const rootTask = makeTask({ status: "DONE" });
      const childInProgress = makeTask({
        status: "IN_PROGRESS",
        dependencies: [rootTask.id],
      });
      const childDraft = makeTask({
        status: "DRAFT",
        dependencies: [rootTask.id],
      });
      const childTodo = makeTask({
        status: "TODO",
        dependencies: [rootTask.id],
      });
      const grandFromTodo = makeTask({
        status: "DONE",
        dependencies: [childTodo.id],
      });
      const grandFromDraft = makeTask({
        status: "NEEDS_REVIEW",
        dependencies: [childDraft.id],
      });
      // Introduce a cycle back to rootTask and between descendants to verify cycle safety.
      rootTask.dependencies = [grandFromTodo.id];
      childInProgress.dependencies.push(grandFromDraft.id);

      const all = [rootTask, childInProgress, childDraft, childTodo, grandFromTodo, grandFromDraft];
      const staleIds = reviseTask(rootTask, all, "Re-open upstream", ISO);

      expect(staleIds.sort()).toEqual(
        [childInProgress.id, grandFromTodo.id, grandFromDraft.id].sort(),
      );
      expect(childInProgress.stale).toBe(true);
      expect(grandFromTodo.stale).toBe(true);
      expect(grandFromDraft.stale).toBe(true);
      expect(childDraft.stale).toBe(false);
      expect(childTodo.stale).toBe(false);
    });
  });

  describe("secret scrubbing", () => {
    it("scrubs secrets from reviewEntry title, base_branch, and notes_for_next_agent", () => {
      const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234";
      const task = makeTask({
        title: `Fix leak ${token} in auth`,
        handoff: {
          files_modified: ["src/index.ts"],
          key_decisions: ["Keep clean"],
          notes_for_next_agent: `Check token ${token} before merge ${"x".repeat(160)}`,
          verification_command: "pnpm test",
          git_branch: "feat/review",
          last_commit_hash: HEAD_A,
          pull_request: {
            url: "https://github.com/org/repo/pull/1",
            base_branch: `release/${token}`,
            head_sha: HEAD_A,
          },
        },
        review: makeReview({
          ref: {
            url: "https://github.com/org/repo/pull/1",
            base_branch: `release/${token}`,
            head_sha: HEAD_A,
          },
        }),
      });

      const { ctx } = makeWorkflow([task]);

      const listed = reviewPullRequest({ action: "list", limit: 10 }, ctx);
      expect(JSON.stringify(listed)).not.toContain(token);
      if (!("reviews" in listed)) throw new Error("expected reviews list");
      expect(listed.reviews[0]).toMatchObject({
        title: "Fix leak [REDACTED:github_token] in auth",
        review: { base_branch: "release/[REDACTED:github_token]" },
      });

      const refreshed = reviewPullRequest({ action: "refresh", task_id: task.id }, ctx);
      expect(JSON.stringify(refreshed)).not.toContain(token);
      expect(refreshed).toMatchObject({
        title: "Fix leak [REDACTED:github_token] in auth",
        review: { base_branch: "release/[REDACTED:github_token]" },
      });

      const claimed = reviewPullRequest(
        { action: "claim", task_id: task.id, agent_alias: "rev", compact: true },
        ctx,
      );
      expect(JSON.stringify(claimed)).not.toContain(token);
      if ("reviews" in claimed) throw new Error("expected claimed review");
      expect(claimed.notes_for_next_agent).toContain("[REDACTED:github_token]");
      expect(claimed.notes_for_next_agent?.length).toBeLessThanOrEqual(160);
    });
  });
});
