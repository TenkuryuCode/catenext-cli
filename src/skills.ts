import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
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

/** Alias historis untuk `saveSkill` (CLI create/set dan MCP `save_repo_skill`). */
export const writeSkill = saveSkill;

export async function removeSkill(root: string, name: string): Promise<{ path: string }> {
  const parsedName = SkillNameSchema.safeParse(name);
  if (!parsedName.success) throw new SkillError(`Nama skill "${name}" tidak valid.`);
  const path = join(SKILLS_DIR, `${parsedName.data}.md`);
  const source = await readRepoFile(root, path);
  if (source === null) {
    const { skills } = await listSkills(root);
    const names = skills.map((s) => s.name).join(", ") || "(belum ada)";
    throw new SkillError(`Skill "${name}" tidak ada. Skill tersedia: ${names}.`);
  }
  await unlink(join(root, path));
  return { path };
}

async function readSkillBody(file: string): Promise<string> {
  return (await readFile(file, "utf8")).trim();
}

/** `catenext skill list` */
export async function skillList(root: string, opts: { json?: boolean }): Promise<void> {
  const { skills, invalid } = await listSkills(root);
  const index = skillIndex(skills);
  if (opts.json) {
    console.log(JSON.stringify({ skills: index, invalid }, null, 2));
    return;
  }
  if (index.length === 0 && invalid.length === 0) {
    console.log(
      'Belum ada skill. Buat dengan: catenext skill create <name> --when-to-use "..." --file <path.md>',
    );
    return;
  }
  for (const s of index) console.log(`${s.name}  ${s.when_to_use}`);
  for (const i of invalid) console.log(`! Skill dilewati: ${i.error}`);
}

/** `catenext skill create` — gagal bila file sudah ada. */
export async function skillCreate(
  root: string,
  name: string,
  opts: { whenToUse: string; file: string; json?: boolean },
): Promise<void> {
  const parsedName = SkillNameSchema.parse(name);
  const path = join(SKILLS_DIR, `${parsedName}.md`);
  if ((await readRepoFile(root, path)) !== null) {
    throw new SkillError(`Skill "${name}" sudah ada. Gunakan: catenext skill set ${name} ...`);
  }
  const content = await readSkillBody(opts.file);
  const saved = await writeSkill(root, {
    name: parsedName,
    when_to_use: opts.whenToUse,
    content,
  });
  if (opts.json) {
    console.log(
      JSON.stringify({ path: saved.path, created: saved.created, skill: saved.skill }, null, 2),
    );
    return;
  }
  console.log(`✓ Skill "${saved.skill.name}" dibuat di ${saved.path}.`);
}

/** `catenext skill set` — buat atau perbarui; field yang tidak diisi dipertahankan. */
export async function skillSet(
  root: string,
  name: string,
  opts: { whenToUse?: string; file?: string; json?: boolean },
): Promise<void> {
  const parsedName = SkillNameSchema.parse(name);
  const path = join(SKILLS_DIR, `${parsedName}.md`);
  const whenOpt = opts.whenToUse?.trim();
  const contentOpt = opts.file ? await readSkillBody(opts.file) : undefined;
  const source = await readRepoFile(root, path);
  let when = whenOpt;
  let content = contentOpt;
  if (source === null) {
    if (!when || content === undefined) {
      throw new SkillError(
        `Skill "${name}" belum ada. Wajib --when-to-use dan --file, atau: catenext skill create ${name} ...`,
      );
    }
  } else {
    if (!when && content === undefined) {
      throw new SkillError("Berikan --when-to-use dan/atau --file untuk memperbarui skill.");
    }
    const existing = parseSkill(source, `${parsedName}.md`);
    when = when ?? existing.when_to_use;
    content = content ?? existing.content;
  }
  if (!when || content === undefined) {
    throw new SkillError("Isi skill tidak lengkap.");
  }
  const saved = await writeSkill(root, {
    name: parsedName,
    when_to_use: when,
    content,
  });
  if (opts.json) {
    console.log(
      JSON.stringify({ path: saved.path, created: saved.created, skill: saved.skill }, null, 2),
    );
    return;
  }
  console.log(
    `✓ Skill "${saved.skill.name}" ${saved.created ? "dibuat" : "diperbarui"} di ${saved.path}.`,
  );
}

/** `catenext skill remove` */
export async function skillRemove(
  root: string,
  name: string,
  opts: { json?: boolean },
): Promise<void> {
  const removed = await removeSkill(root, name);
  if (opts.json) {
    console.log(JSON.stringify(removed, null, 2));
    return;
  }
  console.log(`✓ Skill "${name}" dihapus (${removed.path}).`);
}
