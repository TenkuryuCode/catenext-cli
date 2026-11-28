import { buildMcpToolCatalog, toolsForRole } from "./catalog.js";
import { getPrompt, listPrompts } from "./handlers/prompts.js";
import {
  createJsonRpcResponder,
  isMcpLogLevel,
  isPlainObject,
  isRequestId,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type McpLogLevel,
  negotiateProtocolVersion,
  shouldEmitLogLevel,
} from "./handlers/protocol.js";
import {
  listResources,
  listResourceTemplates,
  mutatedResourceUri,
  readResource,
  subscribeResource,
  unsubscribeResource,
} from "./handlers/resources.js";
import { createToolInvoker, handleToolsCall } from "./handlers/tools.js";
import type { HandlerResult, ServerOptions } from "./handlers/types.js";
import { JSONRPC_VERSION, type JsonRpcId, type McpTransport } from "./stdio.js";

export type {
  CallToolResult,
  GetPromptResult,
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpResource,
  McpResourceTemplate,
  ResourceLinkContent,
  ServerContext,
  ServerOptions,
  ToolResultContent,
} from "./handlers/types.js";

export const LOCAL_TOOLS = toolsForRole();

export const SERVER_INSTRUCTIONS = [
  "Catenext stores local orchestration state in SQLite (.catenext/catenext.sqlite).",
  "Orchestrator: ask the user first in their language; agent stubs stay English; prefer session_brief and interview_setup (compact JSON, no essays).",
  "Delegate only — do not implement persona tasks. Use get_project_board and worktree_status when needed; keep payloads short.",
  "Workers: get_ready_tasks then claim_task (worktree required for monorepo; prefer compact:true). complete_handoff → NEEDS_REVIEW. Prefer MCP --role worker for worker sessions and --role reviewer for read-only review sessions.",
  "Approvals: ask first about one exact task and action. Only after its direct explicit human reply, use the conditional CLI with the snapshot shown before asking, then verify the board. MCP cannot approve or attest chat authorship. review_pull_request submit approve is a recommendation only; human uses catenext review approve. Ask separately for merge, tag, or publish. Revisions reuse the same task.",
  "External folders: manage_roots. Code graph: catenext index then graph_neighbors / symbol_search.",
  "Never publish credentials or critical secrets (handoffs/docs/git — paths only). No code dumps. Do not hand-edit .catenext/config.yaml or IDE MCP configs.",
].join(" ");

export interface CatenextMcpServer {
  connect(transport: McpTransport): Promise<void>;
  close(): Promise<void>;
}

