import {
  isMcpCrudTool,
  MCP_CRUD_TOOLS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpToolName,
} from "@catenext/shared";
import { z } from "zod";

export const MCP_ROLES = ["orchestrator", "worker"] as const;
export const McpRoleSchema = z.enum(MCP_ROLES);
export type McpRole = z.infer<typeof McpRoleSchema>;

/** Tool subsets exposed when `--role` is passed; omitted `--role` exposes all tools. */
export const ROLE_TOOLS: Record<McpRole, readonly McpToolName[]> = {
  orchestrator: [
    "session_brief",
    "interview_setup",
    "get_project_board",
    "get_project_context",
    "list_epics",
    "create_epic",
    "create_tasks",
    "manage_task",
    "list_personas",
    "upsert_persona",
    "get_document",
    "save_document",
    "search_context",
    "load_skill",
    "save_repo_skill",
    "manage_roots",
    "graph_neighbors",
    "symbol_search",
    "review_pull_request",
  ],
  worker: [
    "get_project_context",
    "get_ready_tasks",
    "claim_task",
    "release_task",
    "report_blocker",
    "complete_handoff",
    "review_pull_request",
    "get_document",
    "search_context",
    "load_skill",
    "save_repo_skill",
    "graph_neighbors",
    "symbol_search",
  ],
};

/** Crisp <=12-word 1-line tool descriptions to minimize MCP tools/list token overhead. */
export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  update_task: "Edit task fields without approving or changing status.",
  update_epic: "Edit an epic title or description.",
  set_dependencies: "Replace a task's dependencies, with cycle checks.",
  cancel_task: "Remove a task with no active lease or dependents.",
  release_task: "Release a held task lease so another session can claim it.",
  get_project_board: "Orchestrator project board across repos with epics, tasks, and statuses.",
  search_context: "Search local documents, skill index, tasks, and code by keyword.",
  get_document: "Read a local project document, outline, or specific markdown section.",
  save_document: "Create or update a local markdown project document with optimistic versioning.",
  manage_task: "Assign, revise, unblock, or return tasks to draft. Approvals require CLI.",
  review_pull_request: "Manage local PR review queue, claim, refresh, or submit recommendation.",
  get_project_context:
    "Read repo identity, persona rules, skill index, docs, and dependency handoffs.",
  get_ready_tasks: "List claimable tasks for this repo whose dependencies are all done.",
  claim_task: "Lock a task lease and retrieve instructions, persona rules, and handoffs.",
  complete_handoff: "Submit structured task handoff with commit hash; moves task to NEEDS_REVIEW.",
  report_blocker: "Release task lease and mark task BLOCKED with a specific reason.",
  create_tasks: "Propose a dependency-ordered list of DRAFT tasks for an epic.",
  list_epics: "List project epics with task counts grouped by status.",
  create_epic: "Create a new project epic to organize planned tasks.",
  list_personas: "List configured project agent personas, roles, and rules.",
  upsert_persona: "Create or update a project agent persona, role, rules, and repos.",
  load_skill: "Load full markdown instructions for a repo skill from .catenext/skills.",
  save_repo_skill: "Create or update a concise repo skill in .catenext/skills.",
  interview_setup: "Return compact setup option cards for platform, personas, or locale.",
  session_brief: "Return compact ready, blocked, draft counts and next action hints.",
  manage_roots: "List, add, or remove external workspace roots owned by a persona.",
  graph_neighbors: "List compact code-graph import and symbol neighbors for a file.",
  symbol_search: "Search indexed symbols in the local SQLite code graph.",
};

export interface CompactToolInputSchema {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
  [key: string]: unknown;
}

export interface CompactMcpTool {
  name: McpToolName;
  description: string;
  inputSchema: CompactToolInputSchema;
}

/** Only trusted launch options grant CRUD; role can narrow but never grant it. */
export function mcpCrudEnabled(role?: McpRole, allowCrud = false): boolean {
  return allowCrud === true && role !== "worker";
}

export function toolsForRole(role?: McpRole, allowCrud = false): McpToolName[] {
  const enabled = mcpCrudEnabled(role, allowCrud);
  if (!role) return MCP_TOOL_NAMES.filter((name) => enabled || !isMcpCrudTool(name));
  return enabled ? [...ROLE_TOOLS[role], ...MCP_CRUD_TOOLS] : [...ROLE_TOOLS[role]];
}

function stripSchemaNode(value: unknown, isRoot = false): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSchemaNode(item, false));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const isUuidString = record.format === "uuid" && typeof record.pattern === "string";
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (isRoot && key === "$schema") continue;
    if (isUuidString && key === "pattern") continue;
    out[key] = stripSchemaNode(inner, false);
  }
  return out;
}

/**
 * Strip verbose JSON Schema boilerplate (root `$schema` and Zod v4's 165-char `z.uuid()` regex
 * `pattern` while keeping `format: "uuid"`).
 */
export function compactJsonSchema(schema: unknown): CompactToolInputSchema {
  const cleaned = stripSchemaNode(schema, true);
  if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
    const obj = cleaned as Record<string, unknown>;
    if (obj.type === "object") return obj as CompactToolInputSchema;
    return { type: "object", ...obj };
  }
  return { type: "object" };
}

export function zodToCompactJsonSchema(schema: z.ZodType): CompactToolInputSchema {
  const raw = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  return compactJsonSchema(raw);
}

export function buildMcpToolCatalog(role?: McpRole, allowCrud = false): CompactMcpTool[] {
  return toolsForRole(role, allowCrud).map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: zodToCompactJsonSchema(MCP_TOOLS[name].input),
  }));
}
