import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { McpToolName } from "@catenext/shared";
import { readConfig } from "../../config.js";
import { loadTask } from "../../db/project-codec.js";
import { LocalStore } from "../../db/store.js";
import { DEFAULT_SCRUB_SKIP_KEYS, scrubDeep, scrubText } from "../../scrubber.js";
import {
  isPlainObject,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_RESOURCE_NOT_FOUND,
} from "./protocol.js";
import type {
  HandlerResult,
  McpResource,
  McpResourceTemplate,
  ResourceLinkContent,
  ServerContext,
} from "./types.js";

const LARGE_RESOURCE_PAYLOAD_CHARS = 4000;
const DOC_URI_PREFIX = "catenext://documents/";
const HANDOFF_URI_PREFIX = "catenext://handoffs/";

const RESOURCE_TEMPLATES: McpResourceTemplate[] = [
  {
    uriTemplate: `${DOC_URI_PREFIX}{slug}`,
    name: "project-document",
    title: "Project Document",
    description: "Read a Catenext project document by slug (e.g. blueprint, sync-board).",
    mimeType: "text/markdown",
  },
  {
    uriTemplate: `${HANDOFF_URI_PREFIX}{task_id}`,
    name: "task-handoff",
    title: "Task Handoff",
    description: "Read a Catenext task handoff summary by task UUID.",
    mimeType: "application/json",
  },
];

function documentResourceUri(slug: string): string {
  return `${DOC_URI_PREFIX}${encodeURIComponent(slug)}`;
}

function handoffResourceUri(taskId: string): string {
  return `${HANDOFF_URI_PREFIX}${encodeURIComponent(taskId)}`;
}

export function parseResourceUri(
  uri: string,
): { kind: "document"; slug: string } | { kind: "handoff"; taskId: string } | null {
  try {
    if (uri.startsWith(DOC_URI_PREFIX)) {
      const slug = decodeURIComponent(uri.slice(DOC_URI_PREFIX.length));
      return slug.length > 0 ? { kind: "document", slug } : null;
    }
    if (uri.startsWith(HANDOFF_URI_PREFIX)) {
      const taskId = decodeURIComponent(uri.slice(HANDOFF_URI_PREFIX.length));
      return taskId.length > 0 ? { kind: "handoff", taskId } : null;
    }
  } catch {
    return null;
  }
  return null;
}

function toDocumentResource(raw: unknown): McpResource | null {
  if (!isPlainObject(raw) || typeof raw.slug !== "string" || raw.slug.length === 0) return null;
  const kind = typeof raw.kind === "string" ? raw.kind : "project";
  const version = typeof raw.version === "number" ? ` (v${raw.version})` : "";
  return {
    uri: documentResourceUri(raw.slug),
    name: raw.slug,
    ...(typeof raw.title === "string" && raw.title.length > 0 ? { title: raw.title } : {}),
    description: `${kind} document${version}`,
    mimeType: "text/markdown",
  };
}

function toHandoffResource(raw: unknown): McpResource | null {
  if (!isPlainObject(raw) || typeof raw.task_id !== "string" || raw.task_id.length === 0) {
    return null;
  }
  const title = typeof raw.title === "string" && raw.title.length > 0 ? raw.title : raw.task_id;
  return {
    uri: handoffResourceUri(raw.task_id),
    name: `handoff-${raw.task_id}`,
    title: `Handoff: ${title}`,
    description: `Task handoff for ${title}`,
    mimeType: "application/json",
  };
}

function toResourceLink(resource: McpResource): ResourceLinkContent {
  return { type: "resource_link", ...resource };
}

function compactHandoffStubs(handoffs: unknown[]): Array<{
  task_id: string;
  title?: string;
  resource_uri: string;
}> {
  return handoffs.flatMap((item) => {
    if (!isPlainObject(item) || typeof item.task_id !== "string") return [];
    return [
      {
        task_id: item.task_id,
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        resource_uri: handoffResourceUri(item.task_id),
      },
    ];
  });
}

