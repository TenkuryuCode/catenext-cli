import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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

/**
 * Skill repo 2-tier: file Markdown lokal di .catenext/skills/<name>.md (isi lengkap,
 * tidak pernah dikirim ke Cloud) + indeks ringan (name, when_to_use) yang disinkronkan.
 */
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
  } catch (err) {
    throw new SkillError(`${fileName}: frontmatter bukan YAML valid: ${(err as Error).message}`);
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

/** Semua skill valid di repo. File rusak dilewati dan dilaporkan lewat `invalid`. */
export async function listSkills(
  root: string,
): Promise<{ skills: Skill[]; invalid: { file: string; error: string }[] }> {
  let files: string[];
  try {
    files = await readdir(join(root, SKILLS_DIR));
  } catch {
    return { skills: [], invalid: [] };
  }
  const skills: Skill[] = [];
  const invalid: { file: string; error: string }[] = [];
  for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
    try {
      const skill = parseSkill(await readFile(join(root, SKILLS_DIR, file), "utf8"), file);
      if (`${skill.name}.md` !== file) {
        throw new SkillError(`${file}: name "${skill.name}" harus sama dengan nama file.`);
      }
      skills.push(skill);
    } catch (err) {
      invalid.push({ file, error: (err as Error).message });
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
    if (skill.name !== name) throw new SkillError(`${file}: name harus sama dengan nama file.`);
    return skill;
  }
  let source: string;
  try {
    source = await readFile(join(root, SKILLS_DIR, file), "utf8");
  } catch {
    const { skills } = await listSkills(root);
    const names = skills.map((s) => s.name).join(", ") || "(belum ada)";
    throw new SkillError(`Skill "${name}" tidak ada. Skill tersedia: ${names}.`);
  }
  return parseSkill(source, file);
}

/**
 * Tulis skill secara atomik (tmp + rename). Satu-satunya area tulis agen di .catenext/.
 */
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
  const dir = join(root, SKILLS_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${name}.md`);
  let created = true;
  try {
    await readFile(target);
    created = false;
  } catch {}
  const skill: Skill = { name, when_to_use: when, updated_at: now.toISOString(), content };
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, renderSkill(skill), "utf8");
  await rename(tmp, target);
  return { path: join(SKILLS_DIR, `${name}.md`), created, skill };
}

export async function committedSkillIndex(root: string, previous: string | null) {
  const config = { cwd: root };
  const branchRef = (
    await exec("git", ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], config).catch(() => null)
  )?.stdout.trim();
  const branch = (
    await exec("git", ["symbolic-ref", "-q", "HEAD"], config).catch(() => null)
  )?.stdout.trim();
  if (
    !branchRef?.startsWith("refs/remotes/origin/") ||
    branch !== `refs/heads/${branchRef.slice("refs/remotes/origin/".length)}`
  )
    return null;
  const revision = CommitShaSchema.parse(
    (await exec("git", ["rev-parse", branchRef], config)).stdout.trim(),
  );
  const head = (await exec("git", ["rev-parse", "HEAD"], config)).stdout.trim();
  if (head !== revision) return null;
  if (
    previous &&
    previous !== revision &&
    !(await exec("git", ["merge-base", "--is-ancestor", previous, revision], config).catch(
      () => null,
    ))
  ) {
    throw new SkillError(
      "Revisi Git lokal tertinggal dari indeks Cloud. Fetch branch utama lalu coba lagi.",
    );
  }
  const names = (
    await exec("git", ["ls-tree", "-rz", "--name-only", revision, "--", SKILLS_DIR], config)
  ).stdout
    .split("\0")
    .flatMap((path) => {
      const file = /^\.catenext\/skills\/([^/]+)\.md$/.exec(path);
      return file?.[1] ? [file[1]] : [];
    });
  const skills: Skill[] = [];
  const invalid: { file: string; error: string }[] = [];
  for (const name of names) {
    try {
      skills.push(await loadSkill(root, name, revision));
    } catch (err) {
      invalid.push({ file: `${name}.md`, error: (err as Error).message });
    }
  }
  return { revision, skills: skillIndex(skills), invalid };
}
