import type { Dirent, Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type PlatformId,
  SKILL_LIMITS,
  type SkillCatalogKey,
  type SkillIndexEntry,
  SkillNameSchema,
  type SkillSourceId,
  type SkillSourceKind,
} from "@catenext/shared";
import { parse } from "yaml";
import { isMissingFile } from "./config.js";
import { scrubText } from "./scrubber.js";
import { listSkills, loadSkill, SKILLS_DIR, type Skill, SkillError } from "./skills.js";

export type SkillSourcePlatform = PlatformId | "catenext" | "agents";
export type NativeSkillFormat = "catenext-md" | "skill-dir" | "flat-md";

export interface SkillDiscoveryRootSpec {
  readonly sourceId: SkillSourceId;
  readonly sourceKind: SkillSourceKind;
  readonly platform: SkillSourcePlatform;
  /** Precedence rank (lower = higher precedence for default resolution). */
  readonly precedence: number;
  readonly relativeDir: string;
  readonly displayDir: string;
  readonly allowFlatMd: boolean;
  readonly allowNestedSkillMd: boolean;
  readonly maxDepth: number;
}

export interface DiscoveredSkillSourceReport {
  readonly source_id: SkillSourceId;
  readonly source_kind: SkillSourceKind;
  readonly platform: SkillSourcePlatform;
  readonly root_path: string;
  readonly exists: boolean;
  readonly discovered_count: number;
  readonly skipped_count: number;
}

export interface DiscoveredSkillEntry {
  readonly catalog_key: SkillCatalogKey;
  readonly name: string;
  readonly display_name?: string;
  readonly when_to_use: string;
  readonly source_id: SkillSourceId;
  readonly source_kind: SkillSourceKind;
  readonly platform: SkillSourcePlatform;
  readonly format: NativeSkillFormat;
  readonly source_path: string;
  readonly collision: boolean;
  readonly collision_sources?: readonly SkillSourceId[];
  readonly updated_at?: string;
  readonly disable_model_invocation?: boolean;
}

export interface SkillCatalogSkip {
  readonly source_id: SkillSourceId;
  readonly path: string;
  readonly reason: string;
}

export interface SkillCatalogResult {
  readonly entries: DiscoveredSkillEntry[];
  readonly sources: DiscoveredSkillSourceReport[];
  readonly collisions: Array<{
    readonly name: string;
    readonly sources: SkillSourceId[];
  }>;
  readonly skipped: SkillCatalogSkip[];
  readonly truncated: boolean;
}

export interface DiscoverSkillsOptions {
  readonly platforms?: readonly PlatformId[];
  /** Explicit opt-in required before inspecting any user/global skill directory. */
  readonly includeUserGlobal?: boolean;
  /** Optional home directory override for deterministic testing. */
  readonly homeDir?: string;
  /** Optional explicit user/global source roots (must stay under homeDir). */
  readonly userGlobalSources?: readonly SkillSourceId[];
  /** Cap catalog entries returned (defaults to SKILL_LIMITS.maxCatalogEntries). */
  readonly maxEntries?: number;
}

