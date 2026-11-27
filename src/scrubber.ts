import type { McpToolName } from "@catenext/shared";

/** Best-effort redaction of recognizable secrets before text is stored or returned by Catenext. */

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Bila ada, hanya grup ini yang disensor (prefiks/nama variabel tetap terlihat). */
  replace?: (match: string, ...groups: string[]) => string;
}

const redact = (kind: string) => `[REDACTED:${kind}]`;

const RULES: Rule[] = [
  {
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z0-9 _-]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 _-]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    kind: "url_password",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"[\]()<>'`{},;]*:)([^\s@/"[\]()<>'`{},;]+)(@)/gi,
    replace: (m, pre, pw, at) =>
      pw.includes("[REDACTED:") ? m : `${pre}${redact("url_password")}${at}`,
  },
  { kind: "catenext_key", pattern: /\bctnx_[A-Za-z0-9_-]{8,}/g },
  { kind: "aws_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { kind: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{20,}/g },
  {
    kind: "slack_token",
    pattern: /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,})/g,
  },
  { kind: "stripe_key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  {
    kind: "llm_api_key",
    pattern: /\bsk-(?:(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{20,})/g,
  },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { kind: "huggingface_token", pattern: /\bhf_[A-Za-z0-9]{20,}/g },
  { kind: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "pypi_token", pattern: /\bpypi-[A-Za-z0-9_-]{20,}/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "bearer_token",
    pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (m, pre, tok) => (tok.includes("[REDACTED:") ? m : `${pre}${redact("bearer_token")}`),
  },
  {
    // KEY=value / password: value / "api_key": "secret-val". Nilai dianggap secret bila >= 12 karakter,
    // atau >= 6 karakter dan mengandung angka/simbol (agar prosa biasa tidak ikut tersensor).
    kind: "assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]*[^\s"'`,;.)])/gi,
    replace: (m, name, sep, value) => {
      if (value.includes("[REDACTED:")) return m;
      const looksSecret = value.length >= 12 || (value.length >= 6 && /[0-9\W_]/.test(value));
      return looksSecret ? `${name}${sep}${redact("assignment")}` : m;
    },
  },
];

/** Structured identity/metadata keys exempted per MCP tool so free text is scrubbed cleanly. */
export const SCRUB_TOOL_FIELDS: Partial<Record<McpToolName, readonly string[]>> = {
  complete_handoff: ["task_id", "last_commit_hash", "head_sha", "lease_id"],
  report_blocker: ["task_id", "category", "lease_id"],
  review_pull_request: ["action", "task_id", "head_sha", "lease_id", "agent_alias", "decision"],
  manage_task: ["action", "task_id", "agent_alias", "role"],
  save_document: ["slug", "kind", "expected_version"],
  get_document: ["slug", "section"],
  search_context: ["sources", "limit"],
  create_epic: [],
  update_task: [
    "task_id",
    "persona",
    "persona_id",
    "role",
    "target_repo",
    "scope_files",
    "doc_refs",
  ],
  update_epic: ["epic_id"],
  create_tasks: [
    "epic_id",
    "ref",
    "depends_on",
    "target_repo",
    "role",
    "persona",
    "scope_files",
    "doc_refs",
  ],
  upsert_persona: ["alias", "role", "repos"],
  remove_persona: ["alias"],
  save_repo_skill: ["name"],
  manage_roots: ["action", "persona", "root_id", "path"],
  graph_neighbors: ["path", "paths"],
  symbol_search: ["query"],
  graph_summary: [],
  graph_impact: ["path"],
};

export const DEFAULT_SCRUB_SKIP_KEYS: ReadonlySet<string> = new Set([
  "task_id",
  "epic_id",
  "lease_id",
  "last_commit_hash",
  "head_sha",
  "session_id",
  "worktree_path",
  "branch",
  "git_branch",
  "base_branch",
  "url",
  "ref",
  "depends_on",
  "action",
  "decision",
  "agent_alias",
  "alias",
  "role",
  "persona",
  "persona_id",
  "repos",
  "target_repo",
  "category",
  "status",
  "slug",
  "section",
  "outline_only",
  "compact",
  "kind",
  "name",
  "revision",
  "sources",
  "path",
  "paths",
  "scope_files",
  "doc_refs",
  "query",
  "root_id",
  "expected_version",
  "limit",
]);

export interface ScrubResult<T> {
  value: T;
  /** Jumlah sensor per jenis, mis. { github_token: 1 }. */
  redactions: Record<string, number>;
  total: number;
}

export function scrubText(text: string, counts: Record<string, number> = {}): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const replaced = rule.replace ? rule.replace(match, ...groups) : redact(rule.kind);
      if (replaced !== match) counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      return replaced;
    });
  }
  return out;
}

/** Sensor semua string di dalam objek/array (rekursif). Kunci objek tidak diubah. */
export function scrubDeep<T>(value: T, skipKeys: ReadonlySet<string> = new Set()): ScrubResult<T> {
  const counts: Record<string, number> = {};
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") return key && skipKeys.has(key) ? v : scrubText(v, counts);
    if (Array.isArray(v)) return v.map((item) => walk(item, key));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner, k)]));
    }
    return v;
  };
  const scrubbed = walk(value) as T;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { value: scrubbed, redactions: counts, total };
}

export function describeRedactions(r: { redactions: Record<string, number>; total: number }) {
  const parts = Object.entries(r.redactions).map(([k, n]) => `${k}×${n}`);
  return `Secret scrubber menyensor ${r.total} potensi secret (${parts.join(", ")}).`;
}
