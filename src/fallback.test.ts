import { describe, expect, it } from "vitest";
import { buildHandoff, renderClaim } from "./fallback.js";

const GIT = { branch: "feat/login", commit: "abcdef1234567", changedFiles: ["a.ts", "b.ts"] };

describe("fallback CLI", () => {
  it("buildHandoff memakai git lokal bila --file tidak diisi", () => {
    expect(buildHandoff({ notes: "Siap", decision: ["Pakai Hono"], file: [] }, GIT)).toEqual({
      files_modified: ["a.ts", "b.ts"],
      key_decisions: ["Pakai Hono"],
      verification_command: null,
      notes_for_next_agent: "Siap",
      git_branch: "feat/login",
      last_commit_hash: "abcdef1234567",
    });
  });

  it("buildHandoff menolak tanpa --notes atau di luar git", () => {
    expect(() => buildHandoff({ decision: [], file: [] }, GIT)).toThrow(/--notes/);
    expect(() =>
      buildHandoff({ notes: "x", decision: [], file: [] }, { ...GIT, commit: null }),
    ).toThrow(/git/);
  });

  it("renderClaim menampilkan instruksi, revisi, dan handoff dependensi", () => {
    const md = renderClaim({
      task: {
        id: "11111111-2222-4333-8444-555555555555",
        title: "Form login",
        prompt_instruction: "Buat form",
        status: "IN_PROGRESS",
        revision_count: 1,
      },
      lease_expires_at: "2026-11-25T06:00:00Z",
      dependencies: [
        {
          task_id: "11111111-2222-4333-8444-555555555556",
          title: "API login",
          handoff_summary: {
            files_modified: ["api.ts"],
            key_decisions: ["JWT"],
            verification_command: "pnpm test",
            notes_for_next_agent: "Endpoint /login siap",
            git_branch: "main",
            last_commit_hash: "abcdef1",
          },
        },
      ],
      revision: { review_feedback: "Tambah validasi email", previous_handoff: null },
      warnings: [],
    });
    expect(md).toContain("# Task: Form login");
    expect(md).toContain("Tambah validasi email");
    expect(md).toContain("Endpoint /login siap");
    expect(md).toContain("catenext done 11111111-2222-4333-8444-555555555555");
  });
});
