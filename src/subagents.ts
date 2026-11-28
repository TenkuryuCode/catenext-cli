import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpToolOutput, PlatformId } from "@catenext/shared";
import type { FileEdit } from "./maintenance.js";

/**
 * Persona + orchestrator agent stubs in IDE/CLI-native layouts.
 * Content body is English; Q&A language is handled by the orchestrator at runtime.
 * Rename aliases/rules via `catenext persona set` — keep this file format stable.
 */
export const SUBAGENT_MARKER = "<!-- catenext:persona -->";
export const ORCHESTRATOR_MARKER = "<!-- catenext:orchestrator -->";

export const SUBAGENT_DIRS: Partial<Record<PlatformId, string>> = {
  "claude-code": join(".claude", "agents"),
  cursor: join(".cursor", "agents"),
  /** Antigravity discovers `.agents/agents/*.md` (native). */
  antigravity: join(".agents", "agents"),
  opencode: join(".opencode", "agents"),
  /** Codex custom agents are TOML under `.codex/agents/`. */
  codex: join(".codex", "agents"),
  /** VS Code Copilot harness discovers workspace agents under `.github/agents/`. */
  vscode: join(".github", "agents"),
};

/** Pre-v0.11 Antigravity path — still cleaned on remove/sync. */
export const LEGACY_SUBAGENT_DIRS: readonly string[] = [join(".agents", "catenext")];

/** @deprecated use SUBAGENT_DIRS["claude-code"] */
export const SUBAGENTS_DIR = join(".claude", "agents");

type PersonaItem = Omit<McpToolOutput<"list_personas">["personas"][number], "id">;

export type AgentRenderContext = {
  stack: string[];
  personas: PersonaItem[];
  repoName?: string;
  layout?: "monorepo" | "polyrepo";
};

export function subagentExtension(platform: PlatformId): "md" | "toml" {
  return platform === "codex" ? "toml" : "md";
}

function stackLine(stack: string[]): string {
  return stack.length ? stack.join(", ") : "(stack not set — update .catenext/config.yaml)";
}

function routingTable(personas: PersonaItem[]): string[] {
  const lines = ["| Persona | Role | When to call |", "| --- | --- | --- |"];
  for (const p of personas) {
    const when = p.rules[0]?.slice(0, 80) || `Tasks owned by \`${p.alias}\` / role \`${p.role}\``;
    lines.push(`| \`${p.alias}\` | ${p.role} | ${when} |`);
  }
  return lines;
}

function isReviewerPersona(p: PersonaItem): boolean {
  const role = p.role.toLowerCase();
  const alias = p.alias.toLowerCase();
  return role === "reviewer" || alias === "reviewer";
}

function isReadVerifyPersona(p: PersonaItem): boolean {
  const role = p.role.toLowerCase();
  const alias = p.alias.toLowerCase();
  return isReviewerPersona(p) || role === "docs" || role === "scribe" || alias === "scribe";
}

function personaDescription(p: PersonaItem): string {
  return `Catenext persona "${p.alias}" (role ${p.role}). Use when asked "${p.alias}, work on" or for tasks owned by ${p.alias}. One task, then report.`;
}

