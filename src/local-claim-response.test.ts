import { randomUUID } from "node:crypto";
import type { Persona } from "@catenext/shared";
import { describe, expect, it } from "vitest";
import { claimResponse, dependencyHandoffs } from "./local-claim-response.js";
import type { LocalTask } from "./local-state.js";

function makeTask(overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    id: randomUUID(),
    epicId: randomUUID(),
    title: "Task title",
    instruction: "Follow instructions",
    status: "TODO",
    dependencies: [],
    target: null,
    role: null,
    persona: null,
    position: 0,
    requiresApproval: false,
    revision: 0,
    stale: false,
    ...overrides,
  };
}

function makeHandoff(overrides: Partial<NonNullable<LocalTask["handoff"]>> = {}) {
  return {
    files_modified: ["src/a.ts"],
    key_decisions: ["Decision A"],
    notes_for_next_agent: "Notes A",
    verification_command: "pnpm test",
    git_branch: "feat/a",
    last_commit_hash: "a".repeat(40),
    ...overrides,
  };
}

describe("local-claim-response", () => {
  describe("dependencyHandoffs", () => {
    it("skips missing dependencies and dependencies without handoffs", () => {
      const missingId = randomUUID();
      const noHandoff = makeTask({ title: "No handoff" });
      const withHandoff = makeTask({
        title: "With handoff",
        handoff: makeHandoff(),
      });
      const task = makeTask({
        dependencies: [missingId, noHandoff.id, withHandoff.id],
      });
      const tasks = new Map<string, LocalTask>([
        [noHandoff.id, noHandoff],
        [withHandoff.id, withHandoff],
      ]);

      expect(dependencyHandoffs(task, tasks)).toEqual([
        {
          task_id: withHandoff.id,
          title: "With handoff",
          handoff_summary: withHandoff.handoff,
        },
      ]);
    });

    it("prefers task.integrated_commit and falls back to handoff.integrated_commit", () => {
      const taskCommit = { branch: "epic/int", sha: "b".repeat(40) };
      const handoffCommit = { branch: "feat/old", sha: "c".repeat(40) };

      const depTaskCommit = makeTask({
        title: "Task commit wins",
        integrated_commit: taskCommit,
        handoff: {
          ...makeHandoff(),
          integrated_commit: handoffCommit,
        } as LocalTask["handoff"],
      });
      const depFallback = makeTask({
        title: "Handoff fallback",
        handoff: {
          ...makeHandoff(),
          integrated_commit: handoffCommit,
        } as LocalTask["handoff"],
      });
      const task = makeTask({ dependencies: [depTaskCommit.id, depFallback.id] });
      const tasks = new Map<string, LocalTask>([
        [depTaskCommit.id, depTaskCommit],
        [depFallback.id, depFallback],
      ]);

      expect(dependencyHandoffs(task, tasks)).toEqual([
        {
          task_id: depTaskCommit.id,
          title: "Task commit wins",
          handoff_summary: depTaskCommit.handoff,
          integrated_commit: taskCommit,
        },
        {
          task_id: depFallback.id,
          title: "Handoff fallback",
          handoff_summary: depFallback.handoff,
          integrated_commit: handoffCommit,
        },
      ]);
    });

    it("deduplicates duplicate dependency IDs while preserving first-occurrence order", () => {
      const d1 = makeTask({ title: "First", handoff: makeHandoff({ notes_for_next_agent: "N1" }) });
      const d2 = makeTask({
        title: "Second",
        handoff: makeHandoff({ notes_for_next_agent: "N2" }),
      });
      const d3 = makeTask({ title: "Third", handoff: makeHandoff({ notes_for_next_agent: "N3" }) });

      const task = makeTask({
        dependencies: [d1.id, d2.id, d1.id, d3.id, d2.id],
      });
      const tasks = new Map<string, LocalTask>([
        [d1.id, d1],
        [d2.id, d2],
        [d3.id, d3],
      ]);

      const result = dependencyHandoffs(task, tasks);
      expect(result.map((entry) => entry.task_id)).toEqual([d1.id, d2.id, d3.id]);
    });
  });

  describe("claimResponse", () => {
    it("renders full response with optional fields including empty scope_files array", () => {
      const commit = { branch: "main", sha: "d".repeat(40) };
      const dep = makeTask({
        title: "Upstream",
        handoff: makeHandoff(),
        integrated_commit: commit,
      });
      const task = makeTask({
        title: "Downstream",
        instruction: "Implement feature",
        revision: 2,
        role: "backend",
        target: "be",
        scope_files: [],
        verify_command: "pnpm --filter catenext test",
        doc_refs: ["architecture"],
        dependencies: [dep.id],
      });
      const persona: Persona = {
        alias: "be-dev",
        role: "backend",
        rules: ["Write tests"],
        repos: ["be"],
      };
      const revision = {
        review_feedback: "Fix edge case",
        previous_handoff: makeHandoff(),
      };
      const expiry = "2026-01-01T12:30:00.000Z";
      const leaseId = randomUUID();

      const res = claimResponse({
        task,
        tasks: new Map([[dep.id, dep]]),
        persona,
        leaseId,
        expiry,
        compact: false,
        revision,
      });

      expect(res).toEqual({
        task: {
          id: task.id,
          title: "Downstream",
          prompt_instruction: "Implement feature",
          status: "IN_PROGRESS",
          revision_count: 2,
          role: "backend",
          target_repo: "be",
          scope_files: [],
          verify_command: "pnpm --filter catenext test",
          doc_refs: ["architecture"],
        },
        persona,
        lease_id: leaseId,
        lease_expires_at: expiry,
        dependencies: [
          {
            task_id: dep.id,
            title: "Upstream",
            handoff_summary: dep.handoff,
            integrated_commit: commit,
          },
        ],
        revision,
        warnings: [],
      });
    });

    it("renders compact dependency handoffs and omits unset optional fields", () => {
      const commit = { branch: "main", sha: "e".repeat(40) };
      const dep = makeTask({
        title: "Upstream",
        handoff: makeHandoff({
          files_modified: ["src/x.ts"],
          key_decisions: ["Used Zod"],
          notes_for_next_agent: "Check schema",
        }),
        integrated_commit: commit,
      });
      const task = makeTask({
        dependencies: [dep.id],
      });
      const leaseId = randomUUID();
      const expiry = "2026-01-01T12:30:00.000Z";

      const res = claimResponse({
        task,
        tasks: new Map([[dep.id, dep]]),
        leaseId,
        expiry,
        compact: true,
      });

      expect(res.task).toEqual({
        id: task.id,
        title: task.title,
        prompt_instruction: task.instruction,
        status: "IN_PROGRESS",
        revision_count: 0,
      });
      expect(res).not.toHaveProperty("persona");
      expect(res).not.toHaveProperty("revision");
      expect(res.dependencies).toEqual([
        {
          task_id: dep.id,
          title: "Upstream",
          compact_handoff: {
            files_modified: ["src/x.ts"],
            key_decisions: ["Used Zod"],
            notes_for_next_agent: "Check schema",
          },
          integrated_commit: commit,
        },
      ]);
    });
  });
});
