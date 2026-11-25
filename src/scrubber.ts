/**
 * Secret-scrubber lokal: dijalankan di mesin pengguna sebelum teks bebas buatan agen
 * (handoff, alasan blocker) dikirim ke Catenext Cloud. Sengaja berbasis regex sederhana
 * agar mudah diaudit; lebih baik sesekali menyensor berlebihan daripada membocorkan secret.
 */

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
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { kind: "catenext_key", pattern: /\bctnx_[A-Za-z0-9_-]{8,}/g },
  { kind: "aws_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { kind: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe_key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { kind: "llm_api_key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "url_password",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
    replace: (_m, pre, _pw, at) => `${pre}${redact("url_password")}${at}`,
  },
  {
    kind: "bearer_token",
    pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_m, pre) => `${pre}${redact("bearer_token")}`,
  },
  {
    // KEY=value / password: value. Nilai dianggap secret bila >= 12 karakter, atau
    // >= 6 karakter dan mengandung angka/simbol (agar prosa biasa tidak ikut tersensor).
    kind: "assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)[A-Za-z0-9_.-]*)(\s*[:=]\s*["']?)([^\s"'`,;]*[^\s"'`,;.)])/gi,
    replace: (m, name, sep, value) => {
      if (value.startsWith("[REDACTED:")) return m;
      const looksSecret = value.length >= 12 || (value.length >= 6 && /[0-9\W_]/.test(value));
      return looksSecret ? `${name}${sep}${redact("assignment")}` : m;
    },
  },
];

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
  return `secret-scrubber lokal menyensor ${r.total} potensi secret (${parts.join(", ")}) sebelum dikirim ke Catenext Cloud.`;
}
