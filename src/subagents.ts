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
    "- Cold start: human/orchestrator read `CATENEXT.md` then `AGENTS.md`.",
    "- After claim, read document `sync-board` if present (kickoff contracts / open asks).",
    "- Prefer MCP `get_project_context` + claim payload over dumping the whole repo.",
    "- Use `graph_neighbors` / `symbol_search` only for files you will touch.",
    "- Cite paths in handoffs; **never publish** credentials or critical secrets (or large code dumps).",
    "",
    "## Cross-agent asks",
    "",
    "If you need another persona's area: report to orchestrator",
    "`ASK: <persona> · NEED: <one line> · BLOCKS: <task id>` — do not open a private side channel.",
    "Skill: `cross-agent-sync`.",
    "",
    "## Workflow (one task per call, dedicated worktree)",
    "",
    `1. \`get_project_context\` with \`agent_alias: ${alias}\`.`,
    `2. \`get_ready_tasks\` with \`agent_alias: ${alias}\`; pick the top task or stop if empty.`,
    `3. \`claim_task\` with \`task_id\` + \`agent_alias: ${alias}\` + **worktree** (unique branch/session). Required for monorepo; required whenever other subagents run in parallel.`,
    "4. Read `sync-board`; implement, test, commit **only** on that worktree branch. Never merge default/`main`.",
    "5. `complete_handoff` (include branch/PR ref if asked) or `report_blocker`.",
    "6. Report to orchestrator: task, worktree/branch, status, PR URL if any, verify command.",
    "",
    `CLI: \`catenext next --as ${p.alias}\`, \`catenext claim <id> --as ${p.alias} --worktree\`, \`catenext done <id> --lease <id> --notes "..."\`.`,
    "",
    "## Boundaries",
    "",
    `- Only do tasks owned by ${p.alias}.`,
    "- Prefer REVISION_REQUESTED tasks and follow claim feedback.",
    "- Do not call `create_tasks`, `manage_task`, or `upsert_persona`.",
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

function markdownFrontmatter(platform: PlatformId, name: string, description: string): string[] {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (platform === "cursor") {
    lines.push("model: inherit");
  } else if (platform === "antigravity") {
    lines.push("model: inherit", "subagent: true", "mainAgent: false");
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
    ...markdownFrontmatter(platform, p.alias, personaDescription(p)),
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
    "GOAL: …",
    "SCOPE: …",
    "CONTEXT: stack, docs, handoffs",
    "CONSTRAINTS: dedicated worktree; no merge to main",
    "DONE WHEN: …",
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
    "Delegate with GOAL/SCOPE/CONTEXT/CONSTRAINTS/DONE WHEN. Do not implement persona tasks unless asked.",
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
    "Delegate with GOAL/SCOPE/CONTEXT/CONSTRAINTS/DONE WHEN.",
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
