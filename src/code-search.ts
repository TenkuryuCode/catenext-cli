import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { LOCAL_EMBED_DIMS } from "@catenext/shared";
import { scrubText } from "./scrubber.js";
import { collectRootTargets, type RegisteredRoot } from "./workspace-roots.js";

const execFileAsync = promisify(execFile);

export type CodeHit = {
  source: "code";
  ref: string;
  title: string;
  snippet: string;
  score: number;
};

export type SearchLocalCodeOptions = {
  roots?: RegisteredRoot[];
};

const CACHE_DIR = ".catenext/cache/code-embeddings";
const CACHE_VERSION = 3;
const CHUNK_SIZE = 4000;
const CHUNK_OVERLAP = 400;
const SNIPPET_MAX_LEN = 480;
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".css",
  ".scss",
  ".html",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".sql",
  ".sh",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_\u00c0-\u024f]+/i)
    .filter(Boolean);
}

function hashEmbed(text: string, dims = LOCAL_EMBED_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    const h = createHash("sha256").update(tok).digest();
    const i = h.readUInt32BE(0) % dims;
    const sign = (h[4] ?? 0) & 1 ? 1 : -1;
    vec[i] = (vec[i] ?? 0) + sign;
  }
  if (tokens.length === 0) vec[0] = 1;
  let s = 0;
  for (const x of vec) s += x * x;
  const n = Math.sqrt(s) || 1;
  return vec.map((x) => x / n);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function clipText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 1) return value.slice(0, maxLen);
  return `${value.slice(0, maxLen - 1)}…`;
}

export function chunkText(text: string, maxChars = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    if (line.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current.join("\n"));
        current = [];
        currentLen = 0;
      }
      const step = Math.max(1, maxChars - overlap);
      for (let offset = 0; offset < line.length; offset += step) {
        chunks.push(line.slice(offset, offset + maxChars));
        if (offset + maxChars >= line.length) break;
      }
      continue;
    }

    const added = (current.length > 0 ? 1 : 0) + line.length;
    if (currentLen + added > maxChars && current.length > 0) {
      chunks.push(current.join("\n"));
      const overlapLines: string[] = [];
      let overlapLen = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const candidate = current[i] ?? "";
        const nextLen = overlapLen + (overlapLines.length > 0 ? 1 : 0) + candidate.length;
        if (nextLen > overlap) break;
        overlapLines.unshift(candidate);
        overlapLen = nextLen;
      }
      current = overlapLines;
      currentLen = overlapLen;
    }
    current.push(line);
    currentLen += (current.length > 1 ? 1 : 0) + line.length;
  }

  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks.length > 0 ? chunks : [text];
}

export function extractContextualSnippet(
  scrubbedText: string,
  query: string,
  maxLen = SNIPPET_MAX_LEN,
): string {
  const lines = scrubbedText.split(/\r?\n/);
  if (lines.length === 0) return "";
  const qLower = query.trim().toLowerCase();
  const terms = [...new Set(tokenize(query))];

  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineLower = (lines[i] ?? "").toLowerCase();
    let score = 0;
    if (qLower.length >= 2 && lineLower.includes(qLower)) score += 10;
    if (terms.length > 0) {
      const lineTokens = new Set(tokenize(lineLower));
      for (const term of terms) {
        if (lineTokens.has(term)) score += 2;
        else if (lineLower.includes(term)) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const formatLine = (idx: number) => `L${idx + 1}: ${(lines[idx] ?? "").trimEnd()}`;
  const centerLine = formatLine(bestIdx);
  if (centerLine.length > maxLen) {
    const rawLine = lines[bestIdx] ?? "";
    const lowerRaw = rawLine.toLowerCase();
    let matchOffset = qLower.length >= 2 ? lowerRaw.indexOf(qLower) : -1;
    if (matchOffset === -1) {
      for (const term of terms) {
        const idx = lowerRaw.indexOf(term);
        if (idx !== -1 && (matchOffset === -1 || idx < matchOffset)) matchOffset = idx;
      }
    }
    const prefix = `L${bestIdx + 1}: `;
    const budget = Math.max(16, maxLen - prefix.length);
    const sliceStart = matchOffset > 0 ? Math.max(0, matchOffset - Math.floor(budget / 3)) : 0;
    const body = rawLine.slice(sliceStart, sliceStart + budget).trim();
    return clipText(`${prefix}${sliceStart > 0 ? "…" : ""}${body}`, maxLen);
  }

  const chosen = new Set<number>([bestIdx]);
  let totalLen = centerLine.length;
  for (let delta = 1; delta <= 2; delta++) {
    for (const candidate of [bestIdx - delta, bestIdx + delta]) {
      if (candidate < 0 || candidate >= lines.length) continue;
      const lineText = formatLine(candidate);
      const nextLen = totalLen + 1 + lineText.length;
      if (nextLen <= maxLen) {
        chosen.add(candidate);
        totalLen = nextLen;
      }
    }
  }

  const ordered = [...chosen].sort((a, b) => a - b);
  return clipText(ordered.map((idx) => formatLine(idx)).join("\n"), maxLen);
}

async function listTrackedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: root,
      maxBuffer: 20e6,
    });
    return stdout
      .split("\0")
      .filter(Boolean)
      .filter((p) => {
        const ext = p.includes(".") ? `.${p.split(".").pop()?.toLowerCase()}` : "";
        return TEXT_EXT.has(ext) && !p.startsWith(".catenext/");
      });
  } catch {
    return walkFallback(root, root);
  }
}

