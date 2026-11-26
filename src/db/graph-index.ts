import { createHash } from "node:crypto";
import { type Dirent, type Stats, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { collectRootTargets } from "../workspace-roots.js";
import { openDatabaseAt } from "./open.js";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".catenext",
  "dist",
  "build",
  ".turbo",
  "coverage",
  "__pycache__",
]);

const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
]);

const TS_JS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const TS_JS_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [
    /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_][\w$]*)/,
    "function",
  ],
  [
    /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w$]*)/,
    "class",
  ],
  [/^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_][\w$]*)/, "interface"],
  [/^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_][\w$]*)/, "enum"],
  [/^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_][\w$]*)\b(?:\s*<.*>)?\s*=/, "type"],
  [
    /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_][\w$]*)\s*(?::[^=]+)?=/,
    "variable",
  ],
];

const PYTHON_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [/^(?:async\s+)?def\s+([A-Za-z_][\w$]*)\s*\(/, "function"],
  [/^class\s+([A-Za-z_][\w$]*)\s*[:(]/, "class"],
];

const GO_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]+\])?\s*\(/, "function"],
  [/^type\s+([A-Za-z_]\w*)\b/, "type"],
];

const RUST_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [
    /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern(?:\s+"[^"]+")?)\s+)*fn\s+([A-Za-z_]\w*)/,
    "function",
  ],
  [/^(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, "struct"],
  [/^(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, "enum"],
  [/^(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, "trait"],
];

const ALL_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  ...TS_JS_SYMBOL_PATTERNS,
  ...PYTHON_SYMBOL_PATTERNS,
  ...RUST_SYMBOL_PATTERNS,
  ...GO_SYMBOL_PATTERNS,
];

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function withDatabase<T>(dbOrPath: DatabaseSync | string, fn: (db: DatabaseSync) => T): T {
  if (typeof dbOrPath !== "string") return fn(dbOrPath);
  const db = openDatabaseAt(dbOrPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function withDatabaseAsync<T>(
  dbOrPath: DatabaseSync | string,
  fn: (db: DatabaseSync) => Promise<T>,
): Promise<T> {
  if (typeof dbOrPath !== "string") return fn(dbOrPath);
  const db = openDatabaseAt(dbOrPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (CODE_EXT.has(ext)) out.push(full);
  }
}

export function parseImports(content: string): string[] {
  const hits: string[] = [];
  const re =
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(re)) {
    const spec = match[1] ?? match[2];
    if (spec?.startsWith(".")) hits.push(spec);
  }
  return [...new Set(hits)];
}

function patternsForExt(ext?: string): Array<[RegExp, string]> {
  if (!ext) return ALL_SYMBOL_PATTERNS;
  if (TS_JS_EXT.has(ext)) return TS_JS_SYMBOL_PATTERNS;
  if (ext === ".py") return PYTHON_SYMBOL_PATTERNS;
  if (ext === ".go") return GO_SYMBOL_PATTERNS;
  if (ext === ".rs") return RUST_SYMBOL_PATTERNS;
  return ALL_SYMBOL_PATTERNS;
}

export function parseSymbols(
  content: string,
  ext?: string,
): Array<{ name: string; kind: string; line: number }> {
  const symbols: Array<{ name: string; kind: string; line: number }> = [];
  const lines = content.split(/\r?\n/);
  const patterns = patternsForExt(ext);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const [re, kind] of patterns) {
      const match = line.match(re);
      if (match?.[1]) {
        symbols.push({ name: match[1], kind, line: i + 1 });
        break;
      }
    }
  }
  return symbols.slice(0, 80);
}

function importCandidates(base: string, spec: string): string[] {
  const candidates = [base];
  if (spec.endsWith(".js")) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  } else if (spec.endsWith(".jsx")) {
    const stem = base.slice(0, -4);
    candidates.push(`${stem}.tsx`, `${stem}.ts`);
  } else if (spec.endsWith(".mjs")) {
    candidates.push(`${base.slice(0, -4)}.mts`);
  } else if (spec.endsWith(".cjs")) {
    candidates.push(`${base.slice(0, -4)}.cts`);
  }
  candidates.push(
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.mts"),
    join(base, "index.cts"),
    join(base, "index.js"),
    join(base, "index.jsx"),
    join(base, "index.mjs"),
    join(base, "index.cjs"),
  );
  return candidates;
}

