import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_LIMITS } from "@catenext/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverSkillCatalog,
  loadCatalogSkill,
  selectSkillDiscoverySpecs,
  toSkillIndexEntries,
} from "./skill-catalog.js";
import { saveSkill } from "./skills.js";

let root: string;
let home: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
});

describe("skill-catalog discovery & safety", () => {
  it("discovers pre-init native project skills without .catenext/config.yaml and never mutates source files", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skill-cat-root-"));
    home = await mkdtemp(join(tmpdir(), "catenext-skill-cat-home-"));

    const claudeSkillDir = join(root, ".claude", "skills", "code-audit");
    await mkdir(claudeSkillDir, { recursive: true });
    const rawClaudeSkill = [
      "---",
      "name: Code Audit",
      "description: Audit changed files for security regressions",
      "---",
      "",
      "Check auth boundaries and SQL queries.",
    ].join("\n");
    await writeFile(join(claudeSkillDir, "SKILL.md"), rawClaudeSkill);

    const agentsSkillDir = join(root, ".agents", "skills", "release-notes");
    await mkdir(agentsSkillDir, { recursive: true });
    await writeFile(
      join(agentsSkillDir, "SKILL.md"),
      "---\ndescription: Draft concise release notes from git log\n---\nSummarize merged PRs.\n",
    );

    const catalog = await discoverSkillCatalog(root, {
      platforms: ["claude-code"],
      homeDir: home,
    });

    expect(catalog.entries.map((e) => [e.name, e.source_id, e.format])).toEqual([
      ["code-audit", "claude-code:project:.claude/skills", "skill-dir"],
      ["release-notes", "agents:project:.agents/skills", "skill-dir"],
    ]);
    expect(catalog.collisions).toEqual([]);

    const loaded = await loadCatalogSkill(root, "code-audit", {
      platforms: ["claude-code"],
      homeDir: home,
    });
    expect(loaded).toMatchObject({
      name: "code-audit",
      source_id: "claude-code:project:.claude/skills",
      source_kind: "project",
      source_path: ".claude/skills/code-audit/SKILL.md",
      content: "Check auth boundaries and SQL queries.",
    });
  });

  it("supports OpenCode flat root markdown and nested SKILL.md while stopping at SKILL.md directory boundary", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skill-cat-root-"));
    const ocFlatDir = join(root, ".opencode", "skills");
    const ocNestedDir = join(root, ".opencode", "skills", "teams", "git-release");
    const ignoredInnerSkillDir = join(ocNestedDir, "references", "inner");
    await mkdir(ignoredInnerSkillDir, { recursive: true });

    await writeFile(
      join(ocFlatDir, "review.md"),
      "---\ndescription: Fast PR review checklist\n---\nReview diff carefully.\n",
    );
    await writeFile(
      join(ocNestedDir, "SKILL.md"),
      "---\nname: Git Release\ndescription: Prepare tags and release notes\n---\nRun release checks.\n",
    );
    await writeFile(
      join(ignoredInnerSkillDir, "SKILL.md"),
      "---\ndescription: Should not be discovered inside another skill directory\n---\nIgnored.\n",
    );

    const catalog = await discoverSkillCatalog(root, { platforms: ["opencode"] });
    expect(catalog.entries.map((e) => [e.name, e.format, e.source_path])).toEqual([
      ["git-release", "skill-dir", ".opencode/skills/teams/git-release/SKILL.md"],
      ["review", "flat-md", ".opencode/skills/review.md"],
    ]);
  });

  it("preserves separate provenance on name collisions and allows explicit source selection on load", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skill-cat-root-"));
    await saveSkill(root, {
      name: "deploy",
      when_to_use: "Repo Catenext deploy checklist",
      content: "Repo deploy instructions.",
    });

    const claudeDeploy = join(root, ".claude", "skills", "deploy");
    await mkdir(claudeDeploy, { recursive: true });
    await writeFile(
      join(claudeDeploy, "SKILL.md"),
      "---\ndescription: Claude native deploy skill\n---\nClaude deploy instructions.\n",
    );

    const cursorDeploy = join(root, ".cursor", "skills", "deploy");
    await mkdir(cursorDeploy, { recursive: true });
    await writeFile(
      join(cursorDeploy, "SKILL.md"),
      "---\ndescription: Cursor native deploy skill\n---\nCursor deploy instructions.\n",
    );

    const catalog = await discoverSkillCatalog(root, {
      platforms: ["claude-code", "cursor"],
    });
    const deployEntries = catalog.entries.filter((e) => e.name === "deploy");
    expect(deployEntries.map((e) => e.source_id)).toEqual([
      "repo:.catenext/skills",
      "claude-code:project:.claude/skills",
      "cursor:project:.cursor/skills",
    ]);
    expect(deployEntries.every((e) => e.collision)).toBe(true);
    expect(catalog.collisions).toEqual([
      {
        name: "deploy",
        sources: [
          "repo:.catenext/skills",
          "claude-code:project:.claude/skills",
          "cursor:project:.cursor/skills",
        ],
      },
    ]);

    // Default load resolves highest precedence (repo:.catenext/skills)
    const defaultLoaded = await loadCatalogSkill(root, "deploy", {
      platforms: ["claude-code", "cursor"],
    });
    expect(defaultLoaded.source_id).toBe("repo:.catenext/skills");
    expect(defaultLoaded.content).toBe("Repo deploy instructions.");

    // Explicit sourceId loads specific colliding source without overwriting or merging
    const cursorLoaded = await loadCatalogSkill(root, "deploy", {
      platforms: ["claude-code", "cursor"],
      sourceId: "cursor:project:.cursor/skills",
    });
    expect(cursorLoaded.source_id).toBe("cursor:project:.cursor/skills");
    expect(cursorLoaded.content).toBe("Cursor deploy instructions.");
  });

  it("Reflects newly installed, edited, and removed skills on subsequent discovery calls without daemon state", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skill-cat-root-"));
    const skillDir = join(root, ".agents", "skills", "db-check");
    await mkdir(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    await writeFile(
      skillFile,
      "---\ndescription: Initial database check\n---\nRun migration check v1.\n",
    );

    const first = await discoverSkillCatalog(root, { platforms: ["codex"] });
    expect(first.entries.map((e) => [e.name, e.when_to_use])).toEqual([
      ["db-check", "Initial database check"],
    ]);

    // Edit existing skill and add a second skill
    await writeFile(
      skillFile,
      "---\ndescription: Updated database check\n---\nRun migration check v2.\n",
    );
    const secondDir = join(root, ".agents", "skills", "lint-fix");
    await mkdir(secondDir, { recursive: true });
    await writeFile(
      join(secondDir, "SKILL.md"),
      "---\ndescription: Run lint checks\n---\nUse pnpm lint.\n",
    );

    const second = await discoverSkillCatalog(root, { platforms: ["codex"] });
    expect(second.entries.map((e) => [e.name, e.when_to_use])).toEqual([
      ["db-check", "Updated database check"],
      ["lint-fix", "Run lint checks"],
    ]);
    expect((await loadCatalogSkill(root, "db-check", { platforms: ["codex"] })).content).toBe(
      "Run migration check v2.",
    );

    // Remove first skill
    await unlink(skillFile);
    const third = await discoverSkillCatalog(root, { platforms: ["codex"] });
    expect(third.entries.map((e) => e.name)).toEqual(["lint-fix"]);
  });

  it("does not scan user/global directories unless includeUserGlobal is explicitly enabled", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skill-cat-root-"));
    home = await mkdtemp(join(tmpdir(), "catenext-skill-cat-home-"));

    const userSkillDir = join(home, ".claude", "skills", "personal-helper");
    await mkdir(userSkillDir, { recursive: true });
    await writeFile(
      join(userSkillDir, "SKILL.md"),
      "---\ndescription: Personal user helper\n---\nPersonal workflow.\n",
    );

    const withoutOptIn = await discoverSkillCatalog(root, {
      platforms: ["claude-code"],
      homeDir: home,
    });
    expect(withoutOptIn.entries).toEqual([]);
    expect(withoutOptIn.sources.every((s) => s.source_kind !== "user")).toBe(true);

    const withOptIn = await discoverSkillCatalog(root, {
      platforms: ["claude-code"],
      includeUserGlobal: true,
      homeDir: home,
    });
    expect(withOptIn.entries.map((e) => [e.name, e.source_id, e.source_kind])).toEqual([
      ["personal-helper", "claude-code:user:.claude/skills", "user"],
    ]);
  });

  it("rejects symlinked skill directories, symlinked files, reserved names, and oversized files", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skill-cat-root-"));
    home = await mkdtemp(join(tmpdir(), "catenext-skill-cat-home-"));

    const outsideDir = join(home, "outside-secret-skill");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(outsideDir, "SKILL.md"),
      "---\ndescription: Outside skill\n---\nShould never load.\n",
    );

    const claudeSkills = join(root, ".claude", "skills");
    await mkdir(claudeSkills, { recursive: true });
    await symlink(outsideDir, join(claudeSkills, "escaped-skill"));

    const syncedDir = join(claudeSkills, "synced");
    await mkdir(syncedDir, { recursive: true });
    await writeFile(
      join(syncedDir, "SKILL.md"),
      "---\ndescription: Reserved synced folder\n---\nIgnored.\n",
    );

    const hugeDir = join(claudeSkills, "huge-skill");
    await mkdir(hugeDir, { recursive: true });
    const hugeBody = "A".repeat(SKILL_LIMITS.maxNativeFileBytes + 1024);
    await writeFile(
      join(hugeDir, "SKILL.md"),
      `---\ndescription: Oversized skill\n---\n${hugeBody}\n`,
    );

    const catalog = await discoverSkillCatalog(root, { platforms: ["claude-code"] });
    expect(catalog.entries).toEqual([]);
    expect(catalog.skipped.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        ".claude/skills/escaped-skill",
        ".claude/skills/synced",
        ".claude/skills/huge-skill/SKILL.md",
      ]),
    );
  });

  it("scrubs secrets and bounds metadata in discovered index entries", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-skill-cat-root-"));
    const skillDir = join(root, ".cursor", "skills", "sec-test");
    await mkdir(skillDir, { recursive: true });
    const token = `ghp_${"A".repeat(24)}`;
    const longDesc = `Use token ${token} and ${"very long description ".repeat(15)}`;
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\ndescription: ${longDesc}\n---\nBody with ${token}\n`,
    );

    const catalog = await discoverSkillCatalog(root, { platforms: ["cursor"] });
    expect(catalog.entries).toHaveLength(1);
    const entry = catalog.entries[0];
    expect(entry?.when_to_use).not.toContain(token);
    expect(entry?.when_to_use.length).toBeLessThanOrEqual(SKILL_LIMITS.maxWhenToUseLength);

    const index = toSkillIndexEntries(catalog.entries, "demo-repo");
    expect(index[0]).toMatchObject({
      name: "sec-test",
      repo_name: "demo-repo",
      source_id: "cursor:project:.cursor/skills",
      source_kind: "project",
    });

    const loaded = await loadCatalogSkill(root, "sec-test", { platforms: ["cursor"] });
    expect(loaded.content).not.toContain(token);
    expect(loaded.content).toContain("[REDACTED:github_token]");
  });

  it("selects platform-scoped discovery specs deterministically", () => {
    const specs = selectSkillDiscoverySpecs({
      platforms: ["vscode", "antigravity"],
      includeUserGlobal: true,
    });
    expect(specs.map((s) => s.sourceId)).toEqual([
      "repo:.catenext/skills",
      "claude-code:project:.claude/skills",
      "vscode:project:.github/skills",
      "agents:project:.agents/skills",
      "antigravity:project:.agent/skills",
      "claude-code:user:.claude/skills",
      "vscode:user:.copilot/skills",
      "agents:user:.agents/skills",
      "antigravity:user:.gemini/config/skills",
      "antigravity:user:.gemini/antigravity/skills",
    ]);
  });
});
