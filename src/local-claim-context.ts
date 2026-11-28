import type { DatabaseSync } from "node:sqlite";
import {
  type CatenextConfig,
  CLAIM_CONTEXT_PACK_MAX_BYTES,
  type ClaimContextPack,
  ClaimContextPackSchema,
} from "@catenext/shared";
import { getGraphCounts, queryClaimGraphSlice } from "./db/graph-index.js";
import { type GraphRootDir, mapScopeFilesToTests } from "./db/graph-summary.js";
import { resolveEpicSummaryText } from "./local-retention.js";
import type { LocalProject, LocalTask } from "./local-state.js";
import { type DiscoveredSkillEntry, discoverSkillCatalog } from "./skill-catalog.js";

export interface ClaimContextSnapshot {
  pack: ClaimContextPack;
  task: Pick<LocalTask, "role" | "persona" | "doc_refs">;
}

export function snapshotClaimContext({
  project,
  task,
  db,
  projectId,
  graphRootDirs,
}: {
  project: LocalProject;
  task: LocalTask;
  db: DatabaseSync;
  projectId: string;
  graphRootDirs: () => GraphRootDir[];
}): ClaimContextSnapshot {
  const pack: ClaimContextPack = {};
  const epic = project.epics.find((item) => item.id === task.epicId);
  if (epic) {
    pack.epic_summary = resolveEpicSummaryText(epic, project.tasks, 240);
  }
  const syncDoc = project.documents.find((d) => d.slug === "sync-board" && !d.archived_at);
  if (syncDoc) {
    const excerpt = extractSyncBoardExcerpt(syncDoc.content, task.id, task.persona);
    if (excerpt) pack.sync_board_excerpt = excerpt;
  }
  if (task.scope_files?.length && getGraphCounts(db, projectId).files > 0) {
    const scopeSlice = task.scope_files.slice(0, 5);
    const files = queryClaimGraphSlice(db, projectId, scopeSlice, graphRootDirs());
    if (files.length > 0) pack.graph_slice = files;
    const testFiles = mapScopeFilesToTests(db, projectId, scopeSlice, { limit: 6 });
    if (testFiles.length > 0) pack.test_files = testFiles;
  }
  return {
    pack: ClaimContextPackSchema.parse(pack),
    task: { role: task.role, persona: task.persona, doc_refs: task.doc_refs },
  };
}

export async function enrichClaimContext(
  { pack, task }: ClaimContextSnapshot,
  repoRoot: string,
  platforms: CatenextConfig["platforms"],
): Promise<ClaimContextPack | undefined> {
  try {
    const catalog = await discoverSkillCatalog(repoRoot, { platforms });
    const skills = prioritizeSkills(catalog.entries, task);
    if (skills.length > 0) pack.skills_hint = skills;
  } catch {
    // Skill discovery is optional. The lease and claim event are already committed.
  }
  return Object.keys(pack).length > 0 ? boundClaimContextPack(pack) : undefined;
}