/** Shared English body for persona stubs (frontmatter / TOML wrap separately). */
export function renderSubagentBody(
  p: PersonaItem,
  ctx: AgentRenderContext = { stack: [], personas: [] },
): string {
  const rules =
    p.rules.length > 0
      ? p.rules.map((r) => `- ${r}`)
      : ["- (no rules yet — set via catenext persona set)"];
  const alias = JSON.stringify(p.alias);
  const stack = stackLine(ctx.stack);
  const isReviewer = isReviewerPersona(p);
  const contextBullets = isReviewer
    ? [
        "- Cold start: human/orchestrator read `CATENEXT.md` then `AGENTS.md`.",
        '- `review_pull_request` (`action: "claim"`, `include_context: true`) already returns `review_context_pack` (`diff_meta`, `handoff_decisions`, `verification_command`, `epic_summary_excerpt`, `sync_board_excerpt`, `detail_pointers`) — skip redundant `get_project_context`.',
        "- If extra doc or diff detail is needed beyond `review_context_pack`, use `detail_pointers.git_diff_command` or call `get_document` with `outline_only: true` or `section`.",
        "- Prefer `graph_neighbors` with `paths[]` (batch up to 5) instead of 1-file-per-call; use `symbol_search` / `search_context` only for files under review.",
        "- Cite paths and `head_sha` in review feedback; **never publish** credentials or critical secrets (or large code dumps).",
      ]
    : [
        "- Cold start: human/orchestrator read `CATENEXT.md` then `AGENTS.md`.",
        "- `claim_task` with `include_context: true` already returns `context_pack` (`epic_summary`, `sync_board_excerpt`, `skills_hint`, `graph_slice`), `scope_files`, `verify_command`, and `doc_refs` — skip redundant `get_project_context`.",
        "- If extra doc is needed beyond `context_pack`, call `get_document` with `outline_only: true` or `section`.",
        "- Prefer `graph_neighbors` with `paths[]` (batch up to 5) instead of 1-file-per-call; use `symbol_search` only for files you will touch.",
        "- Cite paths in handoffs; **never publish** credentials or critical secrets (or large code dumps).",
      ];
  const workflowSection = isReviewer
    ? [
        "## Workflow (one review per call, read-only)",
        "",
        `1. **Fast-path (\`TASK_ID\` in brief):** skip \`get_project_context\` and \`get_ready_tasks\`; call \`review_pull_request\` directly with \`action: "claim"\`, \`task_id\`, \`agent_alias: ${alias}\`, \`compact: true\`, \`include_context: true\` (include \`head_sha\` if provided).`,
        `2. **No \`TASK_ID\` in brief:** call \`review_pull_request\` with \`action: "list"\` (pick a \`NEEDS_REVIEW\` task or stop if empty), then \`review_pull_request\` with \`action: "claim"\`, \`compact: true\`, \`include_context: true\`.`,
        '3. Inspect `review_context_pack` first; use `detail_pointers.git_diff_command`, `get_document` (`outline_only` / `section`), `graph_neighbors` (`paths[]`, up to 5), or `search_context` only when needed. If the handoff commit moves, call `review_pull_request` with `action: "refresh"`.',
        "4. Run read-only verification if needed; do **not** edit files, create worktrees, or merge default/`main`.",
        '5. Submit local recommendation via `review_pull_request` (`action: "submit"`, `task_id`, `lease_id`, `head_sha`, `decision: "approve" | "request_changes"`, `feedback`) or `report_blocker`. (`approve` is a recommendation only; human runs `catenext review approve`.)',
        "6. Report to orchestrator: task, `head_sha`, `decision`, key findings, and verify output.",
        "",
        `CLI: \`catenext review list\`, \`catenext review claim <id> --as ${p.alias} --include-context --compact\`, \`catenext review refresh <id> --include-context\`, \`catenext review submit <id> --lease <id> --sha <sha> --decision <approve|request_changes> --feedback "..."\`.`,
      ]
    : [
        "## Workflow (one task per call, dedicated worktree)",
        "",
        `1. **Fast-path (\`TASK_ID\` in brief):** skip \`get_project_context\` and \`get_ready_tasks\`; call \`claim_task\` directly with \`task_id\`, \`agent_alias: ${alias}\`, \`worktree\` (unique branch/session), \`compact: true\`, \`include_context: true\`.`,
        `2. **No \`TASK_ID\` in brief:** call \`get_ready_tasks\` with \`agent_alias: ${alias}\` (pick top task or stop if empty), then \`claim_task\` with \`compact: true\`, \`include_context: true\`, and \`worktree\`.`,
        "3. Use `context_pack` from claim; only fetch extra docs via `get_document` (`outline_only` / `section`) or `graph_neighbors` (`paths[]`, up to 5) when needed.",
        "4. Implement, test, commit **only** on that worktree branch. Never merge default/`main`.",
        "5. `complete_handoff` (keep `notes_for_next_agent` concise: decisions, changed contracts, file paths; include branch/PR ref if asked) or `report_blocker`.",
        "6. Report to orchestrator: task, worktree/branch, status, PR URL if any, verify command.",
        "",
        `CLI: \`catenext next --as ${p.alias}\`, \`catenext claim <id> --as ${p.alias} --worktree\`, \`catenext done <id> --lease <id> --notes "..."\`.`,
      ];
  const ownershipBoundaries = isReviewer
    ? [
        "- Only review `NEEDS_REVIEW` handoffs; never approve final `DONE` status (human-only) or merge to main.",
      ]
    : [
        `- Only do tasks owned by ${p.alias}.`,
        "- Prefer REVISION_REQUESTED tasks and follow claim feedback.",
      ];
  return [
    `You are Catenext persona **${p.alias}** (role: ${p.role}).`,
    "",
    "## Project context",
    "",
    `- Stack: ${stack}`,
    ...(ctx.repoName ? [`- Default repo_name: \`${ctx.repoName}\``] : []),
    ...(ctx.layout ? [`- Layout: \`${ctx.layout}\``] : []),
    ...(p.repos.length > 0
      ? [`- Owned repos: ${p.repos.map((r) => `\`${r}\``).join(", ")}. Work from that checkout.`]
      : ["- Owned repos: (any in this project unless task sets target_repo)"]),
    "",
    "## Powerful context (keep compact)",
    "",
    ...contextBullets,
    "",
    "## Cross-agent asks",
    "",
    "If you need another persona's area: report to orchestrator",
    "`ASK: <persona> · NEED: <one line> · BLOCKS: <task id>` — do not open a private side channel.",
    "Skill: `cross-agent-sync`.",
    "",
    ...workflowSection,
    "",
    "## Boundaries",
    "",
    ...ownershipBoundaries,
    "- Do not call `create_tasks`, `manage_task`, or `upsert_persona`.",
    ...(isReadVerifyPersona(p)
      ? [
          "- Tool capabilities: read/verify only (inspect files, search code, run read-only verification); do not edit application code.",
        ]
      : [
          "- Tool capabilities: write/terminal enabled (edit files in scope and run tests/builds in your worktree).",
        ]),
    ...(p.alias === "scribe"
      ? ["- Exception: you may `save_document` for project docs hygiene (skill `docs-hygiene`)."]
      : ["- Do not call `save_document` unless you are persona `scribe` on a docs task."]),
    "- Do not integrate other personas' worktrees or merge to main — orchestrator + human decide PR vs merge.",
    "- If you lack research/fetch/browser (or other required access): stop, report to orchestrator — do not invent external facts.",
    "- Never copy API keys, tokens, passwords, private keys, or `.env` values into handoffs/docs/git.",
    "",
    "## Rules (customizable)",
    "",
    ...rules,
    "",
  ].join("\n");
}

function markdownFrontmatter(
  platform: PlatformId,
  name: string,
  description: string,
  persona?: PersonaItem,
): string[] {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (platform === "cursor") {
    lines.push("model: inherit");
  } else if (platform === "antigravity") {
    lines.push("model: inherit", "subagent: true", "mainAgent: false");
    if (persona && isReadVerifyPersona(persona)) {
      lines.push("disallowedTools: [write_file, edit_file]");
    }
  }
  lines.push("---");
  return lines;
}

function tomlQuote(value: string): string {
  if (!value.includes("\n") && !value.includes('"') && !value.includes("\\")) {
    return `"${value}"`;
  }
  return JSON.stringify(value);
}

/** Markdown stub (Claude Code / Cursor / Antigravity / OpenCode). */
export function renderSubagent(
  p: PersonaItem,
  ctx: AgentRenderContext = { stack: [], personas: [] },
  platform: PlatformId = "claude-code",
): string {
  if (platform === "codex") return renderCodexSubagent(p, ctx);
  return [
    ...markdownFrontmatter(platform, p.alias, personaDescription(p), p),
    SUBAGENT_MARKER,
    "<!-- Generated by `catenext sync` from local personas; edit via `catenext persona set`, not this file. Format is stable across IDE/CLI. -->",
    "",
    renderSubagentBody(p, ctx),
  ].join("\n");
}

/** Codex native custom agent (TOML: name, description, developer_instructions). */
export function renderCodexSubagent(
  p: PersonaItem,
  ctx: AgentRenderContext = { stack: [], personas: [] },
): string {
  const body = renderSubagentBody(p, ctx).trimEnd();
  return [
    `# ${SUBAGENT_MARKER}`,
    "# Generated by `catenext sync` from local personas; edit via `catenext persona set`, not this file.",
    `name = ${tomlQuote(p.alias)}`,
    `description = ${tomlQuote(personaDescription(p))}`,
    `developer_instructions = ${tomlQuote(body)}`,
    "",
  ].join("\n");
}

