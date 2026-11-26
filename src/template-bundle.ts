import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  AgentAliasSchema,
  type CatenextConfig,
  PersonaReposSchema,
  RoleSchema,
  SKILL_LIMITS,
  SkillContentSchema,
  SkillNameSchema,
} from "@catenext/shared";
import { z } from "zod";
import type { LocalService } from "./local-service.js";
import { readJsonInput } from "./planning.js";
import { describeRedactions, scrubDeep, scrubText } from "./scrubber.js";
import { listSkills, type Skill, saveSkill } from "./skills.js";

/** Cross-project persona + repo-skill portable bundle (not epic templates). */
export const TEMPLATE_BUNDLE_KIND = "catenext.persona-skills" as const;
export const TEMPLATE_BUNDLE_SCHEMA_VERSION = 1 as const;

const TemplatePersonaSchema = z.object({
  alias: AgentAliasSchema,
  role: RoleSchema,
  rules: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  repos: PersonaReposSchema.default([]),
});

const TemplateSkillSchema = z.object({
  name: SkillNameSchema,
  when_to_use: z.string().trim().min(1).max(SKILL_LIMITS.maxWhenToUseLength),
  content: SkillContentSchema,
});

export const TemplateBundleSchema = z.object({
  kind: z.literal(TEMPLATE_BUNDLE_KIND),
  schema_version: z.literal(TEMPLATE_BUNDLE_SCHEMA_VERSION),
  exported_at: z.string().min(1),
  source: z
    .object({
      project_name: z.string().min(1).max(120).optional(),
      repo_name: z.string().min(1).max(64).optional(),
    })
    .optional(),
  personas: z.array(TemplatePersonaSchema).max(50),
  skills: z.array(TemplateSkillSchema).max(100),
});

export type TemplateBundle = z.infer<typeof TemplateBundleSchema>;
export type TemplatePersona = z.infer<typeof TemplatePersonaSchema>;
export type TemplateSkill = z.infer<typeof TemplateSkillSchema>;

const SKIP_KEYS = new Set([
  "kind",
  "schema_version",
  "exported_at",
  "alias",
  "role",
  "repos",
  "name",
  "project_name",
  "repo_name",
]);

export class TemplateBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateBundleError";
  }
}

function scrubBundle<T>(value: T): { value: T; total: number; redactions: Record<string, number> } {
  return scrubDeep(value, SKIP_KEYS);
}

