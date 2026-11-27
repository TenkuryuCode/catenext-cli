import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderSkill, SKILLS_DIR } from "./skills.js";

export type SeedSkill = {
  name: string;
  when_to_use: string;
  content: string;
};

/** Built-in skills written on init/sync when missing. */
export const DEFAULT_SKILLS: SeedSkill[] = [
  {
    name: "cross-agent-sync",
    when_to_use: "Kickoff brainstorm or when personas need shared contracts across areas",
    content: [
      "# Cross-agent sync",
      "",
      "## Kickoff brainstorm (orchestrator-led)",
      "",
      "Before parallel worktrees:",
      "1. Pick personas that share a surface (e.g. be + fe + security).",
      "2. Run a short sync round (chat or sequential briefs). Capture only decisions.",
      "3. Write outcomes to document slug `sync-board` via `save_document`.",
      "4. Each persona reads `sync-board` after claim; do not invent contracts.",
      "",
      "## Ongoing communication",
      "",
      "- Personas do not DM each other out of band.",
      "- Need something from another area? Report to orchestrator with:",
      "  ASK: <persona> · NEED: <one line> · BLOCKS: <task id>",
      "- Orchestrator updates `sync-board` or delegates a tiny clarifying task.",
      "- Handoffs stay the durable record for completed work.",
      "",
      "## sync-board format (compact)",
      "",
      "```text",
      "UPDATED: <iso>",
      "DECISIONS:",
      "- …",
      "CONTRACTS:",
      "- be ↔ fe: …",
      "OPEN ASKS:",
      "- from fe to be: …",
      "```",
      "",
      "No secrets. No code dumps. Paths only.",
    ].join("\n"),
  },
  {
    name: "docs-hygiene",
    when_to_use: "When project docs are stale, duplicated, or need a tidy pass",
    content: [
      "# Docs hygiene",
      "",
      "Owner: persona `scribe` (or orchestrator if scribe absent).",
      "",
      "## Checklist",
      "",
      "1. `catenext doc list` (MCP `get_project_context`; optional `include_archived`) — drop empty or duplicate slugs; add `--include-archived` to audit soft-archived docs (`[arsip]`).",
      "2. Keep `blueprint`, `orchestrator`, `permissions`, `sync-board` current.",
      "3. One topic per doc; titles ≤120 chars; no secrets or code dumps.",
      "4. Bump via `save_document` / `catenext doc save` with correct `expected_version`.",
      "5. Link related slugs in one line at the top when helpful.",
      "",
      "## Archive (soft)",
      "",
      "When a doc is superseded, duplicated, or obsolete but worth keeping:",
      "",
      "- `catenext doc archive <slug>` (MCP `archive_document`) sets `archived_at`; hidden from default list, context, and search.",
      "- `catenext doc restore <slug>` (MCP `restore_document`) if archived by mistake.",
      "- Prefer archive over delete; do not edit task handoff history.",
      "",
      "## Long or unwieldy docs",
      "",
      "Before loading full content into context:",
      "",
      "- `catenext doc get <slug> --outline` (MCP `get_document` + `outline_only`) — heading tree only.",
      '- `catenext doc get <slug> --section "<heading>"` (MCP `get_document` + `section`) — one section; heading match is exact (including `#` in titles).',
      "",
      "To split: outline the doc, carve stable sections into new slugs via `save_document`, add cross-links at the top of each, then archive the monolith slug if nothing unique remains.",
      "",
      "## Output",
      "",
      "Report: kept / merged / archived (`<slug>`) / split (`<from>` → `<new slugs>`) / still open questions.",
      "Do not rewrite history of task handoffs; only project documents.",
    ].join("\n"),
  },
];

/** Write missing default skills under `.catenext/skills/`. Does not overwrite existing. */
export async function ensureDefaultSkills(root: string, now = new Date()): Promise<string[]> {
  const dir = join(root, SKILLS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  const stamp = now.toISOString();
  for (const skill of DEFAULT_SKILLS) {
    const path = join(dir, `${skill.name}.md`);
    try {
      await writeFile(
        path,
        renderSkill({
          name: skill.name,
          when_to_use: skill.when_to_use,
          updated_at: stamp,
          content: skill.content,
        }),
        { flag: "wx", mode: 0o600 },
      );
      created.push(skill.name);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  return created;
}
