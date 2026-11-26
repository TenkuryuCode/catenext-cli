import type { PlatformId } from "@catenext/shared";
import { readRepoFile } from "../init/repo-files.js";
import type { FileEdit } from "../maintenance.js";

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

/** Thin redirect so IDE-native entry files land on the master prompt. */
export function renderEntryPointer(platform: PlatformId, entryPath: string): string {
  const link = masterLinkFrom(entryPath);
  return [
    ENTRY_MARKER,
    `# ${platform} · Catenext entry`,
    "",
    `**New session:** open **[${MASTER_PROMPT_FILE}](${link})** first (master prompt).`,
    "",
    "Then follow [AGENTS.md](" +
      masterLinkFrom(entryPath).replace("CATENEXT.md", "AGENTS.md") +
      ") for full orchestrator rules.",
    "",
    "Do not duplicate the master prompt here — this file is only a pointer.",
    "",
    "Useful: `catenext brief` · `catenext board` · `catenext sync`.",
    "",
  ].join("\n");
}

export function renderClaudeEntry(): string {
  return [
    ENTRY_MARKER,
    "# Claude Code · Catenext entry",
    "",
    `**New / first session:** read **[${MASTER_PROMPT_FILE}](./${MASTER_PROMPT_FILE})** before anything else.`,
    "",
    "That file is the master prompt. Detailed orchestrator rules: [AGENTS.md](./AGENTS.md).",
    "Persona agents: `.claude/agents/`.",
    "",
    "Commands: `catenext brief` · `catenext board` · `catenext sync --platform claude-code`.",
    "",
  ].join("\n");
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
    const after =
      platform === "claude-code" ? renderClaudeEntry() : renderEntryPointer(platform, path);
    if (after !== before) edits.push({ path, before, after });
  }
  return edits;
}
