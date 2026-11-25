import { describe, expect, it } from "vitest";
import { renderTaskDelegatePrompt } from "../orchestrator.js";

describe("renderTaskDelegatePrompt", () => {
  it("menyusun prompt delegasi dengan persona, repo, dan worktree monorepo", () => {
    const md = renderTaskDelegatePrompt({
      taskId: "11111111-2222-4333-8444-555555555555",
      title: "Endpoint login",
      promptInstruction: "Buat POST /login.",
      status: "TODO",
      personaAlias: "bambang",
      role: "backend",
      targetRepo: "api",
      layout: "monorepo",
      folderHint: "apps/api",
    });
    expect(md).toContain("bambang");
    expect(md).toContain("11111111-2222-4333-8444-555555555555");
    expect(md).toContain("Buat POST /login.");
    expect(md).toContain("apps/api");
    expect(md).toContain("worktree");
    expect(md).toContain("pull_request");
  });

  it("menyertakan feedback revisi bila ada", () => {
    const md = renderTaskDelegatePrompt({
      taskId: "11111111-2222-4333-8444-555555555555",
      title: "Form",
      promptInstruction: "Buat form.",
      status: "REVISION_REQUESTED",
      reviewFeedback: "Tambah validasi email.",
      layout: "polyrepo",
    });
    expect(md).toContain("## Feedback revisi");
    expect(md).toContain("Tambah validasi email.");
    expect(md).not.toContain("Claim wajib mode worktree");
  });
});