function toRelInsideRoot(absRoot: string, candidate: string): string | null {
  const rel = relative(absRoot, candidate).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

export function resolveImport(
  fromFile: string,
  spec: string,
  root: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  const absRoot = resolve(root);
  const absFrom = isAbsolute(fromFile) ? resolve(fromFile) : resolve(absRoot, fromFile);
  const base = resolve(dirname(absFrom), spec);
  for (const candidate of importCandidates(base, spec)) {
    const rel = toRelInsideRoot(absRoot, candidate);
    if (!rel) continue;
    const exists = knownFiles ? knownFiles.has(rel) : isRegularFile(candidate);
    if (exists) return rel;
  }
  return toRelInsideRoot(absRoot, base);
}

export type GraphIndexResult = {
  files: number;
  symbols: number;
  edges: number;
};

type WalkedEntry = {
  rootId: string | null;
  absRoot: string;
  prefix: string;
  full: string;
  relInRoot: string;
  rel: string;
  ext: string;
  mtimeMs: number;
};

type ExistingFileRow = {
  id: number;
  root_id: string | null;
  path: string;
  hash: string | null;
  mtime_ms: number | null;
};

export async function indexProjectGraph(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  root: string,
): Promise<GraphIndexResult> {
  return withDatabaseAsync(dbOrPath, async (db) => {
    const registeredRoots = db
      .prepare("SELECT id, path, label FROM workspace_roots WHERE project_id = ? ORDER BY path")
      .all(projectId) as Array<{ id: string; path: string; label: string | null }>;
    const targets = await collectRootTargets(root, registeredRoots);

    const entries: WalkedEntry[] = [];
    const knownFilesByRoot = new Map<string | null, Set<string>>();

    for (const target of targets) {
      const walkedPaths: string[] = [];
      await walk(target.absRoot, walkedPaths);
      const rootKnown = new Set<string>();
      for (const full of walkedPaths) {
        let st: Stats;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        const relInRoot = relative(target.absRoot, full).replaceAll("\\", "/");
        const rel = target.prefix ? `${target.prefix}/${relInRoot}` : relInRoot;
        rootKnown.add(relInRoot);
        entries.push({
          rootId: target.rootId,
          absRoot: target.absRoot,
          prefix: target.prefix,
          full,
          relInRoot,
          rel,
          ext: extname(full),
          mtimeMs: Math.floor(st.mtimeMs),
        });
      }
      knownFilesByRoot.set(target.rootId, rootKnown);
    }

    const knownFiles = new Set(entries.map((entry) => entry.rel));
    const entryByRel = new Map(entries.map((entry) => [entry.rel, entry]));

    const existingRows = db
      .prepare("SELECT id, root_id, path, hash, mtime_ms FROM files WHERE project_id = ?")
      .all(projectId) as ExistingFileRow[];
    const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

    const deletedIds: number[] = [];
    for (const row of existingRows) {
      if (!knownFiles.has(row.path)) deletedIds.push(row.id);
    }

    const edgeRefreshPaths = new Set<string>();
    if (deletedIds.length > 0) {
      const placeholders = deletedIds.map(() => "?").join(", ");
      const affected = db
        .prepare(
          `SELECT DISTINCT f.path
           FROM edges e
           JOIN files f ON f.id = e.from_file_id
           WHERE e.project_id = ? AND e.to_file_id IN (${placeholders})`,
        )
        .all(projectId, ...deletedIds) as Array<{ path: string }>;
      for (const row of affected) {
        if (knownFiles.has(row.path)) edgeRefreshPaths.add(row.path);
      }
    }

    const addedCount = entries.filter((entry) => !existingByPath.has(entry.rel)).length;
    if (addedCount > 0) {
      const unresolved = db
        .prepare(
          `SELECT DISTINCT f.path
           FROM edges e
           JOIN files f ON f.id = e.from_file_id
           WHERE e.project_id = ? AND e.to_file_id IS NULL`,
        )
        .all(projectId) as Array<{ path: string }>;
      for (const row of unresolved) {
        if (knownFiles.has(row.path)) edgeRefreshPaths.add(row.path);
      }
    }

    const idByPath = new Map<string, number>();
    const mtimeOnlyUpdates: Array<{ id: number; rootId: string | null; mtimeMs: number }> = [];
    const newFiles: Array<{
      rootId: string | null;
      rel: string;
      hash: string;
      mtimeMs: number;
      symbols: Array<{ name: string; kind: string; line: number }>;
      imports: string[];
    }> = [];
    const modifiedFiles: Array<{
      id: number;
      rootId: string | null;
      rel: string;
      hash: string;
      mtimeMs: number;
      symbols: Array<{ name: string; kind: string; line: number }>;
      imports: string[];
    }> = [];
    const refreshedEdges: Array<{ id: number; rel: string; imports: string[] }> = [];

    const resolveImportsForEntry = (entry: WalkedEntry, content: string): string[] => {
      const rootKnown = knownFilesByRoot.get(entry.rootId);
      return parseImports(content)
        .map((spec) => resolveImport(entry.full, spec, entry.absRoot, rootKnown))
        .filter((to): to is string => Boolean(to))
        .map((to) => (entry.prefix ? `${entry.prefix}/${to}` : to));
    };

    for (const entry of entries) {
      const existing = existingByPath.get(entry.rel);
      if (existing && existing.mtime_ms === entry.mtimeMs && existing.root_id === entry.rootId) {
        idByPath.set(entry.rel, existing.id);
        continue;
      }

      const content = await readFile(entry.full, "utf8");
      const contentHash = hash(content);
      if (existing && existing.hash === contentHash) {
        idByPath.set(entry.rel, existing.id);
        mtimeOnlyUpdates.push({ id: existing.id, rootId: entry.rootId, mtimeMs: entry.mtimeMs });
        continue;
      }

      const symbols = parseSymbols(content, entry.ext);
      const imports = resolveImportsForEntry(entry, content);

      if (!existing) {
        newFiles.push({
          rootId: entry.rootId,
          rel: entry.rel,
          hash: contentHash,
          mtimeMs: entry.mtimeMs,
          symbols,
          imports,
        });
      } else {
        idByPath.set(entry.rel, existing.id);
        modifiedFiles.push({
          id: existing.id,
          rootId: entry.rootId,
          rel: entry.rel,
          hash: contentHash,
          mtimeMs: entry.mtimeMs,
          symbols,
          imports,
        });
      }
    }

    const changedRels = new Set([
      ...newFiles.map((f) => f.rel),
      ...modifiedFiles.map((f) => f.rel),
    ]);
    for (const rel of edgeRefreshPaths) {
      if (changedRels.has(rel)) continue;
      const existing = existingByPath.get(rel);
      const entry = entryByRel.get(rel);
      if (!existing || !entry) continue;
      const content = await readFile(entry.full, "utf8");
      const imports = resolveImportsForEntry(entry, content);
      refreshedEdges.push({ id: existing.id, rel, imports });
    }

    const useSavepoint = typeof dbOrPath !== "string";
    db.exec(useSavepoint ? "SAVEPOINT graph_index" : "BEGIN IMMEDIATE");
    try {
      const deleteFile = db.prepare("DELETE FROM files WHERE project_id = ? AND id = ?");
      const updateMtime = db.prepare("UPDATE files SET root_id = ?, mtime_ms = ? WHERE id = ?");
      const updateFile = db.prepare(
        "UPDATE files SET root_id = ?, hash = ?, mtime_ms = ? WHERE id = ?",
      );
      const deleteSymbolsForFile = db.prepare(
        "DELETE FROM symbols WHERE project_id = ? AND file_id = ?",
      );
      const deleteEdgesForFile = db.prepare(
        "DELETE FROM edges WHERE project_id = ? AND from_file_id = ?",
      );
      const insertFile = db.prepare(
        "INSERT INTO files (project_id, root_id, path, hash, mtime_ms) VALUES (?, ?, ?, ?, ?) RETURNING id",
      );
      const insertSymbol = db.prepare(
        "INSERT INTO symbols (project_id, file_id, name, kind, line) VALUES (?, ?, ?, ?, ?)",
      );
      const insertEdge = db.prepare(
        "INSERT INTO edges (project_id, kind, from_file_id, to_file_id, label) VALUES (?, ?, ?, ?, ?)",
      );

      for (const id of deletedIds) deleteFile.run(projectId, id);
      for (const item of mtimeOnlyUpdates) updateMtime.run(item.rootId, item.mtimeMs, item.id);

      const pendingEdges: Array<{ fromId: number; to: string }> = [];

      for (const item of newFiles) {
        const row = insertFile.get(projectId, item.rootId, item.rel, item.hash, item.mtimeMs) as {
          id: number;
        };
        idByPath.set(item.rel, row.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, row.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const to of item.imports) pendingEdges.push({ fromId: row.id, to });
      }

      for (const item of modifiedFiles) {
        updateFile.run(item.rootId, item.hash, item.mtimeMs, item.id);
        deleteSymbolsForFile.run(projectId, item.id);
        deleteEdgesForFile.run(projectId, item.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, item.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const to of item.imports) pendingEdges.push({ fromId: item.id, to });
      }

      for (const item of refreshedEdges) {
        deleteEdgesForFile.run(projectId, item.id);
        for (const to of item.imports) pendingEdges.push({ fromId: item.id, to });
      }

      for (const edge of pendingEdges) {
        const toId = idByPath.get(edge.to);
        insertEdge.run(projectId, "imports", edge.fromId, toId ?? null, edge.to);
      }

      db.exec(useSavepoint ? "RELEASE SAVEPOINT graph_index" : "COMMIT");
    } catch (error) {
      db.exec(
        useSavepoint
          ? "ROLLBACK TO SAVEPOINT graph_index; RELEASE SAVEPOINT graph_index"
          : "ROLLBACK",
      );
      throw error;
    }

    const totalFiles = (
      db.prepare("SELECT COUNT(*) AS c FROM files WHERE project_id = ?").get(projectId) as {
        c: number;
      }
    ).c;
    const totalSymbols = (
      db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE project_id = ?").get(projectId) as {
        c: number;
      }
    ).c;
    const totalEdges = (
      db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project_id = ?").get(projectId) as {
        c: number;
      }
    ).c;

    return { files: totalFiles, symbols: totalSymbols, edges: totalEdges };
  });
}