async function walkFallback(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (["node_modules", ".git", ".catenext", "dist", ".next"].includes(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFallback(root, abs)));
      continue;
    }
    const rel = relative(root, abs);
    const ext = rel.includes(".") ? `.${rel.split(".").pop()?.toLowerCase()}` : "";
    if (TEXT_EXT.has(ext)) out.push(rel);
  }
  return out;
}

type CacheEntry = {
  version: number;
  sha: string;
  vectors: number[][];
  mtimeMs: number;
};

function cacheKeyFor(rootId: string | null, rel: string): string {
  return sha256(rootId ? `${rootId}:${rel}` : rel).slice(0, 24);
}

async function loadEntry(cacheRoot: string, key: string): Promise<CacheEntry | null> {
  try {
    const entry = JSON.parse(await readFile(join(cacheRoot, `${key}.json`), "utf8")) as CacheEntry;
    if (
      entry.version !== CACHE_VERSION ||
      !Array.isArray(entry.vectors) ||
      entry.vectors.length === 0
    ) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

async function saveEntry(
  cacheRoot: string,
  key: string,
  displayPath: string,
  entry: CacheEntry,
): Promise<void> {
  await writeFile(join(cacheRoot, `${key}.json`), JSON.stringify({ ...entry, path: displayPath }));
}

async function pruneStaleCache(cacheRoot: string, activeFiles: ReadonlySet<string>): Promise<void> {
  try {
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith(".json") && !activeFiles.has(entry.name),
        )
        .map((entry) => unlink(join(cacheRoot, entry.name)).catch(() => {})),
    );
  } catch {
    // ignore cache pruning errors
  }
}

