import { MCP_TOOL_NAMES, MCP_TOOLS, type McpToolName } from "@catenext/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { LocalService } from "../local-service.js";
import { describeRedactions, scrubDeep } from "../scrubber.js";
import { loadSkill, saveSkill } from "../skills.js";

export const LOCAL_TOOLS = MCP_TOOL_NAMES;

export const SERVER_INSTRUCTIONS = [
  "Catenext stores local orchestration state in SQLite (.catenext/catenext.sqlite).",
  "Orchestrator: ask the user first in their language; agent stubs stay English; prefer session_brief and interview_setup (compact JSON, no essays).",
  "Delegate only — do not implement persona tasks. Use get_project_board when needed; keep payloads short.",
  "Workers: get_ready_tasks then claim_task (worktree required for monorepo). complete_handoff → NEEDS_REVIEW.",
  "Human approve_plan/approve stays on the CLI. Revisions reuse the same task.",
  "External folders: manage_roots. Code graph: catenext index then graph_neighbors / symbol_search.",
  "Never publish credentials or critical secrets (handoffs/docs/git — paths only). No code dumps. Do not hand-edit .catenext/config.yaml or IDE MCP configs.",
].join(" ");

export type ServerContext =
  | { ok: true; service: Pick<LocalService, "callTool">; root: string }
  | { ok: false; error: string };

type ReadyContext = Extract<ServerContext, { ok: true }>;

export interface ServerOptions {
  version: string;
  /** Muat konteks saat tool pertama dipanggil, agar server bisa memberi pesan bila belum init. */
  context: () => Promise<ServerContext>;
  log?: (message: string) => void;
}

const text = (body: string): CallToolResult => ({
  content: [{ type: "text", text: body }],
  isError: true,
});

/** Compact JSON (no pretty-print) to save tokens. */
const json = (data: unknown, notes: string[] = []): CallToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(data) },
    ...notes.map((n) => ({ type: "text" as const, text: n })),
  ],
});

function zodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

/** Rawatan nilai identitas terstruktur agar scrubber hanya mengubah teks bebas. */
const SCRUB_FIELDS: Partial<Record<McpToolName, readonly string[]>> = {
  complete_handoff: ["task_id", "last_commit_hash", "head_sha", "lease_id"],
  report_blocker: ["task_id", "category", "lease_id"],
  review_pull_request: ["action", "task_id", "head_sha", "lease_id", "agent_alias", "decision"],
  manage_task: ["action", "task_id", "agent_alias", "role"],
  save_document: ["slug", "kind", "expected_version"],
  search_context: ["sources", "limit"],
  create_epic: [],
  create_tasks: ["epic_id", "ref", "depends_on", "target_repo", "role", "persona"],
  upsert_persona: ["alias", "role", "repos"],
  save_repo_skill: ["name"],
  manage_roots: ["action", "persona", "root_id"],
  graph_neighbors: ["path"],
  symbol_search: ["query"],
};

const LOCAL_DESCRIPTIONS: Partial<Record<McpToolName, string>> = {
  review_pull_request: "Local PR review queue/claim/submit. Does not verify remote merge status.",
  complete_handoff:
    "Store structured handoff (optional PR). Status NEEDS_REVIEW until local approve.",
  session_brief: "Compact ready/blocked/next-ask lines for the orchestrator.",
  interview_setup: "Compact IDE/CLI/persona/locale option cards; wait for user choice.",
};

export function createCatenextMcpServer(opts: ServerOptions): McpServer {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[catenext] ${m}\n`));
  const server = new McpServer(
    { name: "catenext", version: opts.version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const call = async (
    name: McpToolName,
    input: unknown,
    run: (ctx: ReadyContext, payload: unknown) => Promise<unknown>,
  ): Promise<CallToolResult> => {
    try {
      const ctx = await opts.context();
      if (!ctx.ok) return text(`Catenext belum siap: ${ctx.error}`);
      const keep = SCRUB_FIELDS[name];
      if (!keep) return json(await run(ctx, input));
      const scrubbed = scrubDeep(input, new Set(keep));
      // Sensor dapat mengubah ukuran payload; validasi ulang sebelum disimpan.
      const parsed = MCP_TOOLS[name].input.safeParse(scrubbed.value);
      if (!parsed.success) return text(`Input ditolak:\n${zodIssues(parsed.error)}`);
      const notes: string[] = [];
      if (scrubbed.total > 0) {
        const note = describeRedactions(scrubbed);
        log(note);
        notes.push(note);
      }
      return json(await run(ctx, parsed.data), notes);
    } catch (err) {
      return text(`Catenext: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  for (const name of LOCAL_TOOLS) {
    const { description, input } = MCP_TOOLS[name];
    server.registerTool(
      name,
      { description: LOCAL_DESCRIPTIONS[name] ?? description, inputSchema: input },
      (payload: unknown) =>
        call(name, payload, async ({ service, root }, parsed) => {
          if (name === "load_skill") {
            const { name: skillName, revision } = MCP_TOOLS.load_skill.input.parse(parsed);
            const skill = await loadSkill(root, skillName, revision);
            return {
              name: skill.name,
              when_to_use: skill.when_to_use,
              content: skill.content,
              ...(revision ? { revision } : {}),
            };
          }
          if (name === "save_repo_skill") {
            const saved = await saveSkill(root, MCP_TOOLS.save_repo_skill.input.parse(parsed));
            return { path: saved.path, created: saved.created };
          }
          return service.callTool(name, parsed);
        }),
    );
  }

  return server;
}
