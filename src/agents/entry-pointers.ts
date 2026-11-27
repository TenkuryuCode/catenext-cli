import type { PlatformId } from "@catenext/shared";
import { readRepoFile } from "../init/repo-files.js";
import type { FileEdit } from "../maintenance.js";
import { SUBAGENT_DIRS } from "../subagents.js";

export const ENTRY_MARKER = "<!-- catenext:entry -->";
export const MASTER_MARKER = "<!-- catenext:master -->";

/** Root master-prompt file. Every new session should start here. */
export const MASTER_PROMPT_FILE = "CATENEXT.md";

/**
 * Thin platform stubs that only redirect to root CATENEXT.md
 * (Claude Code uses CLAUDE.md because that is what the IDE loads first).
 */
export const PLATFORM_ENTRY_FILES: Partial<Record<PlatformId, string>> = {
  "claude-code": "CLAUDE.md",
  cursor: joinSafe(".cursor", "CATENEXT.md"),
  codex: joinSafe(".codex", "CATENEXT.md"),
  opencode: joinSafe(".opencode", "CATENEXT.md"),
  antigravity: joinSafe(".agents", "CATENEXT.md"),
  vscode: joinSafe(".vscode", "CATENEXT.md"),
};

function joinSafe(...parts: string[]): string {
  return parts.join("/");
}

/** Relative path from a nested entry file back to root CATENEXT.md. */
function masterLinkFrom(entryPath: string): string {
  const depth = entryPath.split("/").length - 1;
  if (depth <= 0) return "./CATENEXT.md";
  return `${"../".repeat(depth)}CATENEXT.md`;
}

function agentsLinkFrom(entryPath: string, agentsDir: string): string {
  const depth = entryPath.split("/").length - 1;
  const prefix = depth <= 0 ? "./" : "../".repeat(depth);
  return `${prefix}${agentsDir}/`;
}

/**
 * Master prompt for a brand-new / cold-start session.
 * Crisp boot pointer (<=30 lines). Full rules, templates, and CLI fallback live in AGENTS.md.
 */
export function renderMasterPrompt(): string {
  return [
    MASTER_MARKER,
    "# Catenext · Master Prompt",
    "",
    "Cold-start boot pointer. Read **[AGENTS.md](./AGENTS.md)** for full orchestrator rules, templates, and CLI fallback.",
    "",
    "## Role & Guardrails",
    "",
    "- **Orchestrator only**: delegate coding to persona subagents (`be`, `fe`, …); never use `agent_alias` yourself.",
    "- **Language**: ask the human first in their language; keep tool names and agent stubs English.",
    "- **Worktrees & secrets**: parallel subagents use separate worktrees/branches (never merge `main`); never publish secrets (paths only) or fake missing tools.",
    "",
    "## Bootstrap (install if missing)",
    "",
    "1. Require Node ≥ 22.12; install `npm install -g catenext` (or `npx -y catenext …`).",
    "2. Ask `--platform` (`cursor|claude-code|codex|antigravity|opencode|vscode`), run `catenext init --platform <id> --dry-run`, apply, run `catenext verify --platform <id>`, then restart IDE.",
    "",
    "## First 60 seconds",
    "",
    "1. Read **[AGENTS.md](./AGENTS.md)** and check project stack in `.catenext/config.yaml`.",
    "2. Call `session_brief` (`catenext brief`); if `pending_approvals` exist, ask `1) approve · 2) revise · 3) next` first.",
    "3. Kickoff brainstorm with relevant personas → save `sync-board`, plan DRAFT tasks, await approval, then delegate.",
    "",
  ].join("\n");
}

type PlatformEntryMeta = {
  title: string;
  agentsNote: string;
  syncHint: string;
};

