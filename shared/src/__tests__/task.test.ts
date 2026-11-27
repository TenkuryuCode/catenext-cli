import { describe, expect, it } from "vitest";
import {
  allowedEvents,
  InvalidTransitionError,
  isDependencySatisfied,
  isLeaseExpired,
  KANBAN_STATUSES,
  LOCK_LEASE_MS,
  leaseExpiresAt,
  lockScopeKey,
  nextStatus,
  TASK_STATUSES,
  TaskSchema,
  transition,
} from "../index.js";

describe("status task", () => {
  it("punya tepat 7 status dan Stale bukan salah satunya", () => {
    expect(TASK_STATUSES).toHaveLength(7);
    expect(TASK_STATUSES).not.toContain("STALE");
  });

  it("kolom Kanban tidak memuat DRAFT", () => {
    expect(KANBAN_STATUSES).toEqual([
      "TODO",
      "IN_PROGRESS",
      "NEEDS_REVIEW",
      "REVISION_REQUESTED",
      "BLOCKED",
      "DONE",
    ]);
  });
});

describe("state machine", () => {
  it("menjalankan jalur bahagia DRAFT -> TODO -> IN_PROGRESS -> NEEDS_REVIEW -> DONE", () => {
    let s = transition("DRAFT", "approve_plan");
    expect(s).toBe("TODO");
    s = transition(s, "claim");
    expect(s).toBe("IN_PROGRESS");
    s = transition(s, "complete");
    expect(s).toBe("NEEDS_REVIEW");
    s = transition(s, "approve");
    expect(s).toBe("DONE");
  });

  it("complete selalu ke NEEDS_REVIEW (requiresApproval diabaikan)", () => {
    expect(transition("IN_PROGRESS", "complete")).toBe("NEEDS_REVIEW");
    expect(transition("IN_PROGRESS", "complete", { requiresApproval: false })).toBe("NEEDS_REVIEW");
    expect(transition("NEEDS_REVIEW", "approve")).toBe("DONE");
  });

  it("mendukung revisi dari NEEDS_REVIEW maupun DONE, lalu claim ulang", () => {
    expect(transition("NEEDS_REVIEW", "request_revision")).toBe("REVISION_REQUESTED");
    expect(transition("DONE", "request_revision")).toBe("REVISION_REQUESTED");
    expect(transition("REVISION_REQUESTED", "claim")).toBe("IN_PROGRESS");
  });

  it("blocker, release, dan lease habis mengembalikan task dengan benar", () => {
    expect(transition("IN_PROGRESS", "report_blocker")).toBe("BLOCKED");
    expect(transition("BLOCKED", "unblock")).toBe("TODO");
    expect(transition("IN_PROGRESS", "release")).toBe("TODO");
    expect(transition("IN_PROGRESS", "lease_expired")).toBe("TODO");
  });

  it("menolak transisi yang tidak sah", () => {
    expect(nextStatus("DRAFT", "claim")).toBeNull();
    expect(nextStatus("DONE", "complete")).toBeNull();
    expect(nextStatus("BLOCKED", "claim")).toBeNull();
    expect(() => transition("TODO", "complete")).toThrow(InvalidTransitionError);
  });

  it("allowedEvents mencerminkan tabel transisi", () => {
    expect(allowedEvents("IN_PROGRESS").sort()).toEqual(
      ["complete", "lease_expired", "release", "report_blocker"].sort(),
    );
    expect(allowedEvents("DONE")).toEqual(["request_revision"]);
  });

  it("setiap status non-DRAFT bisa dicapai dari DRAFT", () => {
    const reachable = new Set<string>(["DRAFT"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of [...reachable]) {
        for (const e of allowedEvents(s as never)) {
          for (const ctx of [{}, { requiresApproval: true }]) {
            const to = nextStatus(s as never, e, ctx);
            if (to && !reachable.has(to)) {
              reachable.add(to);
              grew = true;
            }
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual([...TASK_STATUSES].sort());
  });

  it("hanya DONE yang memenuhi dependensi", () => {
    expect(TASK_STATUSES.filter(isDependencySatisfied)).toEqual(["DONE"]);
  });
});

describe("lock & lease", () => {
  const lockedAt = new Date("2026-01-01T00:00:00Z");

  it("lease 30 menit", () => {
    expect(LOCK_LEASE_MS).toBe(30 * 60 * 1000);
    expect(leaseExpiresAt(lockedAt).toISOString()).toBe("2026-01-01T00:30:00.000Z");
  });

  it("mendeteksi lease yang habis tepat di batasnya", () => {
    expect(isLeaseExpired(lockedAt, new Date("2026-01-01T00:29:59Z"))).toBe(false);
    expect(isLeaseExpired(lockedAt, new Date("2026-01-01T00:30:00Z"))).toBe(true);
  });

  it("scope lock per (project, repo)", () => {
    expect(lockScopeKey("p1", "backend")).not.toBe(lockScopeKey("p1", "frontend"));
    expect(lockScopeKey("p1", "backend")).toBe("p1:backend");
  });
});

describe("TaskSchema scoping metadata", () => {
  const baseTask = {
    id: "11111111-2222-4333-8444-555555555555",
    project_id: "11111111-2222-4333-8444-555555555556",
    epic_id: "11111111-2222-4333-8444-555555555557",
    title: "Task",
    prompt_instruction: "Do work",
    status: "TODO" as const,
    target_repo: "catenext",
    role: "backend" as const,
    persona_id: null,
    locked_by: null,
    locked_at: null,
    lease_expires_at: null,
    handoff_summary: null,
    review_feedback: null,
    blocker_reason: null,
    created_at: "2026-11-27T00:00:00.000Z",
    updated_at: "2026-11-27T00:00:00.000Z",
  };

  it("keeps scope_files, verify_command, and doc_refs optional and trims values", () => {
    const omitted = TaskSchema.parse(baseTask);
    expect(omitted.scope_files).toBeUndefined();
    expect(omitted.verify_command).toBeUndefined();
    expect(omitted.doc_refs).toBeUndefined();

    const populated = TaskSchema.parse({
      ...baseTask,
      scope_files: [" packages/shared/src/task.ts "],
      verify_command: " pnpm test ",
      doc_refs: [" sync-board "],
    });
    expect(populated.scope_files).toEqual(["packages/shared/src/task.ts"]);
    expect(populated.verify_command).toBe("pnpm test");
    expect(populated.doc_refs).toEqual(["sync-board"]);
  });
});
