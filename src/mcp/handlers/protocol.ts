import {
  JSONRPC_VERSION,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcSuccessResponse,
  type McpTransport,
} from "../stdio.js";

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
export const JSONRPC_RESOURCE_NOT_FOUND = -32002;
export const RESOURCE_LINK_MIN_PROTOCOL = "2025-06-18";
export const STRUCTURED_CONTENT_MIN_PROTOCOL = "2025-06-18";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRequestId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

export function negotiateProtocolVersion(requested: unknown): {
  protocolVersion: string;
  supportsResourceLinks: boolean;
  supportsStructuredContent: boolean;
} {
  const protocolVersion =
    typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    supportsResourceLinks: protocolVersion >= RESOURCE_LINK_MIN_PROTOCOL,
    supportsStructuredContent: protocolVersion >= STRUCTURED_CONTENT_MIN_PROTOCOL,
  };
}

export function createJsonRpcResponder(opts: {
  isActive: (transport: McpTransport) => boolean;
  log: (message: string) => void;
}) {
  const safeSend = async (transport: McpTransport, msg: JsonRpcMessage): Promise<void> => {
    if (!opts.isActive(transport)) return;
    try {
      await transport.send(msg);
    } catch (err) {
      opts.log(`Transport send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const sendResult = async (
    transport: McpTransport,
    id: JsonRpcId,
    result: unknown,
  ): Promise<void> => {
    const msg: JsonRpcSuccessResponse = {
      jsonrpc: JSONRPC_VERSION,
      id,
      result: result as JsonRpcSuccessResponse["result"],
    };
    await safeSend(transport, msg);
  };

  const sendError = async (
    transport: McpTransport,
    id: JsonRpcId | null,
    code: number,
    message: string,
  ): Promise<void> => {
    const msg: JsonRpcErrorResponse = {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message },
    };
    await safeSend(transport, msg);
  };

  return { sendResult, sendError };
}