/** OpenCode-style orchestrator agent (YAML frontmatter + structured body). Reference layout only. */
export function renderOrchestratorAgent(ctx: AgentRenderContext): string {
  const stack = stackLine(ctx.stack);
  return [
    "---",
    "description: >-",
    "  Primary Catenext orchestrator. Plans tasks, delegates to persona subagents,",
    "  presents human approvals with options, keeps stack/context compact.",
    "mode: primary",
    "---",
    ORCHESTRATOR_MARKER,
    "<!-- Generated by catenext sync. Source of truth remains AGENTS.md — keep this file aligned. -->",
    "",
    "## Identity",
    "",
    "- You are the **orchestrator**. Do not use `agent_alias`.",
    "- Ask the user first; mirror their language for Q&A.",
    "- Agent stubs and tool names stay English.",
    "",
    "## Session start",
    "",
    "1. Read **CATENEXT.md** (master prompt), then **AGENTS.md**.",
    "2. `session_brief` → present `pending_approvals` with options approve / revise / next.",
    "3. Note stack, personas, and **active worktrees** before delegating.",
    "",
    `## Stack`,
    "",
    stack,
    "",
    "## Subagent routing",
    "",
    ...routingTable(ctx.personas),
    "",
    "## Parallel worktrees",
    "",
    "- Each concurrent persona gets its own worktree/branch.",
    "- Track task → persona → worktree/branch → status.",
    "- After handoffs: review all worktrees, integrate/edit if needed, then ask human: **PR | merge | revise | next**.",
    "",
    "## Human approval",
    "",
    "When DRAFT or NEEDS_REVIEW needs a human:",
    "",
    "```text",
    "APPROVAL NEEDED · task <id> · <title> · <status> · worktree/branch",
    "summary: …",
    "Options: 1) approve  2) revise <feedback>  3) next",
    "```",
    "",
    "User may reply in chat or pick a number. Then run the matching CLI/MCP action.",
    "",
    "## Delegation brief",
    "",
    "```text",
    "TASK_ID: <uuid>",
    "WORKTREE: <branch> (from <base>)",
    "GOAL: <measurable outcome>",
    "FILES: <allowed paths>",
    "CONTRACTS: <schemas/docs/handoffs>",
    "VERIFY: <command>",
    "CONSTRAINTS: dedicated worktree; no merge to main",
    "DONE WHEN: verify passes; concise complete_handoff",
    "```",
    "",
    "## Safety",
    "",
    "- No invented test/merge results.",
    "- Never publish credentials/secrets in handoffs, docs, commits, or PRs — paths only.",
    "- Never merge default without explicit human choice (prefer PR).",
    "- Destructive actions require explicit human confirmation.",
    "",
  ].join("\n");
}