export function graphNeighbors(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  path: string,
  limit: number,
  depth = 1,
): Array<{ kind: string; from: string; to: string; label?: string }> {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const maxDepth = Math.min(2, Math.max(1, Math.floor(depth)));

  return withDatabase(dbOrPath, (db) => {
    const file = db
      .prepare("SELECT id, path FROM files WHERE project_id = ? AND path = ?")
      .get(projectId, path) as { id: number; path: string } | undefined;
    if (!file) return [];

    const seenEdgeIds = new Set<number>();
    const visitedFileIds = new Set<number>([file.id]);
    let frontier = [file.id];
    const results: Array<{ kind: string; from: string; to: string; label?: string }> = [];

    for (let hop = 0; hop < maxDepth && frontier.length > 0 && results.length < safeLimit; hop++) {
      const nodePlaceholders = frontier.map(() => "?").join(", ");
      const remaining = safeLimit - results.length;
      const excludedIds = [...seenEdgeIds];
      const excludeClause =
        excludedIds.length > 0 ? `AND e.id NOT IN (${excludedIds.map(() => "?").join(", ")})` : "";
      const rows = db
        .prepare(
          `SELECT e.id, e.kind, e.from_file_id, e.to_file_id,
                  f1.path AS from_path, COALESCE(f2.path, e.label) AS to_path, e.label
           FROM edges e
           JOIN files f1 ON f1.id = e.from_file_id
           LEFT JOIN files f2 ON f2.id = e.to_file_id
           WHERE e.project_id = ?
             AND (e.from_file_id IN (${nodePlaceholders}) OR e.to_file_id IN (${nodePlaceholders}))
             ${excludeClause}
           ORDER BY e.id
           LIMIT ?`,
        )
        .all(projectId, ...frontier, ...frontier, ...excludedIds, remaining) as Array<{
        id: number;
        kind: string;
        from_file_id: number;
        to_file_id: number | null;
        from_path: string;
        to_path: string;
        label: string | null;
      }>;

      const nextFrontier: number[] = [];
      for (const row of rows) {
        seenEdgeIds.add(row.id);
        results.push({
          kind: row.kind,
          from: row.from_path,
          to: row.to_path,
          ...(row.label ? { label: row.label } : {}),
        });
        if (!visitedFileIds.has(row.from_file_id)) {
          visitedFileIds.add(row.from_file_id);
          nextFrontier.push(row.from_file_id);
        }
        if (row.to_file_id !== null && !visitedFileIds.has(row.to_file_id)) {
          visitedFileIds.add(row.to_file_id);
          nextFrontier.push(row.to_file_id);
        }
      }
      frontier = nextFrontier;
    }

    return results;
  });
}

export function symbolSearch(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  query: string,
  limit: number,
): Array<{ name: string; kind: string; path: string; line?: number }> {
  return withDatabase(dbOrPath, (db) => {
    const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const rows = db
      .prepare(
        `SELECT s.name, s.kind, s.line, f.path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.project_id = ? AND s.name LIKE ? ESCAPE '\\'
         ORDER BY s.name
         LIMIT ?`,
      )
      .all(projectId, `%${escaped}%`, limit) as Array<{
      name: string;
      kind: string;
      line: number | null;
      path: string;
    }>;
    return rows.map((row) => ({
      name: row.name,
      kind: row.kind,
      path: row.path,
      ...(row.line != null ? { line: row.line } : {}),
    }));
  });
}
