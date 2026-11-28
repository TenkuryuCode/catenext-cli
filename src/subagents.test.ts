import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFileEdits, planRemove } from "./maintenance.js";
import {
  planSubagents,
  renderCodexOrchestrator,
  renderCodexSubagent,
  renderOrchestratorAgent,
  renderOrchestratorStub,
  renderSubagent,
  SUBAGENT_MARKER,
} from "./subagents.js";

const adel = {
  alias: "adel",
  role: "backend",
  rules: ["Hanya apps/api"],
  repos: ["be"],
  scope: "project" as const,
};

describe("subagent persona", () => {
  it("berisi alias, role, alur dengan agent_alias, dan aturan", () => {
    const md = renderSubagent(adel);
    expect(md.startsWith("---\nname: adel\n")).toBe(true);
    expect(md).toContain(SUBAGENT_MARKER);
    expect(md).toContain('`agent_alias: "adel"`');
    expect(md).toContain("- Hanya apps/api");
    expect(md).toContain("Owned repos: `be`");
    expect(md).toContain("Stack:");
    expect(md).toContain("TASK_ID");
    expect(md).toContain("claim_task");
    expect(md).toContain("`compact: true`");
    expect(md).toContain("`include_context: true`");
    expect(md).toContain("skip `get_project_context` and `get_ready_tasks`");
    expect(md).toContain("No `TASK_ID` in brief");
    expect(md).toContain("get_document");
    expect(md).toContain("outline_only");
    expect(md).toContain("section");
    expect(md).toContain("graph_neighbors");
    expect(md).toContain("paths[]");
    expect(md).toContain("notes_for_next_agent");
  });

  it("renders compact deterministic delegation brief template in orchestrator stubs", () => {
    const ctx = { stack: ["ts"], personas: [adel] };
    const opencode = renderOrchestratorAgent(ctx);
    expect(opencode).toContain("## Delegation brief");
    for (const key of [
      "TASK_ID:",
      "WORKTREE:",
      "GOAL:",
      "FILES:",
      "CONTRACTS:",
      "VERIFY:",
      "CONSTRAINTS:",
      "DONE WHEN:",
    ]) {
      expect(opencode).toContain(key);
    }

    const claude = renderOrchestratorStub(ctx, "claude-code");
    expect(claude).toContain("TASK_ID/WORKTREE/GOAL/FILES/CONTRACTS/VERIFY/CONSTRAINTS/DONE WHEN");

    const codex = renderCodexOrchestrator(ctx);
    expect(codex).toContain("TASK_ID/WORKTREE/GOAL/FILES/CONTRACTS/VERIFY/CONSTRAINTS/DONE WHEN");
  });

  it("enriches cursor / antigravity / codex with native conventions", () => {
    const cursor = renderSubagent(adel, { stack: ["node"], personas: [adel] }, "cursor");
    expect(cursor).toContain("model: inherit");
    expect(cursor).toContain(SUBAGENT_MARKER);

    const anti = renderSubagent(adel, { stack: ["node"], personas: [adel] }, "antigravity");
    expect(anti).toContain("model: inherit");
    expect(anti).toContain("subagent: true");
    expect(anti).toContain("mainAgent: false");
    expect(anti).not.toContain("tools:");
    expect(anti).toContain("Tool capabilities: write/terminal enabled");

    const reviewer = {
      alias: "reviewer",
      role: "reviewer",
      rules: ["Review PRs"],
      repos: [],
      scope: "project" as const,
    };
    const antiReviewer = renderSubagent(
      reviewer,
      { stack: ["node"], personas: [adel, reviewer] },
      "antigravity",
    );
    expect(antiReviewer).not.toContain("tools:");
    expect(antiReviewer).toContain("Tool capabilities: read/verify only");

    const scribe = {
      alias: "scribe",
      role: "docs",
      rules: ["Keep docs tidy"],
      repos: [],
      scope: "project" as const,
    };
    const antiScribe = renderSubagent(
      scribe,
      { stack: ["node"], personas: [adel, reviewer, scribe] },
      "antigravity",
    );
    expect(antiScribe).not.toContain("tools:");
    expect(antiScribe).toContain("Tool capabilities: read/verify only");
    expect(antiScribe).toContain("save_document");

    const codex = renderCodexSubagent(adel, { stack: ["node"], personas: [adel] });
    expect(codex).toContain(`# ${SUBAGENT_MARKER}`);
    expect(codex).toContain('name = "adel"');
    expect(codex).toContain("developer_instructions = ");
    expect(codex).toContain("Hanya apps/api");
  });

  it("membuat, memperbarui, menghapus file Catenext saja, dan tidak menimpa file manusia", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-sub-"));
    await mkdir(join(root, ".claude", "agents"), { recursive: true });
    await writeFile(join(root, ".claude", "agents", "citra.md"), "subagent buatan sendiri\n");

    const first = await planSubagents(root, [
      adel,
      { alias: "citra", role: "architect", rules: [], repos: [], scope: "project" },
    ]);
    expect(first.skipped).toEqual([join(".claude", "agents", "citra.md")]);
    await applyFileEdits(root, first.edits);
    expect(await readFile(join(root, ".claude", "agents", "adel.md"), "utf8")).toContain("adel");
    expect(await readFile(join(root, ".claude", "agents", "citra.md"), "utf8")).toBe(
      "subagent buatan sendiri\n",
    );

    // Refresh orchestrator for adel-only, then idempotent.
    const mid = await planSubagents(root, [adel]);
    expect(mid.edits.map((e) => e.path)).toContain(join(".claude", "agents", "orchestrator.md"));
    await applyFileEdits(root, mid.edits);
    expect((await planSubagents(root, [adel])).edits).toEqual([]);
    const gone = await planSubagents(root, []);
    expect(gone.edits.map((e) => e.path).sort()).toEqual([
      join(".claude", "agents", "adel.md"),
      join(".claude", "agents", "orchestrator.md"),
    ]);
    expect(gone.edits.find((e) => e.path.endsWith("adel.md"))?.after).toBeNull();

    // remove ikut membersihkan subagent buatan Catenext.
    const removed = await planRemove({ root, all: false });
    expect(removed.map((e) => e.path)).toContain(join(".claude", "agents", "adel.md"));
    expect(removed.map((e) => e.path)).not.toContain(join(".claude", "agents", "citra.md"));
  });

  it("does not fall back to .claude/agents for vscode; writes Copilot stubs under .github/agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-sub-nofallback-"));
    const vscode = await planSubagents(root, [adel], ["vscode"]);
    expect(vscode.edits.map((e) => e.path).sort()).toEqual([
      join(".github", "agents", "adel.md"),
      join(".github", "agents", "orchestrator.md"),
    ]);
    expect(vscode.skipped).toEqual([]);
    await applyFileEdits(root, vscode.edits);
    expect(await readFile(join(root, ".github", "agents", "adel.md"), "utf8")).toContain(
      "name: adel",
    );

    const codex = await planSubagents(root, [adel], ["codex"]);
    expect(codex.edits.map((e) => e.path).sort()).toEqual([
      join(".codex", "agents", "adel.toml"),
      join(".codex", "agents", "orchestrator.toml"),
    ]);
    await applyFileEdits(root, codex.edits);
    expect(await readFile(join(root, ".codex", "agents", "adel.toml"), "utf8")).toContain(
      'name = "adel"',
    );
  });

  it("writes antigravity stubs under native .agents/agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-sub-anti-"));
    const planned = await planSubagents(root, [adel], ["antigravity"]);
    expect(planned.edits.map((e) => e.path)).toContain(join(".agents", "agents", "adel.md"));
    await applyFileEdits(root, planned.edits);
    const body = await readFile(join(root, ".agents", "agents", "adel.md"), "utf8");
    expect(body).toContain("subagent: true");
  });

  it("overwrites non-Catenext stubs when force is true", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-sub-force-"));
    await mkdir(join(root, ".claude", "agents"), { recursive: true });
    await writeFile(join(root, ".claude", "agents", "orchestrator.md"), "custom orchestrator\n");
    await writeFile(join(root, ".claude", "agents", "adel.md"), "custom adel\n");

    const skipped = await planSubagents(root, [adel], ["claude-code"]);
    expect(skipped.skipped).toEqual([
      join(".claude", "agents", "orchestrator.md"),
      join(".claude", "agents", "adel.md"),
    ]);
    expect(skipped.edits).toEqual([]);

    const forced = await planSubagents(root, [adel], ["claude-code"], {}, { force: true });
    expect(forced.skipped).toEqual([]);
    expect(forced.edits.map((e) => e.path)).toEqual([
      join(".claude", "agents", "orchestrator.md"),
      join(".claude", "agents", "adel.md"),
    ]);
    await applyFileEdits(root, forced.edits);
    expect(await readFile(join(root, ".claude", "agents", "adel.md"), "utf8")).toContain(
      SUBAGENT_MARKER,
    );
  });
});