export function createCatenextMcpServer(opts: ServerOptions): CatenextMcpServer {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[catenext] ${m}\n`));
  const tools = buildMcpToolCatalog(opts.role, opts.allowCrud);
  const allowedTools = new Set<string>(tools.map((tool) => tool.name));
  let activeTransport: McpTransport | undefined;
  let supportsResourceLinks = false;
  let supportsStructuredContent = false;
  let minLogLevel: McpLogLevel | null = null;
  const subscribedUris = new Set<string>();

  const { sendResult, sendError, sendNotification } = createJsonRpcResponder({
    isActive: (transport) => activeTransport === transport,
    log,
  });

  const emitLog = async (
    transport: McpTransport,
    level: McpLogLevel,
    data: Record<string, unknown>,
    logger = "catenext.mcp",
  ): Promise<void> => {
    if (!minLogLevel || !shouldEmitLogLevel(minLogLevel, level)) return;
    await sendNotification(transport, "notifications/message", {
      level,
      logger,
      data,
    });
  };

  const notifyMutatedResource = async (
    transport: McpTransport,
    toolName: string,
    args: unknown,
  ): Promise<void> => {
    const uri = mutatedResourceUri(toolName, args);
    if (!uri || !subscribedUris.has(uri)) return;
    await sendNotification(transport, "notifications/resources/updated", { uri });
  };

  const setLoggingLevel = (params: unknown): HandlerResult<Record<string, never>> => {
    if (!isPlainObject(params) || !isMcpLogLevel(params.level)) {
      return {
        ok: false,
        code: JSONRPC_INVALID_PARAMS,
        message: "Invalid logging/setLevel params: expected valid level.",
      };
    }
    minLogLevel = params.level;
    return { ok: true, result: {} };
  };

  const invokeTool = createToolInvoker({
    context: opts.context,
    log,
    supportsResourceLinks: () => supportsResourceLinks,
    supportsStructuredContent: () => supportsStructuredContent,
  });

  const sendHandlerResult = async <T>(
    transport: McpTransport,
    id: JsonRpcId,
    outcome: HandlerResult<T>,
  ): Promise<void> => {
    if (outcome.ok) {
      await sendResult(transport, id, outcome.result);
    } else {
      await sendError(transport, id, outcome.code, outcome.message);
    }
  };

  const handleMessage = async (transport: McpTransport, raw: unknown): Promise<void> => {
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
      switch (method) {
        case "initialize": {
          const negotiated = negotiateProtocolVersion(
            isPlainObject(params) ? params.protocolVersion : undefined,
          );
          supportsResourceLinks = negotiated.supportsResourceLinks;
          supportsStructuredContent = negotiated.supportsStructuredContent;
          await sendResult(transport, id, {
            protocolVersion: negotiated.protocolVersion,
            capabilities: {
              tools: {},
              resources: { subscribe: true },
              prompts: {},
              logging: {},
            },
            serverInfo: { name: "catenext", version: opts.version },
            instructions: SERVER_INSTRUCTIONS,
          });
          return;
        }
        case "ping":
          await sendResult(transport, id, {});
          return;
        case "tools/list":
          await sendResult(transport, id, {
            tools: supportsStructuredContent
              ? tools
              : tools.map(({ outputSchema: _outputSchema, ...rest }) => rest),
          });
          return;
        case "resources/list":
          await sendHandlerResult(transport, id, await listResources(opts.context));
          return;
        case "resources/templates/list":
          await sendHandlerResult(transport, id, listResourceTemplates());
          return;
        case "resources/read":
          await sendHandlerResult(transport, id, await readResource(opts.context, params));
          return;
        case "resources/subscribe": {
          const outcome = subscribeResource(subscribedUris, params);
          await sendHandlerResult(transport, id, outcome);
          if (outcome.ok && isPlainObject(params) && typeof params.uri === "string") {
            await emitLog(transport, "debug", { event: "resources/subscribe", uri: params.uri });
          }
          return;
        }
        case "resources/unsubscribe": {
          const outcome = unsubscribeResource(subscribedUris, params);
          await sendHandlerResult(transport, id, outcome);
          if (outcome.ok && isPlainObject(params) && typeof params.uri === "string") {
            await emitLog(transport, "debug", { event: "resources/unsubscribe", uri: params.uri });
          }
          return;
        }
        case "logging/setLevel": {
          const outcome = setLoggingLevel(params);
          await sendHandlerResult(transport, id, outcome);
          if (outcome.ok) {
            await emitLog(transport, "info", { event: "logging/setLevel", level: minLogLevel });
          }
          return;
        }
        case "prompts/list":
          await sendHandlerResult(transport, id, listPrompts());
          return;
        case "prompts/get":
          await sendHandlerResult(transport, id, getPrompt(params));
          return;
        case "tools/call": {
          const outcome = await handleToolsCall({ allowedTools, invokeTool, params });
          await sendHandlerResult(transport, id, outcome);
          if (outcome.ok && isPlainObject(params) && typeof params.name === "string") {
            if (outcome.result.isError) {
              await emitLog(transport, "warning", {
                event: "tools/call",
                tool: params.name,
                ok: false,
              });
            } else {
              await emitLog(transport, "info", {
                event: "tools/call",
                tool: params.name,
                ok: true,
              });
              await notifyMutatedResource(transport, params.name, params.arguments);
            }
          } else if (!outcome.ok) {
            await emitLog(transport, "error", {
              event: "tools/call",
              code: outcome.code,
              message: outcome.message,
            });
          }
          return;
        }
        default:
          await sendError(transport, id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
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
      supportsResourceLinks = false;
      supportsStructuredContent = false;
      minLogLevel = null;
      subscribedUris.clear();
      transport.onparseerror = () => {
        void sendError(transport, null, JSONRPC_PARSE_ERROR, "Parse error.");
      };
      transport.onframeerror = (err) => {
        void sendError(
          transport,
          null,
          JSONRPC_INVALID_REQUEST,
          err.message || "Message exceeds maximum allowed size.",
        );
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