/** Claude/Cursor/Antigravity-style orchestrator stub (lighter frontmatter). */
export function renderOrchestratorStub(
  ctx: AgentRenderContext,
  platform: PlatformId = "claude-code",
): string {
  if (platform === "codex") return renderCodexOrchestrator(ctx);
  const description =
    "Catenext orchestrator — plan, delegate, present human approvals. Read AGENTS.md first.";
  return [
    ...markdownFrontmatter(platform, "orchestrator", description),
    ORCHESTRATOR_MARKER,
    "",
    "Read **CATENEXT.md** then **AGENTS.md** at session start. Prefer `session_brief`.",
    "",
    `Stack: ${stackLine(ctx.stack)}`,
    "",
    "Personas:",
    ...ctx.personas.map((p) => `- \`${p.alias}\` (${p.role})`),
    "",
    "Parallel subagents → separate worktrees. You track all worktrees; integrate then ask human: PR | merge | revise | next.",
    "Present pending approvals as: approve / revise / next.",
    "Delegate with TASK_ID/WORKTREE/GOAL/FILES/CONTRACTS/VERIFY/CONSTRAINTS/DONE WHEN. Do not implement persona tasks unless asked.",
    "",
  ].join("\n");
}

export function renderCodexOrchestrator(ctx: AgentRenderContext): string {
  const body = [
    "You are the Catenext orchestrator. Do not use agent_alias.",
    "Read CATENEXT.md then AGENTS.md at session start. Prefer session_brief.",
    `Stack: ${stackLine(ctx.stack)}`,
    "Personas:",
    ...ctx.personas.map((p) => `- ${p.alias} (${p.role})`),
    "Parallel subagents → separate worktrees. Integrate then ask human: PR | merge | revise | next.",
    "Present pending approvals as: approve / revise / next.",
    "Delegate with TASK_ID/WORKTREE/GOAL/FILES/CONTRACTS/VERIFY/CONSTRAINTS/DONE WHEN.",
  ].join("\n");
  return [
    `# ${ORCHESTRATOR_MARKER}`,
    "# Generated by catenext sync. Source of truth remains AGENTS.md.",
    `name = ${tomlQuote("orchestrator")}`,
    `description = ${tomlQuote("Catenext orchestrator — plan, delegate, present human approvals. Read AGENTS.md first.")}`,
    `developer_instructions = ${tomlQuote(body)}`,
    "",
  ].join("\n");
}

