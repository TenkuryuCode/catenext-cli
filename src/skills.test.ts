import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSkills, loadSkill, parseSkill, renderSkill, saveSkill } from "./skills.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("skills lokal", () => {
  it("render lalu parse menghasilkan skill yang sama", () => {
    const skill = {
      name: "api-style",
      when_to_use: "Saat menambah route: ikuti pola Hono",
      updated_at: "2026-11-25T00:00:00.000Z",
      content: "Route ada di `apps/api/src/routes`.",
    };
    expect(parseSkill(renderSkill(skill), "api-style.md")).toEqual(skill);
  });

  it("save menandai created lalu update, dan list melewati file rusak", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skills-"));
    const first = await saveSkill(root, { name: "a", when_to_use: "x", content: "satu" });
    const second = await saveSkill(root, { name: "a", when_to_use: "y", content: "dua" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    await writeFile(join(root, ".catenext/skills/rusak.md"), "tanpa frontmatter");
    await mkdir(join(root, ".catenext/skills/sub"), { recursive: true });
    const { skills, invalid } = await listSkills(root);
    expect(skills.map((s) => [s.name, s.when_to_use])).toEqual([["a", "y"]]);
    expect(invalid.map((i) => i.file)).toEqual(["rusak.md"]);
    expect((await loadSkill(root, "a")).content).toBe("dua");
  });

  it("menolak nama yang mencoba keluar dari folder skills", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skills-"));
    await expect(loadSkill(root, "../config")).rejects.toThrow(/tidak valid/);
    await expect(
      saveSkill(root, { name: "../x", when_to_use: "x", content: "y" }),
    ).rejects.toThrow();
  });
});
