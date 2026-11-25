import { describe, expect, it } from "vitest";
import {
  CatenextConfigSchema,
  CONFIG_SCHEMA_VERSION,
  checkConfigCompatibility,
  SaveRepoSkillInput,
  SkillContentSchema,
  skillPath,
} from "../index.js";

describe("CatenextConfigSchema", () => {
  it("menerima config minimal dan mengisi default stack", () => {
    const cfg = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
      repo_name: "backend",
    });
    expect(cfg.stack).toEqual([]);
  });

  it("menolak repo_name bukan slug", () => {
    expect(
      CatenextConfigSchema.safeParse({
        schema_version: 1,
        project_id: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
        repo_name: "My Backend",
      }).success,
    ).toBe(false);
  });

  it("cek kompatibilitas schema_version", () => {
    expect(checkConfigCompatibility(CONFIG_SCHEMA_VERSION)).toEqual({ ok: true });
    expect(checkConfigCompatibility(CONFIG_SCHEMA_VERSION + 1)).toMatchObject({
      ok: false,
      reason: "too_new",
    });
  });
});

describe("skill", () => {
  it("membatasi 500 kata", () => {
    expect(SkillContentSchema.safeParse("kata ".repeat(500)).success).toBe(true);
    expect(SkillContentSchema.safeParse("kata ".repeat(501)).success).toBe(false);
  });

  it("menolak code dump", () => {
    const dump = `\`\`\`ts\n${"const a = 1;\n".repeat(20)}\`\`\``;
    expect(SkillContentSchema.safeParse(dump).success).toBe(false);
    expect(SkillContentSchema.safeParse("Tes: \n```\npnpm test\n```").success).toBe(true);
  });

  it("save_repo_skill memvalidasi nama sebagai slug dan path tetap di .catenext/skills", () => {
    expect(
      SaveRepoSkillInput.safeParse({ name: "../etc/passwd", when_to_use: "x", content: "y" })
        .success,
    ).toBe(false);
    expect(skillPath("create-endpoint")).toBe(".catenext/skills/create-endpoint.md");
    expect(() => skillPath("../evil")).toThrow();
  });
});
