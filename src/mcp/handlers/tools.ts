import { MCP_TOOLS, type McpToolName } from "@catenext/shared";
import type { z } from "zod";
import { requireHumanApproval, requireHumanEpicRunApproval } from "../../approval-policy.js";
import { findProjectRoot, readConfig } from "../../config.js";
import {
  DEFAULT_SCRUB_SKIP_KEYS,
  describeRedactions,
  SCRUB_TOOL_FIELDS,
  scrubDeep,
} from "../../scrubber.js";
import { loadCatalogSkill } from "../../skill-catalog.js";
import { saveSkill } from "../../skills.js";
import { isPlainObject, JSONRPC_INVALID_PARAMS } from "./protocol.js";
import { buildResourceLinksForToolResult } from "./resources.js";
import type {
  CallToolResult,
  HandlerResult,
  ReadyContext,
  ResourceLinkContent,
  ServerContext,
} from "./types.js";

const text = (body: string): CallToolResult => ({
  content: [{ type: "text", text: body }],
  isError: true,
});

/** Compact JSON (no pretty-print) to save tokens. */
const json = (
  data: unknown,
  notes: string[] = [],
  links: ResourceLinkContent[] = [],
  includeStructuredContent = false,
): CallToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(data) },
    ...links,
    ...notes.map((n) => ({ type: "text" as const, text: n })),
  ],
  ...(includeStructuredContent && isPlainObject(data) ? { structuredContent: data } : {}),
});

function zodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

async function runTool(
  { service, root }: ReadyContext,
  name: McpToolName,
  parsed: unknown,
): Promise<unknown> {
  if (name === "load_skill") {
    const { name: skillName, revision, source_id } = MCP_TOOLS.load_skill.input.parse(parsed);
    const primaryRoot = (await findProjectRoot(root, { managedWorktree: true })) ?? root;
    const config = await readConfig(primaryRoot).catch(() => null);
    const skill = await loadCatalogSkill(root, skillName, {
      platforms: config?.platforms,
      sourceId: source_id,
      revision,
    });
    return {
      name: skill.name,
      when_to_use: skill.when_to_use,
      content: skill.content,
      source_id: skill.source_id,
      source_kind: skill.source_kind,
      source_path: skill.source_path,
      ...(skill.collision ? { collision: true } : {}),
      ...(revision ? { revision } : {}),
    };
  }
  if (name === "save_repo_skill") {
    const saved = await saveSkill(root, MCP_TOOLS.save_repo_skill.input.parse(parsed));
    return { path: saved.path, created: saved.created };
  }
  return service.callTool(name, parsed);
}

export function createToolInvoker(opts: {
  context: () => Promise<ServerContext>;
  log: (message: string) => void;
  supportsResourceLinks: () => boolean;
  supportsStructuredContent: () => boolean;
}) {
  return async (name: McpToolName, rawArgs: unknown): Promise<CallToolResult> => {
    try {
      const schema = MCP_TOOLS[name].input;
      const initial = schema.safeParse(rawArgs ?? {});
      if (!initial.success) return text(`Input ditolak:\n${zodIssues(initial.error)}`);
      if (name === "manage_task") {
        requireHumanApproval("agent", MCP_TOOLS.manage_task.input.parse(initial.data));
      }
      if (name === "epic_run") {
        requireHumanEpicRunApproval("agent", MCP_TOOLS.epic_run.input.parse(initial.data));
      }

      const ctx = await opts.context();
      if (!ctx.ok) return text(`Catenext belum siap: ${ctx.error}`);

      const keep = SCRUB_TOOL_FIELDS[name];
      const skipKeys = keep ? new Set(keep) : DEFAULT_SCRUB_SKIP_KEYS;
      const notes: string[] = [];

      const scrubbedIn = scrubDeep(initial.data, skipKeys);
      // Sensor dapat mengubah ukuran payload; validasi ulang sebelum disimpan.
      const reparsed = schema.safeParse(scrubbedIn.value);
      if (!reparsed.success) return text(`Input ditolak:\n${zodIssues(reparsed.error)}`);
      const payload = reparsed.data;
      if (scrubbedIn.total > 0) {
        const note = describeRedactions(scrubbedIn);
        opts.log(note);
        notes.push(note);
      }

      const rawResult = await runTool(ctx, name, payload);
      const scrubbedOut = scrubDeep(rawResult, DEFAULT_SCRUB_SKIP_KEYS);
      if (scrubbedOut.total > 0) {
        const note = describeRedactions(scrubbedOut);
        opts.log(note);
        notes.push(note);
      }
      const linked = buildResourceLinksForToolResult(
        name,
        scrubbedOut.value,
        opts.supportsResourceLinks(),
      );
      return json(linked.payload, notes, linked.links, opts.supportsStructuredContent());
    } catch (err) {
      return text(`Catenext: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export async function handleToolsCall(opts: {
  allowedTools: ReadonlySet<string>;
  invokeTool: (name: McpToolName, rawArgs: unknown) => Promise<CallToolResult>;
  params: unknown;
}): Promise<HandlerResult<CallToolResult>> {
  const { params } = opts;
  if (!isPlainObject(params) || typeof params.name !== "string") {
    return { ok: false, code: JSONRPC_INVALID_PARAMS, message: "Invalid tools/call params." };
  }
  if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
    return {
      ok: false,
      code: JSONRPC_INVALID_PARAMS,
      message: "Tool arguments must be an object.",
    };
  }
  if (!opts.allowedTools.has(params.name)) {
    return { ok: false, code: JSONRPC_INVALID_PARAMS, message: `Tool ${params.name} not found` };
  }
  const result = await opts.invokeTool(params.name as McpToolName, params.arguments);
  return { ok: true, result };
}
