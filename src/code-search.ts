import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { hasCodeSearchFts, tryEnableCodeSearchFts } from "./db/migrate.js";
import { checkpointWalAndClose, openDatabaseAt } from "./db/open.js";
import { scrubText } from "./scrubber.js";
import { collectRootTargets, type RegisteredRoot } from "./workspace-roots.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SKIP_DIRS,
  isWithinRoot,
  readBoundedUtf8File,
  walkWorkspaceFiles,
} from "./workspace-walk.js";

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
  db?: DatabaseSync;
  projectId?: string;
  maxFileBytes?: number;
  /** Internal/test hook: force non-FTS5 SQLite fallback path. */
  disableFts5?: boolean;
};

const STANDALONE_DB_REL = join(".catenext", "cache", "code-search.sqlite");
const STANDALONE_PROJECT_ID = "__standalone__";
const CHUNK_SIZE = 4000;
const CHUNK_OVERLAP = 400;
const SNIPPET_MAX_LEN = 480;
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
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
  ".php",
  ".vue",
  ".svelte",
  ".astro",
  ".graphql",
  ".proto",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_\u00c0-\u024f]+/i)
    .filter(Boolean);
}

function splitIdentifierPart(word: string): string[] {
  const spaced = word
    .replaceAll("_", " ")
    .replace(/([a-z\u00e0-\u024f])([A-Z\u00c0-\u00de])/g, "$1 $2")
    .replace(/([A-Z\u00c0-\u00de]+)([A-Z\u00c0-\u00de][a-z\u00e0-\u024f])/g, "$1 $2")
    .replace(/([a-zA-Z\u00c0-\u024f])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z\u00c0-\u024f])/g, "$1 $2");
  return spaced.toLowerCase().split(/\s+/).filter(Boolean);
}