export interface LoadedCatalogSkill extends Skill {
  readonly catalog_key: SkillCatalogKey;
  readonly source_id: SkillSourceId;
  readonly source_kind: SkillSourceKind;
  readonly source_path: string;
  readonly collision: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const RESERVED_NAMES = new Set(["synced", "anthropic-skills"]);

const PROJECT_SPECS: readonly SkillDiscoveryRootSpec[] = [
  {
    sourceId: "repo:.catenext/skills",
    sourceKind: "repo",
    platform: "catenext",
    precedence: 0,
    relativeDir: SKILLS_DIR,
    displayDir: ".catenext/skills",
    allowFlatMd: true,
    allowNestedSkillMd: false,
    maxDepth: 1,
  },
  {
    sourceId: "opencode:project:.opencode/skills",
    sourceKind: "project",
    platform: "opencode",
    precedence: 10,
    relativeDir: join(".opencode", "skills"),
    displayDir: ".opencode/skills",
    allowFlatMd: true,
    allowNestedSkillMd: true,
    maxDepth: SKILL_LIMITS.maxDiscoveryDepth,
  },
  {
    sourceId: "claude-code:project:.claude/skills",
    sourceKind: "project",
    platform: "claude-code",
    precedence: 20,
    relativeDir: join(".claude", "skills"),
    displayDir: ".claude/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
  {
    sourceId: "cursor:project:.cursor/skills",
    sourceKind: "project",
    platform: "cursor",
    precedence: 30,
    relativeDir: join(".cursor", "skills"),
    displayDir: ".cursor/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
  {
    sourceId: "vscode:project:.github/skills",
    sourceKind: "project",
    platform: "vscode",
    precedence: 40,
    relativeDir: join(".github", "skills"),
    displayDir: ".github/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
  {
    sourceId: "agents:project:.agents/skills",
    sourceKind: "project",
    platform: "agents",
    precedence: 50,
    relativeDir: join(".agents", "skills"),
    displayDir: ".agents/skills",
    allowFlatMd: true,
    allowNestedSkillMd: true,
    maxDepth: SKILL_LIMITS.maxDiscoveryDepth,
  },
  {
    sourceId: "antigravity:project:.agent/skills",
    sourceKind: "project",
    platform: "antigravity",
    precedence: 60,
    relativeDir: join(".agent", "skills"),
    displayDir: ".agent/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
  {
    sourceId: "windsurf:project:.windsurf/skills",
    sourceKind: "project",
    platform: "windsurf",
    precedence: 70,
    relativeDir: join(".windsurf", "skills"),
    displayDir: ".windsurf/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
];

const USER_GLOBAL_SPECS: readonly SkillDiscoveryRootSpec[] = [
  {
    sourceId: "opencode:user:.config/opencode/skills",
    sourceKind: "user",
    platform: "opencode",
    precedence: 110,
    relativeDir: join(".config", "opencode", "skills"),
    displayDir: "~/.config/opencode/skills",
    allowFlatMd: true,
    allowNestedSkillMd: true,
    maxDepth: SKILL_LIMITS.maxDiscoveryDepth,
  },
  {
    sourceId: "claude-code:user:.claude/skills",
    sourceKind: "user",
    platform: "claude-code",
    precedence: 120,
    relativeDir: join(".claude", "skills"),
    displayDir: "~/.claude/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
  {
    sourceId: "cursor:user:.cursor/skills",
    sourceKind: "user",
    platform: "cursor",
    precedence: 130,
    relativeDir: join(".cursor", "skills"),
    displayDir: "~/.cursor/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
  {
    sourceId: "vscode:user:.copilot/skills",
    sourceKind: "user",
    platform: "vscode",
    precedence: 140,
    relativeDir: join(".copilot", "skills"),
    displayDir: "~/.copilot/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
  {
    sourceId: "agents:user:.agents/skills",
    sourceKind: "user",
    platform: "agents",
    precedence: 150,
    relativeDir: join(".agents", "skills"),
    displayDir: "~/.agents/skills",
    allowFlatMd: true,
    allowNestedSkillMd: true,
    maxDepth: SKILL_LIMITS.maxDiscoveryDepth,
  },
  {
    sourceId: "antigravity:user:.gemini/config/skills",
    sourceKind: "user",
    platform: "antigravity",
    precedence: 160,
    relativeDir: join(".gemini", "config", "skills"),
    displayDir: "~/.gemini/config/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
  {
    sourceId: "antigravity:user:.gemini/antigravity/skills",
    sourceKind: "user",
    platform: "antigravity",
    precedence: 165,
    relativeDir: join(".gemini", "antigravity", "skills"),
    displayDir: "~/.gemini/antigravity/skills",
    allowFlatMd: false,
    allowNestedSkillMd: false,
    maxDepth: 2,
  },
];

const PLATFORM_PROJECT_SOURCES: Record<PlatformId, readonly SkillSourceId[]> = {
  "claude-code": ["claude-code:project:.claude/skills", "agents:project:.agents/skills"],
  cursor: [
    "cursor:project:.cursor/skills",
    "agents:project:.agents/skills",
    "claude-code:project:.claude/skills",
  ],
  codex: ["agents:project:.agents/skills"],
  antigravity: ["agents:project:.agents/skills", "antigravity:project:.agent/skills"],
  opencode: [
    "opencode:project:.opencode/skills",
    "claude-code:project:.claude/skills",
    "agents:project:.agents/skills",
  ],
  windsurf: ["agents:project:.agents/skills", "windsurf:project:.windsurf/skills"],
  vscode: [
    "vscode:project:.github/skills",
    "claude-code:project:.claude/skills",
    "agents:project:.agents/skills",
  ],
};

const PLATFORM_USER_SOURCES: Record<PlatformId, readonly SkillSourceId[]> = {
  "claude-code": ["claude-code:user:.claude/skills"],
  cursor: [
    "cursor:user:.cursor/skills",
    "agents:user:.agents/skills",
    "claude-code:user:.claude/skills",
  ],
  codex: ["agents:user:.agents/skills"],
  antigravity: [
    "antigravity:user:.gemini/config/skills",
    "antigravity:user:.gemini/antigravity/skills",
    "agents:user:.agents/skills",
  ],
  opencode: [
    "opencode:user:.config/opencode/skills",
    "claude-code:user:.claude/skills",
    "agents:user:.agents/skills",
  ],
  windsurf: ["agents:user:.agents/skills"],
  vscode: [
    "vscode:user:.copilot/skills",
    "claude-code:user:.claude/skills",
    "agents:user:.agents/skills",
  ],
};

export function selectSkillDiscoverySpecs(
  options: DiscoverSkillsOptions = {},
): SkillDiscoveryRootSpec[] {
  const platforms = options.platforms;
  const allowedProjectIds = new Set<SkillSourceId>(["repo:.catenext/skills"]);
  if (!platforms || platforms.length === 0) {
    for (const spec of PROJECT_SPECS) allowedProjectIds.add(spec.sourceId);
  } else {
    for (const platform of platforms) {
      for (const id of PLATFORM_PROJECT_SOURCES[platform] ?? []) {
        allowedProjectIds.add(id);
      }
    }
  }
  const selected = PROJECT_SPECS.filter((spec) => allowedProjectIds.has(spec.sourceId));

  if (options.includeUserGlobal) {
    const allowedUserIds = new Set<SkillSourceId>();
    if (options.userGlobalSources?.length) {
      for (const id of options.userGlobalSources) allowedUserIds.add(id);
    } else if (!platforms || platforms.length === 0) {
      for (const spec of USER_GLOBAL_SPECS) allowedUserIds.add(spec.sourceId);
    } else {
      for (const platform of platforms) {
        for (const id of PLATFORM_USER_SOURCES[platform] ?? []) {
          allowedUserIds.add(id);
        }
      }
    }
    for (const spec of USER_GLOBAL_SPECS) {
      if (allowedUserIds.has(spec.sourceId)) selected.push(spec);
    }
  }

  return selected.sort((a, b) => a.precedence - b.precedence);
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function normalizeSlugCandidate(raw: string): string | null {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!normalized || RESERVED_NAMES.has(normalized)) return null;
  const parsed = SkillNameSchema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

function sanitizeSummary(raw: string): string {
  const clean = scrubText(raw)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (clean.length <= SKILL_LIMITS.maxWhenToUseLength) return clean;
  return `${clean.slice(0, SKILL_LIMITS.maxWhenToUseLength - 1).trimEnd()}…`;
}

function firstParagraphLine(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```") || trimmed.startsWith("!"))
      continue;
    return trimmed;
  }
  return "";
}

interface ParsedNativeSkill {
  readonly name: string;
  readonly displayName?: string;
  readonly whenToUse: string;
  readonly content: string;
  readonly updatedAt?: string;
  readonly disableModelInvocation?: boolean;
}

function parseNativeSkillMarkdown(
  source: string,
  derivedId: string,
  fileLabel: string,
): ParsedNativeSkill {
  let frontmatterRaw: Record<string, unknown> = {};
  let body = source;
  if (source.startsWith("---\n") || source.startsWith("---\r\n")) {
    const match = FRONTMATTER.exec(source);
    if (!match) {
      throw new SkillError(`${fileLabel}: frontmatter YAML tidak tertutup.`);
    }
    try {
      const parsed = parse(match[1] ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatterRaw = parsed as Record<string, unknown>;
      } else if (parsed !== null && parsed !== undefined) {
        throw new SkillError(`${fileLabel}: frontmatter harus objek YAML.`);
      }
    } catch (error) {
      if (error instanceof SkillError) throw error;
      throw new SkillError(`${fileLabel}: frontmatter bukan YAML valid.`);
    }
    body = match[2] ?? "";
  }

  const trimmedBody = scrubText(body.trim());
  const rawName = typeof frontmatterRaw.name === "string" ? frontmatterRaw.name.trim() : undefined;
  if (rawName && RESERVED_NAMES.has(rawName.toLowerCase())) {
    throw new SkillError(`${fileLabel}: nama skill "${rawName}" dicadangkan.`);
  }
  const slug =
    normalizeSlugCandidate(derivedId) ?? (rawName ? normalizeSlugCandidate(rawName) : null);
  if (!slug) {
    throw new SkillError(`${fileLabel}: nama skill tidak valid.`);
  }

  const descParts: string[] = [];
  if (typeof frontmatterRaw.description === "string" && frontmatterRaw.description.trim()) {
    descParts.push(frontmatterRaw.description.trim());
  }
  if (typeof frontmatterRaw.when_to_use === "string" && frontmatterRaw.when_to_use.trim()) {
    descParts.push(frontmatterRaw.when_to_use.trim());
  }
  if (descParts.length === 0) {
    const fallback = firstParagraphLine(trimmedBody);
    if (fallback) descParts.push(fallback);
  }
  const whenToUse = sanitizeSummary(descParts.join(" — "));
  if (!whenToUse) {
    throw new SkillError(`${fileLabel}: description atau when_to_use wajib ada.`);
  }

  const metadata =
    frontmatterRaw.metadata &&
    typeof frontmatterRaw.metadata === "object" &&
    !Array.isArray(frontmatterRaw.metadata)
      ? (frontmatterRaw.metadata as Record<string, unknown>)
      : undefined;
  const autoinvoke = metadata?.["opencode/autoinvoke"];
  const disableRaw = frontmatterRaw["disable-model-invocation"];
  const disableModelInvocation =
    autoinvoke === false
      ? true
      : autoinvoke === true
        ? false
        : disableRaw === true || disableRaw === "true" || disableRaw === "yes";

  const updatedAt =
    typeof frontmatterRaw.updated_at === "string" ? frontmatterRaw.updated_at : undefined;

  return {
    name: slug,
    ...(rawName && rawName !== slug ? { displayName: sanitizeSummary(rawName) } : {}),
    whenToUse,
    content: trimmedBody,
    ...(updatedAt ? { updatedAt } : {}),
    ...(disableModelInvocation ? { disableModelInvocation: true } : {}),
  };
}

function isWithinBoundary(boundaryReal: string, targetReal: string): boolean {
  const rel = relative(boundaryReal, targetReal);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function verifyContainedDirectory(
  baseBoundaryReal: string,
  candidatePath: string,
): Promise<{ ok: true; realPath: string } | { ok: false; reason: string }> {
  let stat: Stats;
  try {
    stat = await lstat(candidatePath);
  } catch (error) {
    if (isMissingFile(error)) return { ok: false, reason: "missing" };
    return { ok: false, reason: "Folder skill tidak dapat diperiksa." };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, reason: "Symlink tidak diikuti demi keamanan." };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: "Bukan direktori biasa." };
  }
  let realPath: string;
  try {
    realPath = await realpath(candidatePath);
  } catch {
    return { ok: false, reason: "Realpath direktori gagal." };
  }
  if (!isWithinBoundary(baseBoundaryReal, realPath)) {
    return { ok: false, reason: "Direktori keluar dari batas root yang diizinkan." };
  }
  return { ok: true, realPath };
}

/**
 * Read a skill markdown file with strict no-symlink, boundary containment, and byte cap checks.
 */
async function readBoundedSkillFile(
  sourceRootReal: string,
  filePath: string,
  maxBytes: number = SKILL_LIMITS.maxNativeFileBytes,
): Promise<string> {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SkillError("File skill harus file biasa (symlink ditolak).");
  }
  if (stat.size > maxBytes) {
    throw new SkillError(`Ukuran file skill melebihi batas (${maxBytes} byte).`);
  }
  const realFile = await realpath(filePath);
  if (!isWithinBoundary(sourceRootReal, realFile)) {
    throw new SkillError("Path file skill keluar dari batas folder sumber.");
  }
  const handle = await open(realFile, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw new SkillError(`Ukuran file skill melebihi batas (${maxBytes} byte).`);
    }
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw new SkillError("File skill mengandung byte biner (NUL).");
    }
    return slice.toString("utf8");
  } finally {
    await handle.close();
  }
}

interface RawCandidate {
  readonly spec: SkillDiscoveryRootSpec;
  readonly format: NativeSkillFormat;
  readonly derivedId: string;
  readonly absFilePath: string;
  readonly displayPath: string;
  readonly sourceRootReal: string;
}

async function collectSourceCandidates(
  spec: SkillDiscoveryRootSpec,
  sourceRootPath: string,
  sourceRootReal: string,
  skipped: SkillCatalogSkip[],
): Promise<RawCandidate[]> {
  const candidates: RawCandidate[] = [];
  let visited = 0;

  const walk = async (dirPath: string, relFromSource: string, depth: number): Promise<void> => {
    if (depth > spec.maxDepth || visited >= SKILL_LIMITS.maxEntriesPerRoot) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      skipped.push({
        source_id: spec.sourceId,
        path: toPosixPath(join(spec.displayDir, relFromSource)),
        reason: "Direktori tidak dapat dibaca.",
      });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    if (depth > 0) {
      const skillMdEntry = entries.find((e) => e.name === "SKILL.md");
      if (skillMdEntry) {
        visited++;
        const absFile = join(dirPath, "SKILL.md");
        const displayPath = toPosixPath(join(spec.displayDir, relFromSource, "SKILL.md"));
        const folderName = basename(dirPath);
        if (RESERVED_NAMES.has(folderName.toLowerCase())) {
          skipped.push({
            source_id: spec.sourceId,
            path: displayPath,
            reason: `Folder skill "${folderName}" dicadangkan dan dilewati.`,
          });
          return;
        }
        candidates.push({
          spec,
          format: "skill-dir",
          derivedId: folderName,
          absFilePath: absFile,
          displayPath,
          sourceRootReal,
        });
        // A directory containing SKILL.md is one skill; never recurse into scripts/ or references/.
        return;
      }
    }

    for (const entry of entries) {
      if (visited >= SKILL_LIMITS.maxEntriesPerRoot) break;
      const name = entry.name;
      if (name.startsWith(".") || name === "node_modules") continue;
      if (RESERVED_NAMES.has(name.toLowerCase())) {
        skipped.push({
          source_id: spec.sourceId,
          path: toPosixPath(join(spec.displayDir, relFromSource, name)),
          reason: `Nama "${name}" dicadangkan dan dilewati.`,
        });
        continue;
      }

      const absChild = join(dirPath, name);
      const relChild = relFromSource ? join(relFromSource, name) : name;
      const displayChild = toPosixPath(join(spec.displayDir, relChild));

      let childStat: Stats;
      try {
        childStat = await lstat(absChild);
      } catch {
        skipped.push({
          source_id: spec.sourceId,
          path: displayChild,
          reason: "Entri tidak dapat diperiksa.",
        });
        continue;
      }

      if (childStat.isSymbolicLink()) {
        skipped.push({
          source_id: spec.sourceId,
          path: displayChild,
          reason: "Symlink tidak diikuti demi keamanan.",
        });
        continue;
      }

      if (depth === 0 && childStat.isFile() && spec.allowFlatMd && name.endsWith(".md")) {
        if (name.toLowerCase() === "readme.md" || name === "SKILL.md") continue;
        visited++;
        candidates.push({
          spec,
          format: "flat-md",
          derivedId: name.slice(0, -3),
          absFilePath: absChild,
          displayPath: displayChild,
          sourceRootReal,
        });
        continue;
      }

      if (childStat.isDirectory()) {
        const nextDepth = depth + 1;
        if (nextDepth === 1 || (spec.allowNestedSkillMd && nextDepth <= spec.maxDepth)) {
          const check = await verifyContainedDirectory(sourceRootReal, absChild);
          if (!check.ok) {
            skipped.push({
              source_id: spec.sourceId,
              path: displayChild,
              reason: check.reason,
            });
            continue;
          }
          await walk(absChild, relChild, nextDepth);
        }
      }
    }
  };

  await walk(sourceRootPath, "", 0);
  return candidates;
}

/**
 * Build a unified, provenance-aware skill catalog across `.catenext/skills`, native project
 * skill directories, and (only when `includeUserGlobal: true`) explicit user skill directories.
 * Never mutates, copies, or executes user skill files.
 */
export async function discoverSkillCatalog(
  root: string,
  options: DiscoverSkillsOptions = {},
): Promise<SkillCatalogResult> {
  const resolvedRoot = resolve(root);
  const rootReal = await realpath(resolvedRoot).catch(() => resolvedRoot);
  const resolvedHome = resolve(options.homeDir ?? homedir());
  const homeReal = await realpath(resolvedHome).catch(() => resolvedHome);
  const specs = selectSkillDiscoverySpecs(options);

  const rawEntries: Array<
    Omit<DiscoveredSkillEntry, "collision" | "collision_sources"> & {
      readonly precedence: number;
    }
  > = [];
  const sources: DiscoveredSkillSourceReport[] = [];
  const skipped: SkillCatalogSkip[] = [];

  for (const spec of specs) {
    if (spec.sourceId === "repo:.catenext/skills") {
      const repoDir = join(resolvedRoot, SKILLS_DIR);
      const dirCheck = await verifyContainedDirectory(rootReal, repoDir);
      const exists = dirCheck.ok;
      const { skills, invalid } = await listSkills(resolvedRoot);
      for (const item of invalid) {
        skipped.push({
          source_id: spec.sourceId,
          path: toPosixPath(join(spec.displayDir, item.file)),
          reason: item.error,
        });
      }
      for (const skill of skills) {
        const catalogKey = `${spec.sourceId}:${skill.name}` as SkillCatalogKey;
        rawEntries.push({
          catalog_key: catalogKey,
          name: skill.name,
          when_to_use: sanitizeSummary(skill.when_to_use),
          source_id: spec.sourceId,
          source_kind: "repo",
          platform: "catenext",
          format: "catenext-md",
          source_path: toPosixPath(join(spec.displayDir, `${skill.name}.md`)),
          updated_at: skill.updated_at,
          precedence: spec.precedence,
        });
      }
      sources.push({
        source_id: spec.sourceId,
        source_kind: spec.sourceKind,
        platform: spec.platform,
        root_path: spec.displayDir,
        exists,
        discovered_count: skills.length,
        skipped_count: invalid.length,
      });
      continue;
    }

    const baseDir = spec.sourceKind === "user" ? resolvedHome : resolvedRoot;
    const baseReal = spec.sourceKind === "user" ? homeReal : rootReal;
    const sourceRootPath = resolve(baseDir, spec.relativeDir);
    const relToBase = relative(baseDir, sourceRootPath);
    if (
      !relToBase ||
      relToBase.startsWith(`..${sep}`) ||
      relToBase === ".." ||
      isAbsolute(relToBase)
    ) {
      skipped.push({
        source_id: spec.sourceId,
        path: spec.displayDir,
        reason: "Root sumber berada di luar batas direktori.",
      });
      sources.push({
        source_id: spec.sourceId,
        source_kind: spec.sourceKind,
        platform: spec.platform,
        root_path: spec.displayDir,
        exists: false,
        discovered_count: 0,
        skipped_count: 1,
      });
      continue;
    }

    // Also check intermediate parent directories (e.g., .claude or .opencode) for symlinks.
    const segments = relToBase.split(sep);
    let current = baseDir;
    let parentFailed: string | undefined;
    for (const seg of segments) {
      current = join(current, seg);
      const check = await verifyContainedDirectory(baseReal, current);
      if (!check.ok) {
        parentFailed = check.reason;
        break;
      }
    }

    if (parentFailed !== undefined) {
      if (parentFailed !== "missing") {
        skipped.push({
          source_id: spec.sourceId,
          path: spec.displayDir,
          reason: parentFailed,
        });
      }
      sources.push({
        source_id: spec.sourceId,
        source_kind: spec.sourceKind,
        platform: spec.platform,
        root_path: spec.displayDir,
        exists: false,
        discovered_count: 0,
        skipped_count: parentFailed === "missing" ? 0 : 1,
      });
      continue;
    }

    const sourceRootReal = await realpath(sourceRootPath);
    const beforeSkipCount = skipped.length;
    const candidates = await collectSourceCandidates(spec, sourceRootPath, sourceRootReal, skipped);

    const seenInSource = new Map<string, string>();
    let discoveredCount = 0;

    for (const candidate of candidates) {
      try {
        const rawText = await readBoundedSkillFile(candidate.sourceRootReal, candidate.absFilePath);
        const parsed = parseNativeSkillMarkdown(
          rawText,
          candidate.derivedId,
          candidate.displayPath,
        );
        const prevPath = seenInSource.get(parsed.name);
        if (prevPath) {
          skipped.push({
            source_id: spec.sourceId,
            path: candidate.displayPath,
            reason: `${candidate.displayPath}: duplikat nama "${parsed.name}" di sumber yang sama (${prevPath}).`,
          });
          continue;
        }
        seenInSource.set(parsed.name, candidate.displayPath);
        discoveredCount++;
        const catalogKey = `${spec.sourceId}:${parsed.name}` as SkillCatalogKey;
        rawEntries.push({
          catalog_key: catalogKey,
          name: parsed.name,
          ...(parsed.displayName ? { display_name: parsed.displayName } : {}),
          when_to_use: parsed.whenToUse,
          source_id: spec.sourceId,
          source_kind: spec.sourceKind,
          platform: spec.platform,
          format: candidate.format,
          source_path: candidate.displayPath,
          ...(parsed.updatedAt ? { updated_at: parsed.updatedAt } : {}),
          ...(parsed.disableModelInvocation ? { disable_model_invocation: true } : {}),
          precedence: spec.precedence,
        });
      } catch (error) {
        skipped.push({
          source_id: spec.sourceId,
          path: candidate.displayPath,
          reason:
            error instanceof SkillError
              ? error.message
              : `${candidate.displayPath}: file skill tidak dapat dibaca dengan aman.`,
        });
      }
    }

    sources.push({
      source_id: spec.sourceId,
      source_kind: spec.sourceKind,
      platform: spec.platform,
      root_path: spec.displayDir,
      exists: true,
      discovered_count: discoveredCount,
      skipped_count: skipped.length - beforeSkipCount,
    });
  }

  rawEntries.sort(
    (a, b) =>
      a.precedence - b.precedence ||
      a.name.localeCompare(b.name) ||
      a.source_id.localeCompare(b.source_id),
  );

  const sourcesByName = new Map<string, SkillSourceId[]>();
  for (const entry of rawEntries) {
    const list = sourcesByName.get(entry.name) ?? [];
    if (!list.includes(entry.source_id)) list.push(entry.source_id);
    sourcesByName.set(entry.name, list);
  }

  const collisions: Array<{ readonly name: string; readonly sources: SkillSourceId[] }> = [];
  for (const [name, srcList] of [...sourcesByName.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (srcList.length > 1) {
      collisions.push({ name, sources: srcList });
    }
  }

  const maxEntries = Math.max(1, options.maxEntries ?? SKILL_LIMITS.maxCatalogEntries);
  const truncated = rawEntries.length > maxEntries;
  const entries: DiscoveredSkillEntry[] = rawEntries.slice(0, maxEntries).map((entry) => {
    const srcList = sourcesByName.get(entry.name) ?? [entry.source_id];
    const hasCollision = srcList.length > 1;
    const { precedence: _precedence, ...rest } = entry;
    return {
      ...rest,
      collision: hasCollision,
      ...(hasCollision ? { collision_sources: srcList } : {}),
    };
  });

  return {
    entries,
    sources,
    collisions,
    skipped,
    truncated,
  };
}

/** Convert catalog entries to compact Tier-1 SkillIndexEntry items for MCP get_project_context. */
export function toSkillIndexEntries(
  entries: readonly DiscoveredSkillEntry[],
  repoName: string,
): SkillIndexEntry[] {
  return entries.map((entry) => ({
    name: entry.name,
    when_to_use: entry.when_to_use,
    repo_name: repoName,
    source_id: entry.source_id,
    source_kind: entry.source_kind,
    source_path: entry.source_path,
    ...(entry.collision ? { collision: true } : {}),
  }));
}

/** Format human-readable discovery summary lines for init/sync/dry-run. */
export function formatSkillCatalogSummary(catalog: SkillCatalogResult): string[] {
  const lines: string[] = [];
  const repoCount = catalog.entries.filter((e) => e.source_kind === "repo").length;
  const nativeCount = catalog.entries.length - repoCount;
  const activeSources = catalog.sources.filter(
    (s) => s.exists && (s.discovered_count > 0 || s.skipped_count > 0),
  );
  if (nativeCount > 0) {
    const breakdown = activeSources
      .filter((s) => s.discovered_count > 0)
      .map((s) => `${s.root_path} (${s.discovered_count})`)
      .join(", ");
    lines.push(
      `• ${catalog.entries.length} skill terdeteksi (${repoCount} repo, ${nativeCount} native: ${breakdown}).`,
    );
  } else {
    lines.push(`• ${repoCount} skill lokal valid.`);
  }
  for (const col of catalog.collisions) {
    lines.push(
      `! Kolisi nama skill "${col.name}" lintas sumber (${col.sources.join(" vs ")}); identitas sumber tetap dipisah.`,
    );
  }
  for (const skip of catalog.skipped) {
    lines.push(`! Skill dilewati: ${skip.reason}`);
  }
  return lines;
}

/**
 * Lazy-load full skill body on demand by name (and optional explicit source_id or revision).
 * - If `revision` is set, only repo skills (`.catenext/skills/<name>.md`) are loaded from Git.
 * - If `sourceId` is omitted and `.catenext/skills/<name>.md` exists, repo skill takes precedence
 *   and enforces full repo skill checks.
 * - Otherwise loads from the matching discovered source (or requested `sourceId`).
 */
export async function loadCatalogSkill(
  root: string,
  name: string,
  options: DiscoverSkillsOptions & {
    readonly sourceId?: SkillSourceId;
    readonly revision?: string;
  } = {},
): Promise<LoadedCatalogSkill> {
  const parsedName = SkillNameSchema.safeParse(name);
  if (!parsedName.success) {
    throw new SkillError(`Nama skill "${name}" tidak valid.`);
  }
  const slug = parsedName.data;

  if (options.revision) {
    if (options.sourceId && options.sourceId !== "repo:.catenext/skills") {
      throw new SkillError("Revisi Git hanya didukung untuk skill repo (.catenext/skills).");
    }
    const repoSkill = await loadSkill(root, slug, options.revision);
    return {
      ...repoSkill,
      catalog_key: `repo:.catenext/skills:${repoSkill.name}` as SkillCatalogKey,
      source_id: "repo:.catenext/skills",
      source_kind: "repo",
      source_path: `.catenext/skills/${repoSkill.name}.md`,
      collision: false,
    };
  }

  const catalog = await discoverSkillCatalog(root, {
    ...options,
    maxEntries: SKILL_LIMITS.maxEntriesPerRoot * 4,
  });
  const matches = catalog.entries.filter((e) => e.name === slug);

  if (!options.sourceId || options.sourceId === "repo:.catenext/skills") {
    const repoMatch = matches.find((e) => e.source_id === "repo:.catenext/skills");
    if (repoMatch || options.sourceId === "repo:.catenext/skills") {
      const repoSkill = await loadSkill(root, slug);
      return {
        ...repoSkill,
        catalog_key: `repo:.catenext/skills:${repoSkill.name}` as SkillCatalogKey,
        source_id: "repo:.catenext/skills",
        source_kind: "repo",
        source_path: `.catenext/skills/${repoSkill.name}.md`,
        collision: matches.length > 1,
      };
    }
  }

  const target = options.sourceId
    ? matches.find((e) => e.source_id === options.sourceId)
    : matches[0];

  if (!target) {
    const available =
      catalog.entries
        .map((e) => (e.collision ? `${e.name} (${e.source_id})` : e.name))
        .join(", ") || "(belum ada)";
    const sourceSuffix = options.sourceId ? ` pada sumber "${options.sourceId}"` : "";
    throw new SkillError(`Skill "${slug}"${sourceSuffix} tidak ada. Skill tersedia: ${available}.`);
  }

  const resolvedRoot = resolve(root);
  const resolvedHome = resolve(options.homeDir ?? homedir());
  const specs = selectSkillDiscoverySpecs(options);
  const spec = specs.find((s) => s.sourceId === target.source_id);
  if (!spec) {
    throw new SkillError(`Sumber skill "${target.source_id}" tidak diaktifkan.`);
  }

  const baseDir = spec.sourceKind === "user" ? resolvedHome : resolvedRoot;
  const baseReal = await realpath(baseDir).catch(() => baseDir);
  const sourceRootPath = resolve(baseDir, spec.relativeDir);
  const dirCheck = await verifyContainedDirectory(baseReal, sourceRootPath);
  if (!dirCheck.ok) {
    throw new SkillError(`Sumber skill "${target.source_id}" tidak dapat diakses dengan aman.`);
  }

  const relInsideSource = target.source_path.slice(spec.displayDir.length).replace(/^\/+/, "");
  const absFile = resolve(sourceRootPath, relInsideSource);
  // Verify intermediate directory if nested
  const parentDir = dirname(absFile);
  if (parentDir !== sourceRootPath) {
    const parentCheck = await verifyContainedDirectory(dirCheck.realPath, parentDir);
    if (!parentCheck.ok) {
      throw new SkillError(
        `Folder skill "${target.source_path}" tidak aman: ${parentCheck.reason}`,
      );
    }
  }

  const rawText = await readBoundedSkillFile(dirCheck.realPath, absFile);
  const parsed = parseNativeSkillMarkdown(rawText, target.name, target.source_path);
  return {
    name: parsed.name,
    when_to_use: parsed.whenToUse,
    updated_at: parsed.updatedAt ?? new Date(0).toISOString(),
    content: parsed.content,
    catalog_key: target.catalog_key,
    source_id: target.source_id,
    source_kind: target.source_kind,
    source_path: target.source_path,
    collision: target.collision,
  };
}
