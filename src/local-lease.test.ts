import { randomUUID } from "node:crypto";
import { LOCK_LEASE_MS } from "@catenext/shared";
import { describe, expect, it } from "vitest";
import { LocalServiceError } from "./errors.js";
import {
  advance,
  claimable,
  endLease,
  leaseEnd,
  leaseKey,
  leaseMatches,
  returnClaim,
} from "./local-lease.js";
import type { LocalTask } from "./local-state.js";

function makeTask(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    id: randomUUID(),
    epicId: randomUUID(),
    title: "Sample task",
    instruction: "Do work",
    status: "TODO",
    dependencies: [],
    target: "be",
    role: "backend",
    persona: null,
    position: 0,
    requiresApproval: false,
    revision: 0,
    stale: false,
    ...overrides,
  };
}

describe("local-lease", () => {
  describe("leaseEnd", () => {
    it("computes ISO expiry offset by LOCK_LEASE_MS", () => {
      const now = Date.UTC(2026, 0, 1, 12, 0, 0);
      expect(leaseEnd(now)).toBe(new Date(now + LOCK_LEASE_MS).toISOString());
      expect(leaseEnd(0)).toBe(new Date(LOCK_LEASE_MS).toISOString());
    });

    it("throws LocalServiceError(invalid_timestamp) for NaN, Infinity, and overflow timestamps", () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e20]) {
        try {
          leaseEnd(bad);
          expect.unreachable(`expected failure for ${bad}`);
        } catch (err) {
          expect(err).toBeInstanceOf(LocalServiceError);
          expect(err).toMatchObject({ code: "invalid_timestamp" });
        }
      }
    });
  });

  describe("leaseKey and leaseMatches", () => {
    it("hashes tokens deterministically with sha256 prefix", () => {
      const token = randomUUID();
      const hashed = leaseKey(token);
      expect(hashed).toMatch(/^sha256\.[a-f0-9]{64}$/);
      expect(leaseKey(token)).toBe(hashed);
      expect(leaseKey(`${token}-other`)).not.toBe(hashed);
    });

    it("matches sha256-hashed stored leases only against the original token", () => {
      const token = "lease-secret-token";
      const stored = leaseKey(token);
      expect(leaseMatches(stored, token)).toBe(true);
      expect(leaseMatches(stored, "wrong-token")).toBe(false);
      expect(leaseMatches(stored, stored)).toBe(false);
    });

    it("matches legacy plaintext stored leases directly", () => {
      expect(leaseMatches("legacy-token-123", "legacy-token-123")).toBe(true);
      expect(leaseMatches("legacy-token-123", "legacy-token-124")).toBe(false);
    });

    it("rejects empty stored, empty presented, undefined, and mismatched lengths", () => {
      expect(leaseMatches("", "")).toBe(false);
      expect(leaseMatches("", "token")).toBe(false);
      expect(leaseMatches("stored", "")).toBe(false);
      expect(leaseMatches(leaseKey(""), "")).toBe(false);
      expect(leaseMatches(leaseKey("token"), undefined)).toBe(false);
      expect(leaseMatches("legacy", undefined)).toBe(false);
      expect(leaseMatches("short", "much-longer-token")).toBe(false);
      expect(leaseMatches("ab", "é")).toBe(false);
      expect(leaseMatches("sha256.", "token")).toBe(false);
    });
  });

  describe("claimable", () => {
    it("returns true only for TODO and REVISION_REQUESTED", () => {
      expect(claimable(makeTask({ status: "TODO" }))).toBe(true);
      expect(claimable(makeTask({ status: "REVISION_REQUESTED" }))).toBe(true);
      for (const status of ["DRAFT", "IN_PROGRESS", "NEEDS_REVIEW", "BLOCKED", "DONE"] as const) {
        expect(claimable(makeTask({ status }))).toBe(false);
      }
    });
  });

  describe("advance", () => {
    it("transitions valid task statuses", () => {
      const task = makeTask({ status: "DRAFT" });
      advance(task, "approve_plan");
      expect(task.status).toBe("TODO");
      advance(task, "claim");
      expect(task.status).toBe("IN_PROGRESS");
      advance(task, "complete");
      expect(task.status).toBe("NEEDS_REVIEW");
      advance(task, "approve");
      expect(task.status).toBe("DONE");
    });

    it("throws invalid_transition and leaves status unchanged for invalid events", () => {
      const task = makeTask({ status: "DRAFT" });
      try {
        advance(task, "claim");
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(LocalServiceError);
        expect(err).toMatchObject({ code: "invalid_transition" });
      }
      expect(task.status).toBe("DRAFT");
    });
  });

  describe("endLease and returnClaim", () => {
    const handoff = {
      files_modified: ["src/index.ts"],
      key_decisions: ["Keep simple"],
      notes_for_next_agent: "Ready",
      verification_command: "pnpm test",
      git_branch: "feat/test",
      last_commit_hash: "a".repeat(40),
    };

    it("endLease removes lease and branch when no handoff exists", () => {
      const task = makeTask({
        status: "IN_PROGRESS",
        lease: { id: leaseKey("t1"), repo: "be", expiresAt: new Date().toISOString() },
        branch: { repo: "be", name: "feat/test" },
      });
      endLease(task);
      expect(task.lease).toBeUndefined();
      expect(task.branch).toBeUndefined();
    });

    it("endLease preserves branch when handoff exists", () => {
      const task = makeTask({
        status: "IN_PROGRESS",
        lease: { id: leaseKey("t1"), repo: "be", expiresAt: new Date().toISOString() },
        branch: { repo: "be", name: "feat/test" },
        handoff,
      });
      endLease(task);
      expect(task.lease).toBeUndefined();
      expect(task.branch).toEqual({ repo: "be", name: "feat/test" });
    });

    it("returnClaim sets TODO without handoff and REVISION_REQUESTED with handoff", () => {
      const fresh = makeTask({
        status: "IN_PROGRESS",
        lease: { id: leaseKey("t1"), repo: "be", expiresAt: new Date().toISOString() },
        branch: { repo: "be", name: "feat/fresh" },
      });
      expect(returnClaim(fresh)).toBe("TODO");
      expect(fresh.status).toBe("TODO");
      expect(fresh.lease).toBeUndefined();
      expect(fresh.branch).toBeUndefined();

      const revised = makeTask({
        status: "IN_PROGRESS",
        lease: { id: leaseKey("t2"), repo: "be", expiresAt: new Date().toISOString() },
        branch: { repo: "be", name: "feat/revised" },
        handoff,
      });
      expect(returnClaim(revised)).toBe("REVISION_REQUESTED");
      expect(revised.status).toBe("REVISION_REQUESTED");
      expect(revised.lease).toBeUndefined();
      expect(revised.branch).toEqual({ repo: "be", name: "feat/revised" });
    });
  });
});
