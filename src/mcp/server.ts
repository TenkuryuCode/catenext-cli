import { MCP_TOOLS, type McpToolName } from "@catenext/shared";
import type { z } from "zod";
import { requireHumanApproval } from "../approval-policy.js";
import type { LocalService } from "../local-service.js";
import { describeRedactions, SCRUB_TOOL_FIELDS, scrubDeep } from "../scrubber.js";
import { loadSkill, saveSkill } from "../skills.js";
import { buildMcpToolCatalog, type McpRole, toolsForRole } from "./catalog.js";
import {
  JSONRPC_VERSION,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcSuccessResponse,
  type McpTransport,
} from "./stdio.js";

export const LOCAL_TOOLS = toolsForRole();

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

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
  /** Filter tool MCP berdasarkan peran: orchestrator atau worker (default: semua tool). */
  role?: McpRole;
}

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface CatenextMcpServer {
  connect(transport: McpTransport): Promise<void>;
  close(): Promise<void>;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

export function createCatenextMcpServer(opts: ServerOptions): CatenextMcpServer {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[catenext] ${m}\n`));
  const tools = buildMcpToolCatalog(opts.role);
  const allowedTools = new Set<string>(tools.map((tool) => tool.name));
  let activeTransport: McpTransport | undefined;

  const runTool = async (
    { service, root }: ReadyContext,
    name: McpToolName,
    parsed: unknown,
  ): Promise<unknown> => {
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
  };

  const invokeTool = async (name: McpToolName, rawArgs: unknown): Promise<CallToolResult> => {
    try {
      const schema = MCP_TOOLS[name].input;
      const initial = schema.safeParse(rawArgs ?? {});
      if (!initial.success) return text(`Input ditolak:\n${zodIssues(initial.error)}`);
      if (name === "manage_task") {
        requireHumanApproval("agent", MCP_TOOLS.manage_task.input.parse(initial.data));
      }

      const ctx = await opts.context();
      if (!ctx.ok) return text(`Catenext belum siap: ${ctx.error}`);

      const keep = SCRUB_TOOL_FIELDS[name];
      let payload: unknown = initial.data;
      const notes: string[] = [];

      if (keep) {
        const scrubbed = scrubDeep(initial.data, new Set(keep));
        // Sensor dapat mengubah ukuran payload; validasi ulang sebelum disimpan.
        const reparsed = schema.safeParse(scrubbed.value);
        if (!reparsed.success) return text(`Input ditolak:\n${zodIssues(reparsed.error)}`);
        payload = reparsed.data;
        if (scrubbed.total > 0) {
          const note = describeRedactions(scrubbed);
          log(note);
          notes.push(note);
        }
      }

      const result = await runTool(ctx, name, payload);
      return json(result, notes);
    } catch (err) {
      return text(`Catenext: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const sendResult = async (transport: McpTransport, id: JsonRpcId, result: unknown) => {
    if (activeTransport !== transport) return;
    const msg: JsonRpcSuccessResponse = {
      jsonrpc: JSONRPC_VERSION,
      id,
      result: result as JsonRpcSuccessResponse["result"],
    };
    await transport.send(msg);
  };

  const sendError = async (
    transport: McpTransport,
    id: JsonRpcId | null,
    code: number,
    message: string,
  ) => {
    if (activeTransport !== transport) return;
    const msg: JsonRpcErrorResponse = {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message },
    };
    await transport.send(msg);
  };

  const handleMessage = async (transport: McpTransport, raw: unknown) => {
    const envelope = isPlainObject(raw) ? raw : undefined;
    const hasId = envelope !== undefined && Object.hasOwn(envelope, "id");
    const rawId = hasId ? envelope.id : undefined;
    const id = isRequestId(rawId) ? rawId : null;
    const method = envelope?.method;
    const params = envelope?.params;
    if (
      !envelope ||
      envelope.jsonrpc !== JSONRPC_VERSION ||
      typeof method !== "string" ||
      (params !== undefined && !isPlainObject(params)) ||
      (hasId && id === null) ||
      Object.hasOwn(envelope, "result") ||
      Object.hasOwn(envelope, "error")
    ) {
      await sendError(transport, id, JSONRPC_INVALID_REQUEST, "Invalid JSON-RPC 2.0 request.");
      return;
    }

    // Only a valid envelope without an ID is a notification. Never reply to it.
    if (id === null) return;
    try {
      if (method === "initialize") {
        const requested = isPlainObject(params) ? params.protocolVersion : undefined;
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        await sendResult(transport, id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "catenext", version: opts.version },
          instructions: SERVER_INSTRUCTIONS,
        });
        return;
      }

      if (method === "ping") {
        await sendResult(transport, id, {});
        return;
      }

      if (method === "tools/list") {
        await sendResult(transport, id, { tools });
        return;
      }

      if (method === "tools/call") {
        if (!isPlainObject(params) || typeof params.name !== "string") {
          await sendError(transport, id, JSONRPC_INVALID_PARAMS, "Invalid tools/call params.");
          return;
        }
        if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
          await sendError(
            transport,
            id,
            JSONRPC_INVALID_PARAMS,
            "Tool arguments must be an object.",
          );
          return;
        }
        if (!allowedTools.has(params.name)) {
          await sendError(transport, id, JSONRPC_INVALID_PARAMS, `Tool ${params.name} not found`);
          return;
        }
        const result = await invokeTool(params.name as McpToolName, params.arguments);
        await sendResult(transport, id, result);
        return;
      }

      await sendError(transport, id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    } catch (err) {
      await sendError(
        transport,
        id,
        JSONRPC_INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  return {
    async connect(transport: McpTransport): Promise<void> {
      if (activeTransport) {
        await activeTransport.close();
      }
      activeTransport = transport;
      transport.onparseerror = () => {
        void sendError(transport, null, JSONRPC_PARSE_ERROR, "Parse error.");
      };
      transport.onmessage = (msg) => {
        void handleMessage(transport, msg);
      };
      transport.onclose = () => {
        if (activeTransport === transport) activeTransport = undefined;
      };
      await transport.start();
    },
    async close(): Promise<void> {
      const current = activeTransport;
      activeTransport = undefined;
      if (current) await current.close();
    },
  };
}
