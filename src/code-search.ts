import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { LOCAL_EMBED_DIMS } from "@catenext/shared";
import { scrubText } from "./scrubber.js";

const execFileAsync = promisify(execFile);

export type CodeHit = {
  source: "code";
  ref: string;
  title: string;
  snippet: string;
  score: number;
};

const CACHE_DIR = ".catenext/cache/code-embeddings";
const CACHE_VERSION = 2;
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

function hashEmbed(text: string, dims = LOCAL_EMBED_DIMS): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_\u00c0-\u024f]+/i)
    .filter(Boolean);
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
  vector: number[];
  snippet: string;
  mtimeMs: number;
};

async function loadEntry(cacheRoot: string, rel: string): Promise<CacheEntry | null> {
  const key = sha256(rel).slice(0, 24);
  try {
    const entry = JSON.parse(await readFile(join(cacheRoot, `${key}.json`), "utf8")) as CacheEntry;
    return entry.version === CACHE_VERSION ? entry : null;
  } catch {
    return null;
  }
}

async function saveEntry(cacheRoot: string, rel: string, entry: CacheEntry): Promise<void> {
  const key = sha256(rel).slice(0, 24);
  await writeFile(join(cacheRoot, `${key}.json`), JSON.stringify({ ...entry, path: rel }));
}

/** Incremental local index with deterministic hash embeddings. */
export async function searchLocalCode(
  root: string,
  query: string,
  limit = 8,
): Promise<{ hits: CodeHit[]; degraded: boolean; note?: string }> {
  const cacheRoot = join(root, CACHE_DIR);
  await mkdir(cacheRoot, { recursive: true });
  const files = await listTrackedFiles(root);
  const qVec = hashEmbed(query);
  const scored: CodeHit[] = [];

  for (const rel of files) {
    const abs = join(root, rel);
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
    const sha = sha256(text);
    let entry = await loadEntry(cacheRoot, rel);
    if (!entry || entry.sha !== sha) {
      const sanitized = scrubText(text).slice(0, 8000);
      const snippet = sanitized.slice(0, 400).replace(/\s+/g, " ").trim();
      entry = {
        version: CACHE_VERSION,
        sha,
        vector: hashEmbed(sanitized),
        snippet,
        mtimeMs: st.mtimeMs,
      };
      await saveEntry(cacheRoot, rel, entry);
    }
    scored.push({
      source: "code",
      ref: rel,
      title: rel,
      snippet: entry.snippet,
      score: cosine(qVec, entry.vector),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return {
    hits: scored.slice(0, limit),
    degraded: false,
    note: "Pencarian kode memakai hash lokal.",
  };
}

/** Fallback keyword bila indeks gagal: ripgrep sederhana. */
export async function keywordFallback(root: string, query: string, limit = 8): Promise<CodeHit[]> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["-l", "--max-count", "1", "-i", "-F", "-g", "!.catenext/**", "--", query, "."],
      { cwd: root, maxBuffer: 5e6 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, limit)
      .map((rel) => ({
        source: "code" as const,
        ref: rel,
        title: rel,
        snippet: "Keyword match",
        score: 0.1,
      }));
  } catch {
    return [];
  }
}
