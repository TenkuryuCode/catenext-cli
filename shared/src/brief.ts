import { z } from "zod";
import { AgentAliasSchema, IdSchema, RepoNameSchema } from "./common.js";
import { TaskStatusSchema, TaskVerifyCommandSchema } from "./task.js";

/** Cap free-form strings in compact MCP payloads. */
export const BRIEF_LIMITS = {
  title: 120,
  line: 160,
  sessionLines: 24,
  hints: 6,
  instructionPreview: 240,
} as const;

export interface ScopeOverlapCandidate {
  id: string;
  target_repo?: string | null;
  dependencies?: readonly string[];
  scope_files?: readonly string[];
}

export interface ScopeFileOverlap {
  path: string;
  task_ids: string[];
}

function normalizeScopePath(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isGlobPattern(p: string): boolean {
  return p.includes("*") || p.includes("?");
}

function scopeGlobToRegExp(globPattern: string): RegExp {
  let regex = "^";
  for (let i = 0; i < globPattern.length; i += 1) {
    const ch = globPattern[i] ?? "";
    if (ch === "*") {
      if (globPattern[i + 1] === "*") {
        if (globPattern[i + 2] === "/") {
          regex += "(?:.+/)?";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function overlappingScopeKey(aRaw: string, bRaw: string): string | null {
  const a = normalizeScopePath(aRaw);
  const b = normalizeScopePath(bRaw);
  if (!a || !b) return null;
  if (a === b) return a;
  const aGlob = isGlobPattern(a);
  const bGlob = isGlobPattern(b);
  if (!aGlob && !bGlob) {
    if (a.startsWith(`${b}/`)) return a;
    if (b.startsWith(`${a}/`)) return b;
    return null;
  }
  if (aGlob && !bGlob) {
    return scopeGlobToRegExp(a).test(b) ? b : null;
  }
  if (bGlob && !aGlob) {
    return scopeGlobToRegExp(b).test(a) ? a : null;
  }
  return null;
}

/** Find overlapping `scope_files` across independent parallel tasks in the same repo. */
export function findScopeFileOverlaps(tasks: readonly ScopeOverlapCandidate[]): ScopeFileOverlap[] {
  const scoped = tasks.filter((t) => t.scope_files && t.scope_files.length > 0);
  if (scoped.length < 2) return [];

  const overlaps = new Map<string, Set<string>>();
  for (const [i, a] of scoped.entries()) {
    for (const b of scoped.slice(i + 1)) {
      if (a.id === b.id) continue;
      if (a.target_repo && b.target_repo && a.target_repo !== b.target_repo) continue;
      if (a.dependencies?.includes(b.id) || b.dependencies?.includes(a.id)) continue;

      for (const entryA of a.scope_files ?? []) {
        for (const entryB of b.scope_files ?? []) {
          const key = overlappingScopeKey(entryA, entryB);
          if (!key) continue;
          let set = overlaps.get(key);
          if (!set) {
            set = new Set();
            overlaps.set(key, set);
          }
          set.add(a.id);
          set.add(b.id);
        }
      }
    }
  }

  return [...overlaps.entries()]
    .filter(([, ids]) => ids.size >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, ids]) => ({ path, task_ids: [...ids] }));
}

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
  /** Freshness guard for conditional CLI dispatch; not an authorization credential. */
  approval_snapshot: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  branch: z.string().max(255).optional(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{7,64}$/)
    .optional(),
  verify_command: TaskVerifyCommandSchema.optional(),
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
  /** Optional concise next-step hints for the orchestrator. */
  hints: z.array(z.string().max(BRIEF_LIMITS.line)).max(BRIEF_LIMITS.hints).optional(),
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

export const GraphNeighborsInput = z
  .object({
    path: z.string().min(1).max(500).optional(),
    paths: z.array(z.string().min(1).max(500)).min(1).max(5).optional(),
    depth: z.number().int().min(1).max(2).default(1),
    limit: z.number().int().min(1).max(40).default(20),
    include_symbols: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.path && (!v.paths || v.paths.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["path"],
        message: "Provide path or paths (1..5 file paths).",
      });
    }
    if (v.path && v.paths && v.paths.length > 0 && !v.paths.includes(v.path)) {
      ctx.addIssue({
        code: "custom",
        path: ["paths"],
        message: "Do not pass conflicting path and paths; use one or include path in paths.",
      });
    }
  });
export const GraphEdgeSchema = z.object({
  kind: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
});
export const GraphNeighborFileSchema = z.object({
  path: z.string(),
  edges: z.array(GraphEdgeSchema),
  symbols: z.array(z.string()).optional(),
});
export const MAX_CLAIM_SYMBOL_LOCATIONS = 3;
export const ClaimGraphFileSchema = GraphNeighborFileSchema.extend({
  /** Indexed 1-based start lines, returned only in the claim graph slice. */
  symbol_locations: z
    .array(z.object({ name: z.string(), line: z.number().int().min(1) }))
    .min(1)
    .max(MAX_CLAIM_SYMBOL_LOCATIONS)
    .optional(),
});
export type ClaimGraphFile = z.infer<typeof ClaimGraphFileSchema>;

export const GraphNeighborsOutput = z.object({
  path: z.string().optional(),
  edges: z.array(GraphEdgeSchema).max(40),
  files: z.array(GraphNeighborFileSchema).optional(),
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
  prefix: z.string().min(1).max(300).optional(),
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