/** Incremental local index with deterministic chunked hash embeddings. */
export async function searchLocalCode(
  root: string,
  query: string,
  limit = 8,
  options: SearchLocalCodeOptions = {},
): Promise<{ hits: CodeHit[]; degraded: boolean; note?: string }> {
  const cacheRoot = join(root, CACHE_DIR);
  await mkdir(cacheRoot, { recursive: true });
  const terms = [...new Set(tokenize(query))];
  const qLower = query.trim().toLowerCase();
  const qVec = hashEmbed(query);
  const targets = await collectRootTargets(root, options.roots ?? []);
  const activeCacheFiles = new Set<string>();
  const scored: CodeHit[] = [];

  for (const target of targets) {
    const files = await listTrackedFiles(target.absRoot);
    for (const rel of files) {
      const normalizedRel = rel.replaceAll("\\", "/");
      const abs = join(target.absRoot, rel);
      let st: Stats;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > 200_000) continue;

      let text: string;
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue;
      }

      const displayPath = target.prefix ? `${target.prefix}/${normalizedRel}` : normalizedRel;
      const key = cacheKeyFor(target.rootId, normalizedRel);
      activeCacheFiles.add(`${key}.json`);

      const sha = sha256(text);
      let entry = await loadEntry(cacheRoot, key);
      let sanitized: string | undefined;
      if (!entry || entry.sha !== sha) {
        sanitized = scrubText(text);
        const chunks = chunkText(sanitized);
        entry = {
          version: CACHE_VERSION,
          sha,
          vectors: chunks.map((chunk) => hashEmbed(chunk)),
          mtimeMs: st.mtimeMs,
        };
        await saveEntry(cacheRoot, key, displayPath, entry);
      }

      if (terms.length === 0) continue;
      const maxScore = entry.vectors.reduce((best, vec) => Math.max(best, cosine(qVec, vec)), -1);
      if (maxScore <= 0) continue;

      const rawLower = text.toLowerCase();
      const rawMatches =
        (qLower.length >= 2 && rawLower.includes(qLower)) ||
        terms.some((term) => rawLower.includes(term));
      if (!rawMatches) continue;

      const cleanText = sanitized ?? scrubText(text);
      const cleanLower = cleanText.toLowerCase();
      const cleanMatches =
        (qLower.length >= 2 && cleanLower.includes(qLower)) ||
        terms.some((term) => cleanLower.includes(term));
      if (!cleanMatches) continue;

      scored.push({
        source: "code",
        ref: clipText(displayPath, 200),
        title: clipText(displayPath, 300),
        snippet: extractContextualSnippet(cleanText, query),
        score: maxScore,
      });
    }
  }

  await pruneStaleCache(cacheRoot, activeCacheFiles);
  scored.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  return {
    hits: scored.slice(0, limit),
    degraded: false,
    note: "Pencarian kode memakai hash lokal.",
  };
}

/** Fallback keyword bila indeks gagal: ripgrep dengan fallback Node.js bila `rg` tidak tersedia. */
export async function keywordFallback(
  root: string,
  query: string,
  limit = 8,
  options: SearchLocalCodeOptions = {},
): Promise<CodeHit[]> {
  const targets = await collectRootTargets(root, options.roots ?? []);
  const hits: CodeHit[] = [];
  const qLower = query.trim().toLowerCase();
  for (const target of targets) {
    if (hits.length >= limit) break;
    try {
      const { stdout } = await execFileAsync(
        "rg",
        ["-l", "--max-count", "1", "-i", "-F", "-g", "!.catenext/**", "--", query, "."],
        { cwd: target.absRoot, maxBuffer: 5e6 },
      );
      for (const line of stdout.split("\n")) {
        const rel = line.trim().replace(/^\.\//, "").replaceAll("\\", "/");
        if (!rel) continue;
        const displayPath = target.prefix ? `${target.prefix}/${rel}` : rel;
        hits.push({
          source: "code",
          ref: clipText(displayPath, 200),
          title: clipText(displayPath, 300),
          snippet: "Keyword match",
          score: 0.1,
        });
        if (hits.length >= limit) break;
      }
    } catch (err) {
      const code = (err as { code?: number | string } | undefined)?.code;
      if (code === 1 || code === "1") continue;
      if (!qLower) continue;
      const files = await listTrackedFiles(target.absRoot);
      for (const rel of files) {
        if (hits.length >= limit) break;
        const normalizedRel = rel.replaceAll("\\", "/");
        const abs = join(target.absRoot, rel);
        let st: Stats;
        try {
          st = await lstat(abs);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size > 200_000) continue;
        let text: string;
        try {
          text = await readFile(abs, "utf8");
        } catch {
          continue;
        }
        const cleanText = scrubText(text);
        if (!cleanText.toLowerCase().includes(qLower)) continue;
        const displayPath = target.prefix ? `${target.prefix}/${normalizedRel}` : normalizedRel;
        hits.push({
          source: "code",
          ref: clipText(displayPath, 200),
          title: clipText(displayPath, 300),
          snippet: extractContextualSnippet(cleanText, query),
          score: 0.1,
        });
      }
    }
  }
  return hits.slice(0, limit);
}
