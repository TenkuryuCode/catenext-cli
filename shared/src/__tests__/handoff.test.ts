import { describe, expect, it } from "vitest";
import {
  estimateHandoffTokens,
  HANDOFF_LIMITS,
  HandoffSummarySchema,
  PullRequestRefSchema,
  PullRequestUrlSchema,
} from "../index.js";

const valid = {
  files_modified: ["apps/api/src/routes/tasks.ts", "packages/shared/src/task.ts"],
  key_decisions: ["Lock memakai UPDATE ... WHERE status = 'TODO' agar atomik"],
  verification_command: "pnpm test --filter @catenext/api",
  notes_for_next_agent:
    "Endpoint claim sudah ada; frontend tinggal memanggil POST /tasks/:id/claim.",
  git_branch: "feat/claim-endpoint",
  last_commit_hash: "a1b2c3d",
};

describe("HandoffSummarySchema", () => {
  it("menerima ringkasan valid dalam batas token", () => {
    expect(HandoffSummarySchema.parse(valid)).toEqual(valid);
    expect(estimateHandoffTokens(valid)).toBeLessThanOrEqual(HANDOFF_LIMITS.maxTokens);
  });

  it("menolak lebih dari 15 file", () => {
    const files = Array.from({ length: 16 }, (_, i) => `src/f${i}.ts`);
    expect(HandoffSummarySchema.safeParse({ ...valid, files_modified: files }).success).toBe(false);
  });

  it("menolak lebih dari 5 keputusan atau keputusan > 150 karakter", () => {
    const six = Array.from({ length: 6 }, (_, i) => `keputusan ${i}`);
    expect(HandoffSummarySchema.safeParse({ ...valid, key_decisions: six }).success).toBe(false);
    expect(
      HandoffSummarySchema.safeParse({ ...valid, key_decisions: ["x".repeat(151)] }).success,
    ).toBe(false);
  });

  it("menolak catatan > 500 karakter dan blok kode", () => {
    expect(
      HandoffSummarySchema.safeParse({ ...valid, notes_for_next_agent: "x".repeat(501) }).success,
    ).toBe(false);
    expect(
      HandoffSummarySchema.safeParse({
        ...valid,
        notes_for_next_agent: "lihat ```const a = 1```",
      }).success,
    ).toBe(false);
  });

  it("menolak path berisi spasi (potongan kode) dan hash commit tidak valid", () => {
    expect(
      HandoffSummarySchema.safeParse({ ...valid, files_modified: ["const x = 1"] }).success,
    ).toBe(false);
    expect(HandoffSummarySchema.safeParse({ ...valid, last_commit_hash: "xyz" }).success).toBe(
      false,
    );
  });

  it("menolak payload yang lolos batas per-field tapi melebihi ~600 token total", () => {
    const big = {
      ...valid,
      files_modified: Array.from({ length: 15 }, (_, i) => `packages/${"a".repeat(80)}/f${i}.ts`),
      key_decisions: Array.from({ length: 5 }, () => "k".repeat(150)),
      notes_for_next_agent: "n".repeat(500),
    };
    expect(HandoffSummarySchema.safeParse(big).success).toBe(false);
  });
});

describe("PullRequestUrlSchema & PullRequestRefSchema", () => {
  it.each([
    "https://github.com/org/repo/pull/42",
    "https://gitlab.com/org/repo/merge_requests/12",
    "https://gitlab.com/org/group/repo/-/merge_requests/99",
    "https://bitbucket.org/org/repo/pull-requests/7",
    "https://gitea.example.com/org/repo/pulls/15",
    "https://git.internal:8443/team/service/pulls/3",
  ])("menerima URL PR/MR yang valid: %s", (url) => {
    expect(PullRequestUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    "ftp://github.com/org/repo/pull/1",
    "javascript:alert(1)",
    "github.com/org/repo/pull/1",
    "https://user:pass@github.com/org/repo/pull/1",
    "https://github.com/org/repo/pull/1?tab=files",
    "https://github.com/org/repo/pull/1#discussion",
    "https://github.com/org/repo/pull/0",
    "https://github.com/org/repo/pull/",
    "https://github.com/only-owner/pull/1",
  ])("menolak URL non-http(s) atau tidak valid: %s", (url) => {
    expect(PullRequestUrlSchema.safeParse(url).success).toBe(false);
  });

  it("mengizinkan PullRequestRefSchema tanpa url (review lokal) dan dengan url", () => {
    const head_sha = "a".repeat(40);
    expect(PullRequestRefSchema.parse({ base_branch: "main", head_sha })).toEqual({
      base_branch: "main",
      head_sha,
    });
    expect(
      PullRequestRefSchema.parse({
        url: "https://gitlab.com/org/repo/-/merge_requests/5",
        base_branch: "main",
        head_sha,
      }),
    ).toEqual({
      url: "https://gitlab.com/org/repo/-/merge_requests/5",
      base_branch: "main",
      head_sha,
    });
  });
});