function linkAndCompactHandoffs(
  result: Record<string, unknown>,
  field: "recent_handoffs" | "dependency_handoffs",
  handoffs: unknown[],
  links: ResourceLinkContent[],
): Record<string, unknown> {
  for (const handoff of handoffs) {
    const res = toHandoffResource(handoff);
    if (res) links.push(toResourceLink(res));
  }
  if (JSON.stringify(handoffs).length > LARGE_RESOURCE_PAYLOAD_CHARS) {
    return {
      ...result,
      [field]: compactHandoffStubs(handoffs),
    };
  }
  return result;
}

export function buildResourceLinksForToolResult(
  name: McpToolName,
  result: unknown,
  supportsResourceLinks: boolean,
): { payload: unknown; links: ResourceLinkContent[] } {
  if (!supportsResourceLinks || !isPlainObject(result)) return { payload: result, links: [] };

  if (name === "get_project_context") {
    const links: ResourceLinkContent[] = [];
    if (Array.isArray(result.documents)) {
      for (const doc of result.documents) {
        const res = toDocumentResource(doc);
        if (res) links.push(toResourceLink(res));
      }
    }
    const payload = Array.isArray(result.recent_handoffs)
      ? linkAndCompactHandoffs(result, "recent_handoffs", result.recent_handoffs, links)
      : result;
    return { payload, links };
  }

  if (name === "claim_task" && Array.isArray(result.dependency_handoffs)) {
    const links: ResourceLinkContent[] = [];
    const payload = linkAndCompactHandoffs(
      result,
      "dependency_handoffs",
      result.dependency_handoffs,
      links,
    );
    return { payload, links };
  }

  if (name === "get_document") {
    const docRes = toDocumentResource(result);
    const contentLen = typeof result.content === "string" ? result.content.length : 0;
    const shouldLink =
      result.truncated === true || contentLen === 0 || contentLen > LARGE_RESOURCE_PAYLOAD_CHARS;
    if (docRes && shouldLink) {
      return { payload: result, links: [toResourceLink(docRes)] };
    }
  }

  return { payload: result, links: [] };
}

export function listResourceTemplates(): HandlerResult<{
  resourceTemplates: McpResourceTemplate[];
}> {
  return { ok: true, result: { resourceTemplates: RESOURCE_TEMPLATES } };
}

export async function listResources(
  context: () => Promise<ServerContext>,
): Promise<HandlerResult<{ resources: McpResource[] }>> {
  const ctx = await context();
  if (!ctx.ok) {
    return {
      ok: false,
      code: JSONRPC_INTERNAL_ERROR,
      message: `Catenext belum siap: ${ctx.error}`,
    };
  }
  const contextResult = await ctx.service.callTool("get_project_context", {});
  const resources: McpResource[] = [];
  if (isPlainObject(contextResult)) {
    if (Array.isArray(contextResult.documents)) {
      for (const doc of contextResult.documents) {
        const item = toDocumentResource(doc);
        if (item) resources.push(item);
      }
    }
    if (Array.isArray(contextResult.recent_handoffs)) {
      for (const handoff of contextResult.recent_handoffs) {
        const item = toHandoffResource(handoff);
        if (item) resources.push(item);
      }
    }
  }
  return { ok: true, result: { resources } };
}

async function loadHandoffFromStore(
  root: string,
  taskId: string,
): Promise<Record<string, unknown> | undefined> {
  const config = await readConfig(root).catch(() => null);
  if (!config) return undefined;
  const stateFile = resolve(root, config.state_file ?? ".catenext/catenext.sqlite");
  if (!existsSync(stateFile)) return undefined;
  const task = await new LocalStore(stateFile).query((db) =>
    loadTask(db, config.project_id, taskId),
  );
  if (!task?.handoff) return undefined;
  const integrated =
    task.integrated_commit ??
    (task.handoff as { integrated_commit?: { branch: string; sha: string } }).integrated_commit;
  return {
    task_id: task.id,
    title: task.title,
    handoff_summary: task.handoff,
    ...(integrated ? { integrated_commit: integrated } : {}),
  };
}

