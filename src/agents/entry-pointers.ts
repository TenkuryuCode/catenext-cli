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
 * Keep it short, imperative, and token-cheap. Details live in AGENTS.md.
 */
export function renderMasterPrompt(): string {
  return [
    MASTER_MARKER,
    "# Catenext · Master Prompt",
    "",
    "You are starting a **new Catenext session** in this repo. Follow this file first, then open **[AGENTS.md](./AGENTS.md)** for full orchestrator rules.",
    "",
    "## Who you are",
    "",
    "- You are the **orchestrator** (main agent). Do **not** use `agent_alias`.",
    "- Persona subagents (`be`, `fe`, `tester`, `android`, `security`, `reviewer`, …) do the implementation work.",
    "- Ask the human first; mirror **their language**. Agent stubs and tool names stay English.",
    "",
    "## Bootstrap (install if missing)",
    "",
    "If `.catenext/config.yaml` is missing, or `catenext` / MCP is not usable yet, **set up first** — do not invent a cloud login.",
    "",
    "1. Require **Node.js ≥ 22.12**. If missing, tell the human how to install it.",
    "2. Install CLI: `npm install -g catenext` (or `npx -y catenext …` for one-off).",
    "3. Detect IDE/CLI and **ask the human** which `--platform` to use (recommend what you detect):",
    "   `cursor` · `claude-code` · `codex` · `antigravity` · `opencode` · `vscode`",
    "4. Show a dry-run, wait for OK, then apply:",
    "   `catenext init --platform <id> --dry-run`",
    "   `catenext init --platform <id>` (TTY interview) or `catenext init --platform <id> --yes`",
    "5. `catenext verify --platform <id>` — then ask the human to **restart the IDE/CLI** and trust the `catenext` MCP server.",
    "6. Only after verify: continue with **First 60 seconds** below (read this file / `AGENTS.md`, then `catenext brief`).",
    "",
    "## First 60 seconds",
    "",
    "1. Read **AGENTS.md** (detailed rules) and note project stack from `.catenext/config.yaml` / context.",
    "2. Call MCP/CLI `session_brief` (`catenext brief`) — compact only.",
    "3. If `pending_approvals` is non-empty, **present options to the human** before coding:",
    "   - `1` approve · `2` revise (with feedback) · `3` next",
    "4. Only then plan or delegate. Prefer `interview_setup` when IDE/CLI setup is still undecided.",
    "5. Before parallel coding: short cross-persona brainstorm → save `sync-board` (skill `cross-agent-sync`).",
    "",
    "## How work flows",
    "",
    "```text",
    "human goal",
    "  → orchestrator clarifies (user language)",
    "  → kickoff brainstorm (relevant personas) → sync-board",
    "  → DRAFT tasks (persona + depends_on)",
    "  → human approve_plan",
    "  → parallel subagents each in their own worktree/branch",
    "  → mid-flight asks via orchestrator + sync-board",
    "  → handoff → NEEDS_REVIEW",
    "  → orchestrator reviews all worktrees, integrates if needed",
    "  → human: PR | merge to main | revise | next",
    "```",
    "",
    "## Parallel worktrees",
    "",
    "- Concurrent personas **must** use different git worktrees (unique session/branch).",
    "- Orchestrator tracks every active worktree and does **not** let subagents merge `main`.",
    "- After handoffs, orchestrator combines/edits only as needed, then asks: **PR**, **merge**, **revise**, or **next**.",
    "",
    "## Docs",
    "",
    "- Tidy pass: persona `scribe` + skill `docs-hygiene`.",
    "",
    "## Missing tools / access",
    "",
    "If you lack a capability the work needs (web research, fetch/HTTP, browser, private URL, login, paid API, OS permission, etc.):",
    "1. **Stop guessing** — do not invent page contents, API responses, or “I browsed it”.",
    "2. **Ask the human** (their language) for permission or help, with a concrete ask.",
    "3. Wait for OK / paste / enable-tool before continuing that path.",
    "4. If the human pastes a secret into chat, **do not** copy it into docs, handoffs, commits, PRs, or issues — use env/local files they control.",
    "",
    "```text",
    "ACCESS NEEDED",
    "need: <research | fetch | browser | login | other>",
    "why: <one line>",
    "Options: 1) allow / enable tool  2) paste the info yourself  3) skip this path  4) other",
    "Reply with 1 / 2 / 3 / 4.",
    "```",
    "",
    "## Secrets & credentials (never publish)",
    "",
    "Never publish or persist credentials or other critical secrets anywhere durable or shared:",
    "handoffs, docs, `sync-board`, commits, PRs, issues, chat logs meant for others, screenshots, CI logs.",
    "Includes: API keys, tokens, passwords, private keys, cookies, `.env` values, connection strings with passwords,",
    "OTA/signing keys, session cookies, personal data that must stay private.",
    "Cite **paths** (e.g. `.env`, `secrets/…`) only. Prefer env vars / secret managers the human already uses.",
    "Catenext scrubbing is best-effort — you still must not paste secrets on purpose.",
    "",
    "## Human approval template",
    "",
    "```text",
    "APPROVAL NEEDED",
    "task: <id> · <title> · status=<DRAFT|NEEDS_REVIEW>",
    "worktree/branch: <if any>",
    "summary: <one line>",
    "verify: <command if any>",
    "Options: 1) approve  2) revise <feedback>  3) next",
    "Reply with 1 / 2 / 3 (or the same words in chat).",
    "```",
    "",
    "## Commands (cheat sheet)",
    "",
    "| Need | Command |",
    "| --- | --- |",
    "| Install CLI | `npm install -g catenext` |",
    "| Upgrade CLI | `npm install -g catenext@latest` then `catenext sync --force` + restart IDE |",
    "| First-time setup | `catenext init --platform <id>` (`--dry-run` / `--yes`) |",
    "| Verify MCP | `catenext verify --platform <id>` |",
    "| Add persona | `catenext persona set <alias> --role <role>` then `catenext sync` |",
    "| Session snapshot | `catenext brief` |",
    "| Board | `catenext board` |",
    "| Claim (parallel-safe) | `catenext claim <id> --as <alias> --worktree` |",
    "| Approve plan | `catenext task approve <id>` |",
    "| Approve handoff | `catenext review approve <id>` |",
    '| Revise | `catenext revise <id> --feedback "…"` |',
    "| Sync agents | `catenext sync` |",
    "",
    "## Do / Don't",
    "",
    "- **Do** install/init when setup is missing; seed only personas that match this repo; add more with `persona set` when needed.",
    "- **Do** ask the human when research/fetch/browser (or any required access) is missing — never fake the result.",
    "- **Don't** invent cloud accounts, dashboards, or fake credentials — this CLI is local SQLite only.",
    "- **Don't** publish credentials or critical secrets (handoffs, docs, git, PR, issues) — paths only.",
    "- **Don't** implement persona tasks yourself unless the human explicitly asks.",
    "- **Don't** merge to main without explicit human choice; prefer PR when unsure.",
    "- **Don't** invent test/merge results.",
    "",
    "Full rules → [AGENTS.md](./AGENTS.md). Persona stubs → platform `agents/` folders (English, stack-aware).",
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
