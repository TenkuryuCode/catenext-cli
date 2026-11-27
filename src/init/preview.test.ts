import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { planInit } from "./index.js";
import { formatInitDryRunPreview, planInitDryRunPreview } from "./preview.js";

const CMD = { command: "node", args: ["cli.js"] };
let workspace: string;
let root: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "catenext-init-preview-"));
  root = join(workspace, "repo");
  await mkdir(root);
  await writeFile(join(root, "package.json"), '{"dependencies":{"hono":"4"}}');
});
afterEach(() => rm(workspace, { recursive: true, force: true }));

it("previews matched seed personas and agent stubs without IO beyond planning", async () => {
  const changes = await planInit({ root, platforms: ["claude-code", "cursor"], mcpCommand: CMD });
  const preview = await planInitDryRunPreview({
    root,
    changes,
    platforms: ["claude-code", "cursor"],
    personaSeed: "matched",
    stack: ["hono"],
  });
  expect(preview.personaAliases).toEqual(expect.arrayContaining(["be", "reviewer"]));
  expect(preview.stubEdits.map((e) => e.path)).toEqual(
    expect.arrayContaining([
      join(".claude", "agents", "orchestrator.md"),
      join(".cursor", "agents", "orchestrator.md"),
      join(".claude", "agents", "be.md"),
    ]),
  );
  const lines = formatInitDryRunPreview(preview);
  expect(lines.join("\n")).toContain("(dry-run) SQLite seed");
  expect(lines.join("\n")).toContain("personas: be");
});

it("honors persona seed none in preview output", async () => {
  const changes = await planInit({ root, platforms: ["claude-code"], mcpCommand: CMD });
  const preview = await planInitDryRunPreview({
    root,
    changes,
    platforms: ["claude-code"],
    personaSeed: "none",
    stack: [],
  });
  expect(preview.personaAliases).toEqual([]);
  expect(formatInitDryRunPreview(preview).join("\n")).toContain("personas: (lewati)");
});

it("discovers pre-existing native skills during init dry-run preview without modifying them", async () => {
  const claudeSkillDir = join(root, ".claude", "skills", "existing-audit");
  await mkdir(claudeSkillDir, { recursive: true });
  await writeFile(
    join(claudeSkillDir, "SKILL.md"),
    "---\ndescription: Existing audit skill before init\n---\nAudit instructions.\n",
  );
  const changes = await planInit({ root, platforms: ["claude-code"], mcpCommand: CMD });
  const preview = await planInitDryRunPreview({
    root,
    changes,
    platforms: ["claude-code"],
    personaSeed: "matched",
    stack: ["hono"],
  });
  expect(preview.skillCatalog.entries.map((e) => [e.name, e.source_id])).toEqual([
    ["existing-audit", "claude-code:project:.claude/skills"],
  ]);
  expect(formatInitDryRunPreview(preview).join("\n")).toContain(
    "1 skill terdeteksi (0 repo, 1 native: .claude/skills (1))",
  );
});