const readOrNull = (p: string) =>
  readFile(p, "utf8").then(
    (s) => s,
    () => null,
  );

async function planDir(
  root: string,
  dir: string,
  personas: PersonaItem[],
  ctx: AgentRenderContext,
  platform: PlatformId,
  force = false,
): Promise<{ edits: FileEdit[]; skipped: string[] }> {
  const edits: FileEdit[] = [];
  const skipped: string[] = [];
  const wanted = new Set<string>();
  const ext = subagentExtension(platform);

  const orchPath = join(dir, `orchestrator.${ext}`);
  wanted.add(orchPath);
  const orchBefore = await readOrNull(join(root, orchPath));
  if (
    !force &&
    orchBefore !== null &&
    !orchBefore.includes(ORCHESTRATOR_MARKER) &&
    !orchBefore.includes(SUBAGENT_MARKER)
  ) {
    skipped.push(orchPath);
  } else {
    const orchAfter =
      platform === "opencode"
        ? renderOrchestratorAgent(ctx)
        : renderOrchestratorStub(ctx, platform);
    if (orchAfter !== orchBefore)
      edits.push({ path: orchPath, before: orchBefore, after: orchAfter });
  }

  for (const p of personas) {
    const path = join(dir, `${p.alias}.${ext}`);
    wanted.add(path);
    const before = await readOrNull(join(root, path));
    if (!force && before !== null && !before.includes(SUBAGENT_MARKER)) {
      skipped.push(path);
      continue;
    }
    const after = renderSubagent(p, ctx, platform);
    if (after !== before) edits.push({ path, before, after });
  }
  for (const path of await catenextAgentFilesIn(root, dir)) {
    if (!wanted.has(path)) {
      edits.push({ path, before: await readOrNull(join(root, path)), after: null });
    }
  }
  return { edits, skipped };
}

/** Plan agent stubs for configured platforms that have a known agents directory. */
export async function planSubagents(
  root: string,
  personas: PersonaItem[],
  platforms: readonly PlatformId[] = ["claude-code"],
  ctx: Partial<AgentRenderContext> = {},
  opts: { force?: boolean } = {},
): Promise<{ edits: FileEdit[]; skipped: string[] }> {
  const fullCtx: AgentRenderContext = {
    stack: ctx.stack ?? [],
    personas,
    repoName: ctx.repoName,
    layout: ctx.layout,
  };
  const edits: FileEdit[] = [];
  const skipped: string[] = [];
  const plannedDirs = new Map<string, PlatformId>();
  for (const platform of platforms) {
    const dir = SUBAGENT_DIRS[platform];
    if (dir) plannedDirs.set(dir, platform);
  }
  for (const [dir, platform] of plannedDirs) {
    const planned = await planDir(root, dir, personas, fullCtx, platform, Boolean(opts.force));
    edits.push(...planned.edits);
    skipped.push(...planned.skipped);
  }
  return { edits, skipped };
}

async function catenextAgentFilesIn(root: string, dir: string): Promise<string[]> {
  const names = await readdir(join(root, dir)).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names.filter((name) => name.endsWith(".md") || name.endsWith(".toml")).sort()) {
    const path = join(dir, n);
    const body = await readOrNull(join(root, path));
    if (body?.includes(SUBAGENT_MARKER) || body?.includes(ORCHESTRATOR_MARKER)) out.push(path);
  }
  return out;
}

/** Catenext-managed agent files across known dirs (or only dirs for `platforms`). */
export async function catenextSubagentFiles(
  root: string,
  platforms?: readonly PlatformId[],
): Promise<string[]> {
  const dirs = platforms
    ? new Set(platforms.map((p) => SUBAGENT_DIRS[p]).filter((d): d is string => Boolean(d)))
    : new Set(Object.values(SUBAGENT_DIRS).filter((d): d is string => Boolean(d)));
  // Always scan legacy Antigravity path when cleaning all or antigravity.
  if (!platforms || platforms.includes("antigravity")) {
    for (const legacy of LEGACY_SUBAGENT_DIRS) dirs.add(legacy);
  }
  const out: string[] = [];
  for (const dir of dirs) {
    out.push(...(await catenextAgentFilesIn(root, dir)));
  }
  return out;
}
