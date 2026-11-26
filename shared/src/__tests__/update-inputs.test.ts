import { describe, expect, it } from "vitest";
import {
  SetDependenciesInput,
  UpdateEpicInput,
  UpdatePersonaInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "../api.js";
import { SessionBriefOutput } from "../brief.js";
import { GetProjectContextOutput } from "../mcp-tools.js";

// PATCH parsial tidak boleh mengisi field yang tidak dikirim dengan nilai default.
describe("skema update parsial", () => {
  it("UpdateProjectInput hanya berisi field yang dikirim", () => {
    expect(UpdateProjectInput.parse({ name: "Nama baru" })).toEqual({ name: "Nama baru" });
  });

  it("UpdateProjectInput menolak nama kosong", () => {
    expect(UpdateProjectInput.safeParse({ name: "   " }).success).toBe(false);
  });

  it("UpdatePersonaInput tidak mengosongkan rules saat hanya role diubah", () => {
    expect(UpdatePersonaInput.parse({ role: "backend" })).toEqual({ role: "backend" });
  });

  it("UpdateEpicInput hanya berisi field yang dikirim", () => {
    expect(UpdateEpicInput.parse({ title: "Epic baru" })).toEqual({ title: "Epic baru" });
  });

  it("UpdateTaskInput hanya berisi field yang dikirim dan hanya menerima is_stale=false", () => {
    expect(UpdateTaskInput.parse({ title: "Judul baru", is_stale: false, persona: "be" })).toEqual({
      title: "Judul baru",
      is_stale: false,
      persona: "be",
    });
    expect(UpdateTaskInput.safeParse({ is_stale: true }).success).toBe(false);
  });

  it("SetDependenciesInput memvalidasi array UUID", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(SetDependenciesInput.parse({ depends_on: [id] })).toEqual({ depends_on: [id] });
    expect(SetDependenciesInput.safeParse({ depends_on: ["not-a-uuid"] }).success).toBe(false);
  });

  it("SessionBriefOutput dan GetProjectContextOutput mendukung locale opsional", () => {
    const baseBrief = {
      lines: [],
      ready_count: 0,
      blocked_count: 0,
      draft_count: 0,
    };
    expect(SessionBriefOutput.parse(baseBrief).locale).toBeUndefined();
    expect(SessionBriefOutput.parse({ ...baseBrief, locale: "id" }).locale).toBe("id");

    const baseCtx = {
      project: {
        id: "11111111-2222-4333-8444-555555555555",
        name: "app",
        repo_name: "be",
        stack: [],
      },
      directives: [],
      skills: [],
      recent_handoffs: [],
    };
    expect(GetProjectContextOutput.parse(baseCtx).locale).toBeUndefined();
    expect(GetProjectContextOutput.parse({ ...baseCtx, locale: "en" }).locale).toBe("en");
  });
});