export async function readResource(
  context: () => Promise<ServerContext>,
  params: unknown,
): Promise<HandlerResult<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>> {
  if (!isPlainObject(params) || typeof params.uri !== "string" || params.uri.length === 0) {
    return {
      ok: false,
      code: JSONRPC_INVALID_PARAMS,
      message: "Invalid resources/read params.",
    };
  }
  const target = parseResourceUri(params.uri);
  if (!target) {
    return {
      ok: false,
      code: JSONRPC_RESOURCE_NOT_FOUND,
      message: `Resource not found: ${params.uri}`,
    };
  }
  const ctx = await context();
  if (!ctx.ok) {
    return {
      ok: false,
      code: JSONRPC_INTERNAL_ERROR,
      message: `Catenext belum siap: ${ctx.error}`,
    };
  }

  if (target.kind === "document") {
    try {
      const doc = await ctx.service.callTool("get_document", { slug: target.slug });
      if (!isPlainObject(doc) || typeof doc.content !== "string") {
        return {
          ok: false,
          code: JSONRPC_RESOURCE_NOT_FOUND,
          message: `Resource not found: ${params.uri}`,
        };
      }
      return {
        ok: true,
        result: {
          contents: [{ uri: params.uri, mimeType: "text/markdown", text: scrubText(doc.content) }],
        },
      };
    } catch {
      return {
        ok: false,
        code: JSONRPC_RESOURCE_NOT_FOUND,
        message: `Resource not found: ${params.uri}`,
      };
    }
  }

  let handoff: unknown = await loadHandoffFromStore(ctx.root, target.taskId);
  if (!handoff) {
    const contextResult = await ctx.service.callTool("get_project_context", {});
    handoff =
      isPlainObject(contextResult) && Array.isArray(contextResult.recent_handoffs)
        ? contextResult.recent_handoffs.find(
            (item) => isPlainObject(item) && item.task_id === target.taskId,
          )
        : undefined;
  }
  if (!handoff) {
    return {
      ok: false,
      code: JSONRPC_RESOURCE_NOT_FOUND,
      message: `Resource not found: ${params.uri}`,
    };
  }
  const scrubbed = scrubDeep(handoff, DEFAULT_SCRUB_SKIP_KEYS).value;
  return {
    ok: true,
    result: {
      contents: [{ uri: params.uri, mimeType: "application/json", text: JSON.stringify(scrubbed) }],
    },
  };
}

/** Map a mutating MCP tool call to its affected resource URI, if any. */
export function mutatedResourceUri(toolName: string, args: unknown): string | null {
  if (!isPlainObject(args)) return null;
  if (
    toolName === "save_document" ||
    toolName === "archive_document" ||
    toolName === "restore_document"
  ) {
    return typeof args.slug === "string" && args.slug.length > 0
      ? documentResourceUri(args.slug)
      : null;
  }
  if (toolName === "complete_handoff") {
    return typeof args.task_id === "string" && args.task_id.length > 0
      ? handoffResourceUri(args.task_id)
      : null;
  }
  return null;
}

/** Subscribe a session to `notifications/resources/updated` for a valid Catenext resource URI. */
export function subscribeResource(
  subscriptions: Set<string>,
  params: unknown,
): HandlerResult<Record<string, never>> {
  if (!isPlainObject(params) || typeof params.uri !== "string" || params.uri.length === 0) {
    return {
      ok: false,
      code: JSONRPC_INVALID_PARAMS,
      message: "Invalid resources/subscribe params.",
    };
  }
  if (!parseResourceUri(params.uri)) {
    return {
      ok: false,
      code: JSONRPC_RESOURCE_NOT_FOUND,
      message: `Resource not found: ${params.uri}`,
    };
  }
  subscriptions.add(params.uri);
  return { ok: true, result: {} };
}

/** Unsubscribe a session from `notifications/resources/updated` for a URI. */
export function unsubscribeResource(
  subscriptions: Set<string>,
  params: unknown,
): HandlerResult<Record<string, never>> {
  if (!isPlainObject(params) || typeof params.uri !== "string" || params.uri.length === 0) {
    return {
      ok: false,
      code: JSONRPC_INVALID_PARAMS,
      message: "Invalid resources/unsubscribe params.",
    };
  }
  subscriptions.delete(params.uri);
  return { ok: true, result: {} };
}
