import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CommitShaSchema,
  SKILL_LIMITS,
  SkillContentSchema,
  SkillFrontmatterSchema,
  SkillNameSchema,
  skillPath,
} from "@catenext/shared";
import { parse, stringify } from "yaml";
import { isMissingFile } from "./config.js";
import { readRepoFile } from "./init/repo-files.js";
import { scrubText } from "./scrubber.js";

/** Repository skills live in Markdown files; the index exposes only names and usage hints. */
export const SKILLS_DIR = join(".catenext", "skills");

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

export interface Skill {
  name: string;
  when_to_use: string;
  updated_at: string;
  content: string;
}

export interface SkillIndexItem {
  name: string;
  when_to_use: string;
}

const exec = promisify(execFile);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkill(source: string, fileName: string): Skill {
  const m = FRONTMATTER.exec(source);
  if (!m) throw new SkillError(`${fileName}: tidak punya frontmatter YAML (--- ... ---).`);
  let raw: unknown;
  try {
    raw = parse(m[1] ?? "");
  } catch {
    throw new SkillError(`${fileName}: frontmatter bukan YAML valid.`);
  }
  const fm = SkillFrontmatterSchema.safeParse(raw);
  if (!fm.success) {
    const issues = fm.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new SkillError(`${fileName}: frontmatter tidak valid (${issues}).`);
  }
  return { ...fm.data, content: (m[2] ?? "").trim() };
}

export function renderSkill(skill: Skill): string {
  const fm = stringify({
    name: skill.name,
    when_to_use: skill.when_to_use,
    updated_at: skill.updated_at,
  }).trimEnd();
  return `---\n${fm}\n---\n\n${skill.content.trim()}\n`;
}

function checkSkill(source: string, file: string, skill: Skill): void {
  if (`${skill.name}.md` !== file) {
    throw new SkillError(`${file}: name harus sama dengan nama file.`);
  }
  const body = SkillContentSchema.safeParse(skill.content);
  if (!body.success)
    throw new SkillError(`${file}: ${body.error.issues.map((i) => i.message).join("; ")}.`);
  if (scrubText(source) !== source) {
    throw new SkillError(`${file}: potensi secret; hapus nilainya dan rujuk path saja.`);
  }
}

async function skillDirectoryExists(root: string): Promise<boolean> {
  try {
    for (const path of [".catenext", SKILLS_DIR]) {
      if (!(await lstat(join(root, path))).isDirectory()) {
        throw new SkillError(`${path}: harus folder biasa, bukan symlink.`);
      }
    }
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/** Semua skill valid di repo. File rusak dilewati dan dilaporkan lewat `invalid`. */
export async function listSkills(
  root: string,
): Promise<{ skills: Skill[]; invalid: { file: string; error: string }[] }> {
  const skills: Skill[] = [];
  const invalid: { file: string; error: string }[] = [];
  let files: string[];
  try {
    if (!(await skillDirectoryExists(root))) return { skills, invalid };
    files = await readdir(join(root, SKILLS_DIR));
  } catch {
    return {
      skills,
      invalid: [{ file: SKILLS_DIR, error: "Folder skill tidak dapat dibaca dengan aman." }],
    };
  }
  const candidates: { file: string; source: string; skill: Skill }[] = [];
  const nameCounts = new Map<string, number>();
  for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
    const label = scrubText(file);
    try {
      const source = await readRepoFile(root, join(SKILLS_DIR, file));
      if (source === null) throw new SkillError(`${label}: file tidak ditemukan.`);
      const skill = parseSkill(source, label);
      nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
      candidates.push({ file, source, skill });
    } catch (error) {
      invalid.push({
        file: label,
        error:
          error instanceof SkillError
            ? error.message
            : `${label}: file skill tidak dapat dibaca dengan aman.`,
      });
    }
  }
  for (const { file, source, skill } of candidates) {
    const label = scrubText(file);
    if ((nameCounts.get(skill.name) ?? 0) > 1) {
      invalid.push({ file: label, error: `${label}: name duplikat.` });
    }
    try {
      checkSkill(source, label, skill);
      if (nameCounts.get(skill.name) === 1) skills.push(skill);
    } catch (error) {
      if (!(error instanceof SkillError)) throw error;
      invalid.push({ file: label, error: error.message });
    }
  }
  return { skills, invalid };
}

export function skillIndex(skills: Skill[]): SkillIndexItem[] {
  return skills.map((s) => ({ name: s.name, when_to_use: s.when_to_use }));
}

export async function loadSkill(root: string, name: string, revision?: string): Promise<Skill> {
  const parsedName = SkillNameSchema.safeParse(name);
  if (!parsedName.success) throw new SkillError(`Nama skill "${name}" tidak valid.`);
  const file = `${parsedName.data}.md`;
  if (revision) {
    const sha = CommitShaSchema.safeParse(revision);
    if (!sha.success) throw new SkillError("Gunakan SHA commit Git lengkap untuk revisi skill.");
    let source: string;
    try {
      source = (
        await exec("git", ["show", `${sha.data}:${skillPath(parsedName.data)}`], { cwd: root })
      ).stdout;
    } catch {
      throw new SkillError(
        `Skill "${name}" tidak tersedia pada ${sha.data}. Fetch commit itu lalu coba kembali.`,
      );
    }
    const skill = parseSkill(source, file);
    checkSkill(source, file, skill);
    return skill;
  }
  const source = await readRepoFile(root, join(SKILLS_DIR, file));
  if (source === null) {
    const { skills } = await listSkills(root);
    const names = skills.map((s) => s.name).join(", ") || "(belum ada)";
    throw new SkillError(`Skill "${name}" tidak ada. Skill tersedia: ${names}.`);
  }
  const skill = parseSkill(source, file);
  checkSkill(source, file, skill);
  return skill;
}

/** Write a repository skill atomically (temporary file and rename). */
export async function saveSkill(
  root: string,
  input: { name: string; when_to_use: string; content: string },
  now: Date = new Date(),
): Promise<{ path: string; created: boolean; skill: Skill }> {
  const name = SkillNameSchema.parse(input.name);
  const content = SkillContentSchema.parse(input.content.trim());
  const when = input.when_to_use.trim();
  if (!when || when.length > SKILL_LIMITS.maxWhenToUseLength) {
    throw new SkillError(`when_to_use wajib, maks ${SKILL_LIMITS.maxWhenToUseLength} karakter.`);
  }
  const file = `${name}.md`;
  const skill: Skill = { name, when_to_use: when, updated_at: now.toISOString(), content };
  const source = renderSkill(skill);
  checkSkill(source, file, skill);
  const dir = join(root, SKILLS_DIR);
  if (!(await skillDirectoryExists(root))) await mkdir(dir, { recursive: true });
  const path = join(SKILLS_DIR, file);
  const target = join(root, path);
  const created = (await readRepoFile(root, path)) === null;
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
  return { path, created, skill };
}