export function extractSyncBoardExcerpt(
  content: string,
  taskId: string,
  persona: string | null,
): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const lines = trimmed.split(/\r?\n/);
  const blocks: Array<{ heading?: string; body: string[] }> = [];
  let current: { heading?: string; body: string[] } = { body: [] };
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      if (current.heading || current.body.length > 0) blocks.push(current);
      current = { heading: line, body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.heading || current.body.length > 0) blocks.push(current);

  const taskNeedle = taskId.toLowerCase();
  const matchesTask = (line: string) => line.toLowerCase().includes(taskNeedle);
  // Persona aliases are slugs. A match may not be part of a longer slug.
  const personaPattern = persona
    ? new RegExp(`(?<![a-z0-9_-])${persona}(?![a-z0-9_-])`, "i")
    : undefined;
  const sharedContext = /\b(?:decisions|open\s+asks)\b/i;

  const taskLines: string[] = [];
  const picked: string[] = [];
  for (const block of blocks) {
    const heading = block.heading;
    const body = block.body.filter((line) => line.trim().length > 0);
    if (heading && matchesTask(heading)) {
      taskLines.push(heading, ...body);
      continue;
    }
    const sharedSection = heading !== undefined && sharedContext.test(heading);
    const matchingLines: string[] = [];
    for (const line of body) {
      if (matchesTask(line)) taskLines.push(line);
      else if (sharedSection || sharedContext.test(line) || personaPattern?.test(line)) {
        matchingLines.push(line);
      }
    }
    if (sharedSection || matchingLines.length > 0) {
      if (heading) picked.push(heading);
      picked.push(...matchingLines);
    }
  }

  const selected = [...taskLines, ...picked];
  let excerpt = (selected.length ? selected : lines.filter((line) => line.trim().length > 0)).join(
    "\n",
  );
  excerpt = excerpt.trim();
  if (!excerpt) return undefined;
  if (excerpt.length > 800) excerpt = `${excerpt.slice(0, 799)}…`;
  return excerpt;
}

export function prioritizeSkills(
  skills: readonly Pick<
    DiscoveredSkillEntry,
    "name" | "when_to_use" | "disable_model_invocation"
  >[],
  task: Pick<LocalTask, "role" | "persona" | "doc_refs">,
): string[] {
  const docNeedles = new Set((task.doc_refs ?? []).map((ref) => ref.toLowerCase()));
  const roleNeedles = [task.role, task.persona]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.toLowerCase());

  const matches = (
    skill: Pick<DiscoveredSkillEntry, "name" | "when_to_use" | "disable_model_invocation">,
  ): boolean => {
    const nameLow = skill.name.toLowerCase();
    if (docNeedles.has(nameLow)) return true;
    for (const ref of docNeedles) {
      if (ref.includes(nameLow) || nameLow.includes(ref)) return true;
    }
    const hay = `${nameLow} ${skill.when_to_use.toLowerCase()}`;
    return roleNeedles.some((needle) => hay.includes(needle));
  };

  const prioritized: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();
  for (const skill of skills) {
    if (skill.disable_model_invocation || seen.has(skill.name)) continue;
    seen.add(skill.name);
    if (matches(skill)) prioritized.push(skill.name);
    else rest.push(skill.name);
  }
  return [...prioritized, ...rest].slice(0, 5);
}

export function boundClaimContextPack(pack: ClaimContextPack): ClaimContextPack {
  const fits = (candidate: ClaimContextPack) =>
    Buffer.byteLength(JSON.stringify(candidate), "utf8") <= CLAIM_CONTEXT_PACK_MAX_BYTES;
  if (fits(pack)) return pack;

  const bounded: ClaimContextPack = { ...pack, truncated: true };
  if (pack.graph_slice?.some((file) => file.symbol_locations)) {
    // Preserve the original slice when only the added locations exceed the budget.
    bounded.graph_slice = pack.graph_slice.map(({ symbol_locations: _locations, ...file }) => file);
    if (fits(bounded)) return bounded;
  }
  delete bounded.test_files;
  if (fits(bounded)) return bounded;
  delete bounded.graph_slice;
  if (fits(bounded)) return bounded;

  const excerpt = bounded.sync_board_excerpt;
  delete bounded.sync_board_excerpt;
  if (excerpt && fits(bounded)) {
    // Find longest excerpt prefix that fits, including JSON escaping and the truncation marker.
    const chars = Array.from(excerpt);
    let low = 1;
    let high = chars.length - 1;
    let best: string | undefined;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const prefix = `${chars.slice(0, mid).join("")}…`;
      if (fits({ ...bounded, sync_board_excerpt: prefix })) {
        best = prefix;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best !== undefined) bounded.sync_board_excerpt = best;
  }

  // Defensive fallback if non-excerpt context ever grows beyond current field limits.
  if (!fits(bounded)) delete bounded.skills_hint;
  if (!fits(bounded)) delete bounded.epic_summary;
  return bounded;
}