/** Build a scrubbed portable bundle from the current project. */
export async function buildTemplateBundle(
  service: LocalService,
  root: string,
  config: CatenextConfig,
  now: Date = new Date(),
): Promise<{ bundle: TemplateBundle; redacted: number; redactions: Record<string, number> }> {
  const [{ personas }, { skills, invalid }] = await Promise.all([
    service.callTool("list_personas", {}),
    listSkills(root),
  ]);
  if (invalid.length > 0) {
    const sample = invalid
      .slice(0, 3)
      .map((row) => row.error)
      .join("; ");
    throw new TemplateBundleError(
      `Ada ${invalid.length} skill lokal tidak valid; perbaiki dulu sebelum export (${sample}).`,
    );
  }
  const draft = {
    kind: TEMPLATE_BUNDLE_KIND,
    schema_version: TEMPLATE_BUNDLE_SCHEMA_VERSION,
    exported_at: now.toISOString(),
    source: {
      ...(config.project_name ? { project_name: config.project_name } : {}),
      repo_name: config.repo_name,
    },
    personas: personas.map((p) => ({
      alias: p.alias,
      role: p.role,
      rules: p.rules,
      repos: p.repos,
    })),
    skills: skills.map((s) => ({
      name: s.name,
      when_to_use: s.when_to_use,
      content: s.content,
    })),
  };
  const scrubbed = scrubBundle(draft);
  const parsed = TemplateBundleSchema.safeParse(scrubbed.value);
  if (!parsed.success) {
    throw new TemplateBundleError(
      `Bundle export tidak valid setelah scrub: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return { bundle: parsed.data, redacted: scrubbed.total, redactions: scrubbed.redactions };
}

export async function writeTemplateBundle(path: string, bundle: TemplateBundle): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

/** Parse + scrub an import payload (file path or raw object). */
export async function loadTemplateBundle(file: string): Promise<{
  bundle: TemplateBundle;
  redacted: number;
  redactions: Record<string, number>;
}> {
  const raw = await readJsonInput(file);
  const scrubbed = scrubBundle(raw);
  const parsed = TemplateBundleSchema.safeParse(scrubbed.value);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new TemplateBundleError(`Template bundle tidak valid:\n${lines.join("\n")}`);
  }
  for (const p of parsed.data.personas) {
    for (const rule of p.rules) {
      if (scrubText(rule) !== rule) {
        throw new TemplateBundleError(
          `Persona "${p.alias}" masih berisi potensi secret di rules setelah scrub.`,
        );
      }
    }
  }
  for (const skill of parsed.data.skills) {
    const joined = `${skill.when_to_use}\n${skill.content}`;
    if (scrubText(joined) !== joined) {
      throw new TemplateBundleError(
        `Skill "${skill.name}" masih berisi potensi secret setelah scrub.`,
      );
    }
  }
  return { bundle: parsed.data, redacted: scrubbed.total, redactions: scrubbed.redactions };
}

export type TemplateImportOptions = {
  personas?: boolean;
  skills?: boolean;
  dryRun?: boolean;
};

export type TemplateImportResult = {
  personas: { created: string[]; updated: string[] };
  skills: { created: string[]; updated: string[] };
  dry_run: boolean;
  redacted: number;
};

/** Apply a scrubbed bundle into the current project (upsert personas + save skills). */
export async function importTemplateBundle(
  service: LocalService,
  root: string,
  bundle: TemplateBundle,
  opts: TemplateImportOptions = {},
): Promise<TemplateImportResult> {
  const wantPersonas = opts.personas !== false;
  const wantSkills = opts.skills !== false;
  if (!wantPersonas && !wantSkills) {
    throw new TemplateBundleError("Pilih setidaknya personas atau skills untuk diimpor.");
  }
  const result: TemplateImportResult = {
    personas: { created: [], updated: [] },
    skills: { created: [], updated: [] },
    dry_run: Boolean(opts.dryRun),
    redacted: 0,
  };

  if (wantPersonas) {
    const listed = opts.dryRun ? await service.callTool("list_personas", {}) : null;
    for (const persona of bundle.personas) {
      if (opts.dryRun) {
        const existing = listed?.personas.find((p) => p.alias === persona.alias);
        if (existing) result.personas.updated.push(persona.alias);
        else result.personas.created.push(persona.alias);
        continue;
      }
      const res = await service.callTool("upsert_persona", {
        alias: persona.alias,
        role: persona.role,
        rules: persona.rules,
        repos: persona.repos,
      });
      if (res.created) result.personas.created.push(persona.alias);
      else result.personas.updated.push(persona.alias);
    }
  }

  if (wantSkills) {
    const existingNames = opts.dryRun
      ? new Set((await listSkills(root)).skills.map((s) => s.name))
      : null;
    for (const skill of bundle.skills) {
      if (opts.dryRun) {
        if (existingNames?.has(skill.name)) result.skills.updated.push(skill.name);
        else result.skills.created.push(skill.name);
        continue;
      }
      const saved = await saveSkill(root, {
        name: skill.name,
        when_to_use: skill.when_to_use,
        content: skill.content,
      });
      if (saved.created) result.skills.created.push(skill.name);
      else result.skills.updated.push(skill.name);
    }
  }

  return result;
}

export function formatImportSummary(res: TemplateImportResult): string {
  const prefix = res.dry_run ? "(dry-run) " : "";
  const parts = [
    `personas +${res.personas.created.length}/~${res.personas.updated.length}`,
    `skills +${res.skills.created.length}/~${res.skills.updated.length}`,
  ];
  return `${prefix}✓ Template diimpor (${parts.join(", ")}).`;
}

export function warnRedactions(total: number, redactions: Record<string, number>): void {
  if (total <= 0) return;
  console.error(`! ${describeRedactions({ redactions, total })}`);
}

/** Re-export skill type for tests. */
export type { Skill };
