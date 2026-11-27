import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listSkills,
  loadSkill,
  parseSkill,
  removeSkill,
  renderSkill,
  saveSkill,
  skillCreate,
  skillList,
  skillRemove,
  skillSet,
  writeSkill,
} from "./skills.js";

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

  it("blocks loading or saving recognized credentials and omits YAML source from diagnostics", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skills-"));
    const saved = await saveSkill(root, {
      name: "api",
      when_to_use: "API work",
      content: "Run tests.",
    });
    const fixture = `ghp_${"X".repeat(24)}`;
    await writeFile(join(root, saved.path), renderSkill({ ...saved.skill, content: fixture }));
    await expect(loadSkill(root, "api")).rejects.toThrow(/potensi secret/);
    await expect(
      saveSkill(root, { name: "api", when_to_use: "API work", content: fixture }),
    ).rejects.toThrow(/potensi secret/);
    await writeFile(join(root, saved.path), `---\nname: [${fixture}\n---\nContent`);
    const { invalid } = await listSkills(root);
    expect(invalid).toEqual([{ file: "api.md", error: "api.md: frontmatter bukan YAML valid." }]);
    expect(JSON.stringify(invalid)).not.toContain(fixture);
  });

  it("menolak nama yang mencoba keluar dari folder skills", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skills-"));
    await expect(loadSkill(root, "../config")).rejects.toThrow(/tidak valid/);
    await expect(
      saveSkill(root, { name: "../x", when_to_use: "x", content: "y" }),
    ).rejects.toThrow();
  });

  it("writeSkill sama dengan saveSkill dan removeSkill menghapus file", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skills-"));
    const saved = await writeSkill(root, { name: "tmp", when_to_use: "uji", content: "isi" });
    expect(saved.created).toBe(true);
    await removeSkill(root, "tmp");
    await expect(loadSkill(root, "tmp")).rejects.toThrow(/tidak ada/);
  });

  it("CLI create/set/remove/list", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skills-"));
    const body = join(root, "body.md");
    await writeFile(body, "Instruksi singkat.");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      logs.push(String(line));
    });
    try {
      await skillCreate(root, "guide", { whenToUse: "Saat onboarding", file: body });
      expect(logs.at(-1)).toMatch(/dibuat/);
      logs.length = 0;
      await expect(skillCreate(root, "guide", { whenToUse: "lagi", file: body })).rejects.toThrow(
        /sudah ada/,
      );
      await writeFile(body, "Instruksi diperbarui.");
      await skillSet(root, "guide", { file: body });
      expect(logs.at(-1)).toMatch(/diperbarui/);
      await skillList(root, { json: true });
      const listLine = logs.at(-1);
      expect(listLine).toBeDefined();
      expect(JSON.parse(listLine ?? "")).toMatchObject({
        skills: [{ name: "guide", when_to_use: "Saat onboarding" }],
      });
      await skillRemove(root, "guide", { json: true });
      const removeLine = logs.at(-1);
      expect(removeLine).toBeDefined();
      expect(JSON.parse(removeLine ?? "")).toEqual({
        path: join(".catenext", "skills", "guide.md"),
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("skill set menolak update tanpa argumen pada skill yang ada", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skills-"));
    await saveSkill(root, { name: "x", when_to_use: "a", content: "b" });
    await expect(skillSet(root, "x", {})).rejects.toThrow(/--when-to-use/);
  });
});
