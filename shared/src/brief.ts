import { z } from "zod";
import { AgentAliasSchema, IdSchema, RepoNameSchema } from "./common.js";
import { TaskStatusSchema } from "./task.js";

/** Cap free-form strings in compact MCP payloads. */
export const BRIEF_LIMITS = {
  title: 120,
  line: 160,
  sessionLines: 24,
  instructionPreview: 240,
} as const;

export function briefText(text: string, max: number = BRIEF_LIMITS.line): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(0, max - 1))}…`;
}

export const SetupOptionCardSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  recommended: z.boolean(),
  why: z.string().min(1).max(160),
});

export const InterviewSetupInput = z.object({
  step: z.enum(["platform", "personas", "locale"]).default("platform"),
});
export const InterviewSetupOutput = z.object({
  step: z.string(),
  locale_hint: z.string(),
  options: z.array(SetupOptionCardSchema).max(20),
  recommended_ids: z.array(z.string()).max(20),
  ask: z.string().max(240),
});

export const SessionBriefInput = z.object({
  verbose: z.boolean().optional(),
});
export const SessionBriefLineSchema = z.object({
  kind: z.enum(["ready", "blocked", "decision", "ask", "info", "worktree"]),
  text: z.string().max(BRIEF_LIMITS.line),
  task_id: IdSchema.optional(),
});

/** Compact human-gate card for orchestrator to present in chat. */
export const ApprovalOptionSchema = z.object({
  id: z.enum(["approve", "revise", "next"]),
  label: z.string().max(80),
  command_hint: z.string().max(160).optional(),
});
export const PendingApprovalSchema = z.object({
  task_id: IdSchema,
  title: z.string().max(BRIEF_LIMITS.title),
  status: TaskStatusSchema,
  summary: z.string().max(BRIEF_LIMITS.line),
  options: z.array(ApprovalOptionSchema).max(5),
});

export const WorkspaceRootSchema = z.object({
  id: IdSchema,
  path: z.string(),
  owner_persona: AgentAliasSchema.nullable(),
  label: z.string().optional(),
});

export const SessionBriefOutput = z.object({
  lines: z.array(SessionBriefLineSchema).max(BRIEF_LIMITS.sessionLines),
  ready_count: z.number().int().min(0),
  blocked_count: z.number().int().min(0),
  draft_count: z.number().int().min(0),
  /** Human decisions the orchestrator must present (chat or numbered options). */
  pending_approvals: z.array(PendingApprovalSchema).max(10).default([]),
  /** Registered external/extra workspace roots for this project. */
  workspace_roots: z.array(WorkspaceRootSchema).max(20).default([]),
  /** Cold-start file: master prompt, then AGENTS.md for full rules. */
  read_first: z.literal("CATENEXT.md").default("CATENEXT.md"),
  /** Session locale preference from session_prefs (when configured). */
  locale: z.string().optional(),
});

export const ManageRootsInput = z.object({
  action: z.enum(["list", "add", "remove"]),
  path: z.string().min(1).max(500).optional(),
  persona: AgentAliasSchema.optional(),
  label: z.string().min(1).max(80).optional(),
  root_id: IdSchema.optional(),
});
export const ManageRootsOutput = z.object({
  roots: z.array(WorkspaceRootSchema),
});

export const GraphNeighborsInput = z.object({
  path: z.string().min(1).max(500),
  depth: z.number().int().min(1).max(2).default(1),
  limit: z.number().int().min(1).max(40).default(20),
});
export const GraphEdgeSchema = z.object({
  kind: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});
export const GraphNeighborsOutput = z.object({
  path: z.string(),
  edges: z.array(GraphEdgeSchema).max(40),
  stale: z.boolean().optional(),
  stale_reason: z.string().optional(),
});

export const SymbolSearchInput = z.object({
  query: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(40).default(20),
});
export const SymbolHitSchema = z.object({
  name: z.string(),
  kind: z.string(),
  path: z.string(),
  line: z.number().int().optional(),
});
export const SymbolSearchOutput = z.object({
  hits: z.array(SymbolHitSchema).max(40),
  stale: z.boolean().optional(),
  stale_reason: z.string().optional(),
});

export const GraphImpactInput = z.object({
  path: z.string().min(1).max(500),
  depth: z.number().int().min(1).max(3).default(2),
  limit: z.number().int().min(1).max(40).default(20),
  include_tests: z.boolean().default(false),
});
export type GraphImpactInputType = z.infer<typeof GraphImpactInput>;

export const GraphImpactHitSchema = z.object({
  path: z.string(),
  distance: z.number().int().min(1),
  kind: z.enum(["direct", "transitive"]),
  via: z.string().optional(),
  symbols_count: z.number().int().min(0).optional(),
});

export const GraphImpactOutput = z.object({
  target: z.string(),
  indexed: z.boolean(),
  stale: z.boolean().optional(),
  stale_reason: z.string().optional(),
  total_affected: z.number().int().min(0),
  truncated: z.boolean(),
  impacted: z.array(GraphImpactHitSchema).max(40),
});
export type GraphImpactOutputType = z.infer<typeof GraphImpactOutput>;

export const GraphSummaryInput = z.object({
  depth: z.number().int().min(1).max(5).default(2),
  max_hubs: z.number().int().min(1).max(30).default(12),
  include_mermaid: z.boolean().default(true),
  include_tests: z.boolean().default(false),
});
export type GraphSummaryInputType = z.infer<typeof GraphSummaryInput>;

export const GraphSummaryGroupSchema = z.object({
  group: z.string(),
  files: z.number().int().min(0),
  symbols: z.number().int().min(0),
  edges_in: z.number().int().min(0),
  edges_out: z.number().int().min(0),
});

export const GraphSummaryGroupEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  count: z.number().int().min(1),
});

export const GraphSummaryHubSchema = z.object({
  path: z.string(),
  group: z.string(),
  in_edges: z.number().int().min(0),
  out_edges: z.number().int().min(0),
  symbol_count: z.number().int().min(0),
  key_symbols: z.array(z.string()).max(6),
});

export const GraphSummaryOutput = z.object({
  indexed: z.boolean(),
  stale: z.boolean().optional(),
  stale_reason: z.string().optional(),
  totals: z.object({
    files: z.number().int().min(0),
    symbols: z.number().int().min(0),
    edges: z.number().int().min(0),
  }),
  groups: z.array(GraphSummaryGroupSchema),
  group_edges: z.array(GraphSummaryGroupEdgeSchema),
  hubs: z.array(GraphSummaryHubSchema),
  mermaid: z.string().optional(),
});
export type GraphSummaryOutputType = z.infer<typeof GraphSummaryOutput>;

/** Optional compact flags shared by board/context readers. */
export const CompactQueryFields = {
  verbose: z.boolean().optional(),
};

export const CompactTaskLineSchema = z.object({
  id: IdSchema,
  title: z.string(),
  status: TaskStatusSchema,
  persona: AgentAliasSchema.nullable().optional(),
  target_repo: RepoNameSchema.nullable().optional(),
});
