import type { LocalService } from "../../local-service.js";
import type { McpRole } from "../catalog.js";

export type ServerContext =
  | { ok: true; service: Pick<LocalService, "callTool">; root: string }
  | { ok: false; error: string };

export type ReadyContext = Extract<ServerContext, { ok: true }>;

export interface ServerOptions {
  version: string;
  /** Muat konteks saat tool pertama dipanggil, agar server bisa memberi pesan bila belum init. */
  context: () => Promise<ServerContext>;
  log?: (message: string) => void;
  /** Filter tool MCP berdasarkan peran: orchestrator atau worker (default: semua tool). */
  role?: McpRole;
  /** Trusted local launch flag; never accepted as a tool argument. */
  allowCrud?: boolean;
}

export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export type ToolResultContent = { type: "text"; text: string } | ResourceLinkContent;

export interface CallToolResult {
  content: ToolResultContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface GetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

export type HandlerResult<T> =
  | { ok: true; result: T }
  | { ok: false; code: number; message: string };