function platformMeta(platform: PlatformId, entryPath: string): PlatformEntryMeta {
  const agentsDir = SUBAGENT_DIRS[platform];
  const agentsHref = agentsDir ? agentsLinkFrom(entryPath, agentsDir) : null;
  switch (platform) {
    case "claude-code":
      return {
        title: "Claude Code · Catenext entry",
        agentsNote: agentsHref
          ? `Persona agents (Markdown): [\`.claude/agents/\`](${agentsHref}).`
          : "Persona agents: `.claude/agents/`.",
        syncHint: "`catenext sync --platform claude-code`",
      };
    case "cursor":
      return {
        title: "Cursor · Catenext entry",
        agentsNote: agentsHref
          ? `Subagents (Markdown, \`model: inherit\`): [\`.cursor/agents/\`](${agentsHref}).`
          : "Subagents: `.cursor/agents/`.",
        syncHint: "`catenext sync --platform cursor`",
      };
    case "codex":
      return {
        title: "Codex · Catenext entry",
        agentsNote: agentsHref
          ? `Custom agents (TOML): [\`.codex/agents/\`](${agentsHref}). Project instructions still come from root \`AGENTS.md\`.`
          : "Custom agents: `.codex/agents/*.toml`.",
        syncHint: "`catenext sync --platform codex`",
      };
    case "antigravity":
      return {
        title: "Antigravity · Catenext entry",
        agentsNote: agentsHref
          ? `Custom agents (Markdown under native discovery): [\`.agents/agents/\`](${agentsHref}).`
          : "Custom agents: `.agents/agents/`.",
        syncHint: "`catenext sync --platform antigravity`",
      };
    case "opencode":
      return {
        title: "OpenCode · Catenext entry",
        agentsNote: agentsHref
          ? `Persona agents: [\`.opencode/agents/\`](${agentsHref}).`
          : "Persona agents: `.opencode/agents/`.",
        syncHint: "`catenext sync --platform opencode`",
      };
    case "vscode":
      return {
        title: "VS Code · Catenext entry",
        agentsNote: agentsHref
          ? `Custom agents (Copilot harness): [\`.github/agents/\`](${agentsHref}). MCP: \`.vscode/mcp.json\`.`
          : "Custom agents: `.github/agents/`. MCP: `.vscode/mcp.json`.",
        syncHint: "`catenext sync --platform vscode`",
      };
    default:
      return {
        title: `${platform} · Catenext entry`,
        agentsNote: "Follow root CATENEXT.md / AGENTS.md for orchestration.",
        syncHint: "`catenext sync`",
      };
  }
}

/** Thin redirect so IDE-native entry files land on the master prompt. */
export function renderEntryPointer(platform: PlatformId, entryPath: string): string {
  const link = masterLinkFrom(entryPath);
  const agentsMd = masterLinkFrom(entryPath).replace("CATENEXT.md", "AGENTS.md");
  const meta = platformMeta(platform, entryPath);
  return [
    ENTRY_MARKER,
    `# ${meta.title}`,
    "",
    `**New session:** open **[${MASTER_PROMPT_FILE}](${link})** first (master prompt).`,
    "",
    `Then follow [AGENTS.md](${agentsMd}) for full orchestrator rules.`,
    meta.agentsNote,
    "",
    "Do not duplicate the master prompt here — this file is only a pointer.",
    "",
    `Useful: \`catenext brief\` · \`catenext board\` · ${meta.syncHint}.`,
    "",
  ].join("\n");
}

export function renderClaudeEntry(): string {
  return renderEntryPointer("claude-code", "CLAUDE.md");
}

export async function planEntryPointers(
  root: string,
  platforms: readonly PlatformId[],
  opts: { force?: boolean } = {},
): Promise<FileEdit[]> {
  const edits: FileEdit[] = [];

  const masterBefore = await readRepoFile(root, MASTER_PROMPT_FILE);
  if (opts.force || masterBefore === null || masterBefore.includes(MASTER_MARKER)) {
    const masterAfter = renderMasterPrompt();
    if (masterAfter !== masterBefore) {
      edits.push({ path: MASTER_PROMPT_FILE, before: masterBefore, after: masterAfter });
    }
  }

  for (const platform of platforms) {
    const path = PLATFORM_ENTRY_FILES[platform];
    if (!path) continue;
    const before = await readRepoFile(root, path);
    if (!opts.force && before !== null && !before.includes(ENTRY_MARKER)) continue;
    const after = renderEntryPointer(platform, path);
    if (after !== before) edits.push({ path, before, after });
  }
  return edits;
}