function buildSearchTokens(displayPath: string, content: string): string {
  const rawWords = `${displayPath}\n${content}`.match(/[a-zA-Z0-9_\u00c0-\u024f]+/g) ?? [];
  const out: string[] = [];
  for (const word of rawWords) {
    out.push(word.toLowerCase());
    const parts = splitIdentifierPart(word);
    if (parts.length > 1) {
      out.push(...parts);
    }
  }
  return out.join(" ");
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

function scoreLineMatch(lineLower: string, qLower: string, terms: readonly string[]): number {
  let score = 0;
  if (qLower.length >= 2 && lineLower.includes(qLower)) score += 10;
  if (terms.length > 0) {
    const lineTokens = new Set(tokenize(lineLower));
    for (const term of terms) {
      if (lineTokens.has(term)) score += 2;
      else if (lineLower.includes(term)) score += 1;
    }
  }
  return score;
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
    const score = scoreLineMatch(lineLower, qLower, terms);
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

function hasDirectLineMatch(scrubbedText: string, query: string): boolean {
  const qLower = query.trim().toLowerCase();
  const terms = [...new Set(tokenize(query))];
  for (const line of scrubbedText.split(/\r?\n/)) {
    if (scoreLineMatch(line.toLowerCase(), qLower, terms) > 0) return true;
  }
  return false;
}

function ftsQuote(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

function buildFtsMatchQuery(query: string): string | null {
  const rawTokens = query.match(/[a-zA-Z0-9_\u00c0-\u024f]+/g) ?? [];
  if (rawTokens.length === 0) return null;
  const clauses: string[] = [];
  for (const raw of rawTokens) {
    const parts = splitIdentifierPart(raw);
    if (parts.length > 1) {
      const subClause = parts.map((part) => ftsQuote(part)).join(" AND ");
      clauses.push(`(${ftsQuote(raw.toLowerCase())} OR (${subClause}))`);
    } else {
      clauses.push(ftsQuote(raw.toLowerCase()));
    }
  }
  return clauses.join(" AND ");
}

/**
 * Safely remove legacy per-file JSON code-search cache under `.catenext/cache/`.
 * Never follows symlinks and preserves non-JSON state (e.g. `cli-session-id`, `*.sqlite*`).
 */
export async function cleanupLegacyCodeCache(root: string): Promise<void> {
  const cacheDir = join(root, ".catenext", "cache");
  const legacyDir = join(cacheDir, "code-embeddings");

  try {
    const legacyStat = await lstat(legacyDir);
    if (!legacyStat.isSymbolicLink() && legacyStat.isDirectory()) {
      const entries = await readdir(legacyDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter(
            (entry) => !entry.isSymbolicLink() && entry.isFile() && entry.name.endsWith(".json"),
          )
          .map((entry) => unlink(join(legacyDir, entry.name)).catch(() => {})),
      );
      await rmdir(legacyDir).catch(() => {});
    }
  } catch {
    // ignore missing legacy cache dir
  }

  try {
    const cacheStat = await lstat(cacheDir);
    if (!cacheStat.isSymbolicLink() && cacheStat.isDirectory()) {
      const entries = await readdir(cacheDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter(
            (entry) => !entry.isSymbolicLink() && entry.isFile() && entry.name.endsWith(".json"),
          )
          .map((entry) => unlink(join(cacheDir, entry.name)).catch(() => {})),
      );
    }
  } catch {
    // ignore missing cache dir
  }
}

type ExistingCodeFile = {
  id: number;
  root_id: string | null;
  path: string;
  sha256: string;
  mtime_ms: number;
};

type PendingSearchDoc = {
  rootId: string | null;
  displayPath: string;
  sha: string;
  mtimeMs: number;
  content: string;
  tokens: string;
};

function runInTx(db: DatabaseSync, name: string, fn: () => void): void {
  const useSavepoint = db.isTransaction;
  db.exec(useSavepoint ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  try {
    fn();
    db.exec(useSavepoint ? `RELEASE SAVEPOINT ${name}` : "COMMIT");
  } catch (error) {
    db.exec(useSavepoint ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}` : "ROLLBACK");
    throw error;
  }
}

async function syncCodeSearchIndex(
  db: DatabaseSync,
  projectId: string,
  root: string,
  roots: RegisteredRoot[],
  maxFileBytes: number,
  useFts: boolean,
): Promise<boolean> {
  const targets = await collectRootTargets(root, roots);
  const existingRows = db
    .prepare(
      "SELECT id, root_id, path, sha256, mtime_ms FROM code_search_files WHERE project_id = ?",
    )
    .all(projectId) as ExistingCodeFile[];
  const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

  const activePaths = new Set<string>();
  const mtimeOnlyUpdates: Array<{ id: number; rootId: string | null; mtimeMs: number }> = [];
  const inserts: PendingSearchDoc[] = [];
  const updates: Array<PendingSearchDoc & { id: number }> = [];

  for (const target of targets) {
    const { realRoot, files } = await walkWorkspaceFiles(target.absRoot, {
      extensions: TEXT_EXT,
      skipDirs: DEFAULT_SKIP_DIRS,
      skipDotEntries: false,
      maxFileBytes,
      honorGitignore: true,
    });

    for (const file of files) {
      const normalizedRel = file.rel.replaceAll("\\", "/");
      const displayPath = target.prefix ? `${target.prefix}/${normalizedRel}` : normalizedRel;
      activePaths.add(displayPath);

      const existing = existingByPath.get(displayPath);
      if (existing && existing.mtime_ms === file.mtimeMs && existing.root_id === target.rootId) {
        continue;
      }

      const rawText = await readBoundedUtf8File(file.full, realRoot, maxFileBytes);
      if (rawText === null) {
        activePaths.delete(displayPath);
        continue;
      }

      const rawSha = sha256(rawText);
      if (existing && existing.sha256 === rawSha) {
        mtimeOnlyUpdates.push({ id: existing.id, rootId: target.rootId, mtimeMs: file.mtimeMs });
        continue;
      }

      const sanitized = scrubText(rawText);
      const tokens = buildSearchTokens(displayPath, sanitized);
      if (!existing) {
        inserts.push({
          rootId: target.rootId,
          displayPath,
          sha: rawSha,
          mtimeMs: file.mtimeMs,
          content: sanitized,
          tokens,
        });
      } else {
        updates.push({
          id: existing.id,
          rootId: target.rootId,
          displayPath,
          sha: rawSha,
          mtimeMs: file.mtimeMs,
          content: sanitized,
          tokens,
        });
      }
    }
  }

  const deletedIds: number[] = [];
  for (const row of existingRows) {
    if (!activePaths.has(row.path)) deletedIds.push(row.id);
  }

  let ftsEnabled = useFts;
  if (ftsEnabled && !hasCodeSearchFts(db)) {
    ftsEnabled = tryEnableCodeSearchFts(db);
  }

  runInTx(db, "code_search_sync", () => {
    db.prepare(
      "INSERT INTO projects (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(projectId, new Date().toISOString());

    const deleteFtsRow = ftsEnabled
      ? db.prepare("DELETE FROM code_search_fts WHERE rowid = ?")
      : null;
    const insertFtsRow = ftsEnabled
      ? db.prepare("INSERT INTO code_search_fts (rowid, path, content, tokens) VALUES (?, ?, ?, ?)")
      : null;

    const deleteFile = db.prepare("DELETE FROM code_search_files WHERE project_id = ? AND id = ?");
    const updateMtime = db.prepare(
      "UPDATE code_search_files SET root_id = ?, mtime_ms = ? WHERE id = ?",
    );
    const updateFile = db.prepare(
      "UPDATE code_search_files SET root_id = ?, sha256 = ?, mtime_ms = ?, content = ? WHERE id = ?",
    );
    const insertFile = db.prepare(
      "INSERT INTO code_search_files (project_id, root_id, path, sha256, mtime_ms, content) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    );

    for (const id of deletedIds) {
      deleteFtsRow?.run(id);
      deleteFile.run(projectId, id);
    }

    for (const item of mtimeOnlyUpdates) {
      updateMtime.run(item.rootId, item.mtimeMs, item.id);
    }

    for (const item of inserts) {
      const row = insertFile.get(
        projectId,
        item.rootId,
        item.displayPath,
        item.sha,
        item.mtimeMs,
        item.content,
      ) as { id: number };
      insertFtsRow?.run(row.id, item.displayPath, item.content, item.tokens);
    }

    for (const item of updates) {
      updateFile.run(item.rootId, item.sha, item.mtimeMs, item.content, item.id);
      deleteFtsRow?.run(item.id);
      insertFtsRow?.run(item.id, item.displayPath, item.content, item.tokens);
    }

    if (ftsEnabled && insertFtsRow) {
      const missingFts = db
        .prepare(
          `SELECT f.id, f.path, f.content
           FROM code_search_files f
           LEFT JOIN code_search_fts fts ON fts.rowid = f.id
           WHERE f.project_id = ? AND fts.rowid IS NULL`,
        )
        .all(projectId) as Array<{ id: number; path: string; content: string }>;
      for (const row of missingFts) {
        insertFtsRow.run(row.id, row.path, row.content, buildSearchTokens(row.path, row.content));
      }
    }
  });

  return ftsEnabled;
}

function normalizeBm25Score(bm25Value: number, exactMatch: boolean): number {
  const pos = Math.max(0, -bm25Value);
  const base = 0.25 + 0.65 * (pos / (1 + pos));
  return Math.min(1, exactMatch ? base + 0.1 : base);
}

function queryLikeFallback(
  db: DatabaseSync,
  projectId: string,
  query: string,
  limit: number,
): CodeHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const qLower = trimmed.toLowerCase();
  const terms = [...new Set(tokenize(trimmed))];
  const likeTerms = terms.length > 0 ? terms : [qLower];

  const escapeLike = (s: string) =>
    s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

  const whereClauses = likeTerms.map(
    () => "(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(path) LIKE ? ESCAPE '\\')",
  );
  const params: Array<string | number> = [projectId];
  for (const term of likeTerms) {
    const pattern = `%${escapeLike(term)}%`;
    params.push(pattern, pattern);
  }
  params.push(Math.max(limit * 4, 24));

  const rows = db
    .prepare(
      `SELECT path, content
       FROM code_search_files
       WHERE project_id = ? AND (${whereClauses.join(" OR ")})
       LIMIT ?`,
    )
    .all(...params) as Array<{ path: string; content: string }>;

  const hits: CodeHit[] = [];
  for (const row of rows) {
    const lowerContent = row.content.toLowerCase();
    const lowerPath = row.path.toLowerCase();
    let matchedCount = 0;
    for (const term of likeTerms) {
      if (lowerContent.includes(term) || lowerPath.includes(term)) {
        matchedCount += 1;
      }
    }
    if (matchedCount === 0) continue;
    const exactBoost =
      qLower.length >= 2 && (lowerContent.includes(qLower) || lowerPath.includes(qLower)) ? 0.2 : 0;
    const score = Math.min(1, 0.2 + 0.6 * (matchedCount / likeTerms.length) + exactBoost);
    hits.push({
      source: "code",
      ref: clipText(row.path, 200),
      title: clipText(row.path, 300),
      snippet: extractContextualSnippet(row.content, query, SNIPPET_MAX_LEN),
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  return hits.slice(0, limit);
}

function queryFtsIndex(
  db: DatabaseSync,
  projectId: string,
  query: string,
  limit: number,
): CodeHit[] {
  const ftsQuery = buildFtsMatchQuery(query);
  if (!ftsQuery) return [];
  const qLower = query.trim().toLowerCase();

  const rows = db
    .prepare(
      `SELECT f.path,
              f.content,
              bm25(code_search_fts, 2.0, 1.0, 1.5) AS rank,
              snippet(code_search_fts, 1, '[', ']', '…', 24) AS fts_snippet
       FROM code_search_fts
       JOIN code_search_files f ON f.id = code_search_fts.rowid
       WHERE f.project_id = ? AND code_search_fts MATCH ?
       ORDER BY rank, f.path
       LIMIT ?`,
    )
    .all(projectId, ftsQuery, limit) as Array<{
    path: string;
    content: string;
    rank: number;
    fts_snippet: string | null;
  }>;

  return rows.map((row) => {
    const exactMatch =
      qLower.length >= 2 &&
      (row.content.toLowerCase().includes(qLower) || row.path.toLowerCase().includes(qLower));
    const snippet = hasDirectLineMatch(row.content, query)
      ? extractContextualSnippet(row.content, query, SNIPPET_MAX_LEN)
      : clipText(
          row.fts_snippet?.trim() || extractContextualSnippet(row.content, query, SNIPPET_MAX_LEN),
          SNIPPET_MAX_LEN,
        );
    return {
      source: "code",
      ref: clipText(row.path, 200),
      title: clipText(row.path, 300),
      snippet,
      score: normalizeBm25Score(row.rank, exactMatch),
    };
  });
}

/** Incremental local code index backed by SQLite FTS5 with safe fallback when FTS5 is unavailable. */
export async function searchLocalCode(
  root: string,
  query: string,
  limit = 8,
  options: SearchLocalCodeOptions = {},
): Promise<{ hits: CodeHit[]; degraded: boolean; note?: string }> {
  await cleanupLegacyCodeCache(root);

  const safeLimit = Math.max(0, Math.floor(limit));
  const trimmed = query.trim();
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const roots = options.roots ?? [];
  const projectId = options.projectId ?? STANDALONE_PROJECT_ID;

  let ownedDb: DatabaseSync | undefined;
  let db = options.db;
  if (!db) {
    const dbPath = join(root, STANDALONE_DB_REL);
    await mkdir(join(root, ".catenext", "cache"), { recursive: true, mode: 0o700 });
    ownedDb = openDatabaseAt(dbPath);
    db = ownedDb;
  }

  try {
    const ftsEnabled = await syncCodeSearchIndex(
      db,
      projectId,
      root,
      roots,
      maxFileBytes,
      !options.disableFts5,
    );

    if (safeLimit === 0 || !trimmed) {
      return {
        hits: [],
        degraded: !ftsEnabled,
        note: ftsEnabled
          ? "Pencarian kode memakai SQLite FTS5."
          : "Pencarian kode memakai fallback SQLite tanpa FTS5.",
      };
    }

    if (ftsEnabled) {
      try {
        let hits = queryFtsIndex(db, projectId, trimmed, safeLimit);
        if (hits.length === 0 && trimmed.length >= 2) {
          hits = queryLikeFallback(db, projectId, trimmed, safeLimit);
        }
        return {
          hits,
          degraded: false,
          note: "Pencarian kode memakai SQLite FTS5.",
        };
      } catch {
        const hits = queryLikeFallback(db, projectId, trimmed, safeLimit);
        return {
          hits,
          degraded: true,
          note: "FTS5 gagal dijalankan; memakai fallback SQLite LIKE.",
        };
      }
    }

    const hits = queryLikeFallback(db, projectId, trimmed, safeLimit);
    return {
      hits,
      degraded: true,
      note: "FTS5 tidak tersedia; memakai fallback SQLite LIKE.",
    };
  } finally {
    if (ownedDb) {
      checkpointWalAndClose(ownedDb);
    }
  }
}

/** Fallback keyword bila indeks gagal: ripgrep dengan fallback Node.js bila `rg` tidak tersedia. */
export async function keywordFallback(
  root: string,
  query: string,
  limit = 8,
  options: SearchLocalCodeOptions = {},
): Promise<CodeHit[]> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const targets = await collectRootTargets(root, options.roots ?? []);
  const hits: CodeHit[] = [];
  const qLower = query.trim().toLowerCase();
  if (!qLower || limit <= 0) return [];

  for (const target of targets) {
    if (hits.length >= limit) break;
    let realRoot: string;
    try {
      realRoot = await realpath(target.absRoot);
    } catch {
      continue;
    }

    try {
      const { stdout } = await execFileAsync(
        "rg",
        [
          "-l",
          "--max-count",
          "1",
          "-i",
          "-F",
          "--no-follow",
          "-g",
          "!.catenext/**",
          "-g",
          "!.git/**",
          "-g",
          "!node_modules/**",
          "-g",
          "!dist/**",
          "-g",
          "!.next/**",
          "-g",
          "!target/**",
          "-g",
          "!.venv/**",
          "-g",
          "!.nuxt/**",
          "-g",
          "!out/**",
          "--",
          query,
          ".",
        ],
        { cwd: realRoot, maxBuffer: 5e6 },
      );
      for (const line of stdout.split(/\r?\n/)) {
        const rel = line.trim().replace(/^\.\//, "").replaceAll("\\", "/");
        if (!rel) continue;
        const abs = join(realRoot, rel);
        const content = await readBoundedUtf8File(abs, realRoot, maxFileBytes);
        if (content === null) continue;
        const cleanText = scrubText(content);
        if (!cleanText.toLowerCase().includes(qLower)) continue;
        const displayPath = target.prefix ? `${target.prefix}/${rel}` : rel;
        hits.push({
          source: "code",
          ref: clipText(displayPath, 200),
          title: clipText(displayPath, 300),
          snippet: extractContextualSnippet(cleanText, query),
          score: 0.1,
        });
        if (hits.length >= limit) break;
      }
    } catch (err) {
      const code = (err as { code?: number | string } | undefined)?.code;
      if (code === 1 || code === "1") continue;
      const { files } = await walkWorkspaceFiles(realRoot, {
        extensions: TEXT_EXT,
        skipDirs: DEFAULT_SKIP_DIRS,
        skipDotEntries: false,
        maxFileBytes,
        honorGitignore: true,
      });
      for (const file of files) {
        if (hits.length >= limit) break;
        const realFile = await realpath(file.full).catch(() => null);
        if (!realFile || !isWithinRoot(realRoot, realFile)) continue;
        const text = await readBoundedUtf8File(file.full, realRoot, maxFileBytes);
        if (text === null) continue;
        const cleanText = scrubText(text);
        if (!cleanText.toLowerCase().includes(qLower)) continue;
        const normalizedRel = relative(realRoot, realFile).replaceAll("\\", "/");
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
