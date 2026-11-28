import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  type Dirent,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ClaimGraphFile,
  GraphNeighborsInput,
  type GraphNeighborsOutput,
  MAX_CLAIM_SYMBOL_LOCATIONS,
} from "@catenext/shared";
import type { z } from "zod";
import { collectRootTargets } from "../workspace-roots.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SKIP_DIRS,
  type GitignoreRule,
  isGitignored,
  isWithinRoot,
  parseGitignore,
  readBoundedUtf8File,
  walkWorkspaceFiles,
} from "../workspace-walk.js";
import {
  type ComposerPsr4Entry,
  createTsResolutionContext,
  loadComposerPsr4,
  loadGoModule,
  loadWorkspacePackages,
  resolveGoImport,
  resolveImport,
  safeRealpathSync,
  type TsResolutionContext,
  toRelInsideRoot,
  type WorkspacePackageEntry,
} from "./graph-import-resolver.js";
import {
  CODE_EXT,
  extractSfcScriptBlocks,
  MAX_INDEXED_FILE_SYMBOLS,
  parseImports,
  parseSymbols,
  parseTsJsImportEntries,
  SFC_EXT,
  TS_JS_EXT,
  type TsJsImportEntry,
} from "./graph-parser.js";
import { checkpointWalAndClose, openDatabaseAt } from "./open.js";

export {
  type ComposerPsr4Entry,
  createTsResolutionContext,
  loadComposerPsr4,
  loadGoModule,
  loadWorkspacePackages,
  parseImports,
  parseSymbols,
  resolveImport,
  type TsResolutionContext,
  type WorkspacePackageEntry,
};

export const GRAPH_PARSER_VERSION = 2;

function graphParserVersionKey(projectId: string): string {
  // The legacy DB-wide marker cannot prove freshness for any one project.
  return `graph_parser_version:${projectId}`;
}

function isGraphParserCurrent(db: DatabaseSync, projectId: string): boolean {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(graphParserVersionKey(projectId));
  const version = Number(row?.value);
  return Number.isFinite(version) && version >= GRAPH_PARSER_VERSION;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function withDatabase<T>(dbOrPath: DatabaseSync | string, fn: (db: DatabaseSync) => T): T {
  if (typeof dbOrPath !== "string") return fn(dbOrPath);
  const db = openDatabaseAt(dbOrPath);
  try {
    return fn(db);
  } finally {
    checkpointWalAndClose(db);
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
    checkpointWalAndClose(db);
  }
}

export type GraphIndexResult = {
  files: number;
  symbols: number;
  edges: number;
};

export type GraphIndexOptions = {
  maxFileBytes?: number;
  rebuildEdges?: boolean;
};

type WalkedEntry = {
  rootId: string | null;
  absRoot: string;
  realRoot: string;
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

type ResolvedEdgeTarget = {
  to: string;
  kind: "imports" | "reexport";
};

function createImportResolver(knownFilesByRoot: Map<string | null, Set<string>>) {
  const psr4ByRoot = new Map<string, ComposerPsr4Entry[]>();
  const getPsr4ForRoot = (realRoot: string): ComposerPsr4Entry[] => {
    let cached = psr4ByRoot.get(realRoot);
    if (!cached) {
      cached = loadComposerPsr4(realRoot);
      psr4ByRoot.set(realRoot, cached);
    }
    return cached;
  };

  const goModuleByRoot = new Map<string, string | null>();
  const getGoModuleForRoot = (realRoot: string): string | null => {
    if (goModuleByRoot.has(realRoot)) {
      return goModuleByRoot.get(realRoot) ?? null;
    }
    const mod = loadGoModule(realRoot);
    goModuleByRoot.set(realRoot, mod);
    return mod;
  };

  const tsContextByRoot = new Map<string, TsResolutionContext>();
  const getTsContextForRoot = (realRoot: string): TsResolutionContext => {
    let cached = tsContextByRoot.get(realRoot);
    if (!cached) {
      cached = createTsResolutionContext(realRoot);
      tsContextByRoot.set(realRoot, cached);
    }
    return cached;
  };

  return (
    entry: Pick<WalkedEntry, "rootId" | "realRoot" | "prefix" | "full" | "relInRoot" | "ext">,
    content: string,
  ): ResolvedEdgeTarget[] => {
    const rootKnown = knownFilesByRoot.get(entry.rootId);
    const psr4 = entry.ext === ".php" ? getPsr4ForRoot(entry.realRoot) : undefined;
    const goMod = entry.ext === ".go" ? getGoModuleForRoot(entry.realRoot) : undefined;
    const isTsJs = TS_JS_EXT.has(entry.ext);
    const isSfc = SFC_EXT.has(entry.ext);
    const tsCtx = isTsJs || isSfc ? getTsContextForRoot(entry.realRoot) : undefined;

    const specs: TsJsImportEntry[] = isTsJs
      ? parseTsJsImportEntries(content, true)
      : isSfc
        ? (() => {
            const merged = new Map<string, "imports" | "reexport">();
            for (const block of extractSfcScriptBlocks(content)) {
              for (const item of parseTsJsImportEntries(block.code, true)) {
                const prev = merged.get(item.spec);
                if (!prev || (prev === "reexport" && item.kind === "imports")) {
                  merged.set(item.spec, item.kind);
                }
              }
            }
            return [...merged.entries()].map(([spec, kind]) => ({ spec, kind }));
          })()
        : parseImports(content, entry.ext).map((spec) => ({ spec, kind: "imports" as const }));

    const byTarget = new Map<string, "imports" | "reexport">();
    const recordTarget = (target: string, kind: "imports" | "reexport") => {
      const prev = byTarget.get(target);
      if (!prev || (prev === "reexport" && kind === "imports")) {
        byTarget.set(target, kind);
      }
    };

    for (const item of specs) {
      if (entry.ext === ".go") {
        for (const target of resolveGoImport(
          item.spec,
          entry.realRoot,
          entry.realRoot,
          goMod ?? null,
          rootKnown,
        )) {
          if (target !== entry.relInRoot) {
            recordTarget(entry.prefix ? `${entry.prefix}/${target}` : target, "imports");
          }
        }
        continue;
      }
      const to = resolveImport(
        entry.full,
        item.spec,
        entry.realRoot,
        rootKnown,
        psr4,
        goMod,
        tsCtx,
      );
      if (to && to !== entry.relInRoot) {
        recordTarget(entry.prefix ? `${entry.prefix}/${to}` : to, item.kind);
      }
    }
    return [...byTarget.entries()].map(([to, kind]) => ({ to, kind }));
  };
}

export async function indexProjectGraph(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  root: string,
  options: GraphIndexOptions = {},
): Promise<GraphIndexResult> {
  clearGraphFreshnessCache(projectId);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return withDatabaseAsync(dbOrPath, async (db) => {
    const registeredRoots = db
      .prepare("SELECT id, path, label FROM workspace_roots WHERE project_id = ? ORDER BY path")
      .all(projectId) as Array<{ id: string; path: string; label: string | null }>;
    const targets = await collectRootTargets(root, registeredRoots);

    const entries: WalkedEntry[] = [];
    const knownFilesByRoot = new Map<string | null, Set<string>>();

    for (const target of targets) {
      const { realRoot, files: walkedFiles } = await walkWorkspaceFiles(target.absRoot, {
        extensions: CODE_EXT,
        skipDirs: DEFAULT_SKIP_DIRS,
        skipDotEntries: true,
        maxFileBytes,
        honorGitignore: true,
      });
      const rootKnown = new Set<string>();
      for (const file of walkedFiles) {
        const relInRoot = file.rel;
        const rel = target.prefix ? `${target.prefix}/${relInRoot}` : relInRoot;
        rootKnown.add(relInRoot);
        entries.push({
          rootId: target.rootId,
          absRoot: target.absRoot,
          realRoot,
          prefix: target.prefix,
          full: file.full,
          relInRoot,
          rel,
          ext: file.ext,
          mtimeMs: file.mtimeMs,
        });
      }
      knownFilesByRoot.set(target.rootId, rootKnown);
    }

    const knownFiles = new Set(entries.map((entry) => entry.rel));

    const existingRows = db
      .prepare("SELECT id, root_id, path, hash, mtime_ms FROM files WHERE project_id = ?")
      .all(projectId) as ExistingFileRow[];
    const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

    const needsParserUpgrade = !isGraphParserCurrent(db, projectId);

    const legacyReexportFileIds = new Set<number>();
    if (!needsParserUpgrade && existingRows.length > 0) {
      const legacyRows = db
        .prepare(
          `SELECT DISTINCT e.from_file_id AS id
           FROM edges e
           WHERE e.project_id = ?
             AND e.kind = 'reexport'
             AND e.from_file_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM symbols s WHERE s.project_id = ? AND s.file_id = e.from_file_id
             )`,
        )
        .all(projectId, projectId) as Array<{ id: number }>;
      for (const row of legacyRows) legacyReexportFileIds.add(row.id);
    }

    const deletedIds: number[] = [];
    for (const row of existingRows) {
      if (!knownFiles.has(row.path)) deletedIds.push(row.id);
    }

    const edgeRefreshPaths = new Set<string>();
    if (!options.rebuildEdges && deletedIds.length > 0) {
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

    if (!options.rebuildEdges && entries.some((entry) => !existingByPath.has(entry.rel))) {
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
      imports: ResolvedEdgeTarget[];
    }> = [];
    const modifiedFiles: Array<{
      id: number;
      rootId: string | null;
      rel: string;
      hash: string;
      mtimeMs: number;
      symbols: Array<{ name: string; kind: string; line: number }>;
      imports: ResolvedEdgeTarget[];
    }> = [];
    const refreshedEdges: Array<{ id: number; imports: ResolvedEdgeTarget[] }> = [];

    const resolveImportsForEntry = createImportResolver(knownFilesByRoot);

    for (const entry of entries) {
      const existing = existingByPath.get(entry.rel);
      const forceReparse =
        existing !== undefined && (needsParserUpgrade || legacyReexportFileIds.has(existing.id));
      const refreshEdges = options.rebuildEdges || edgeRefreshPaths.has(entry.rel);
      if (
        !forceReparse &&
        !refreshEdges &&
        existing &&
        existing.mtime_ms === entry.mtimeMs &&
        existing.root_id === entry.rootId
      ) {
        idByPath.set(entry.rel, existing.id);
        continue;
      }

      const content = await readBoundedUtf8File(entry.full, entry.realRoot, maxFileBytes);
      if (content === null) {
        if (existing) deletedIds.push(existing.id);
        continue;
      }
      const contentHash = hash(content);
      if (!forceReparse && existing && existing.hash === contentHash) {
        idByPath.set(entry.rel, existing.id);
        if (existing.mtime_ms !== entry.mtimeMs || existing.root_id !== entry.rootId) {
          mtimeOnlyUpdates.push({ id: existing.id, rootId: entry.rootId, mtimeMs: entry.mtimeMs });
        }
        if (refreshEdges) {
          refreshedEdges.push({ id: existing.id, imports: resolveImportsForEntry(entry, content) });
        }
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

      const pendingEdges: Array<{ fromId: number; to: string; kind: "imports" | "reexport" }> = [];

      for (const item of newFiles) {
        const row = insertFile.get(projectId, item.rootId, item.rel, item.hash, item.mtimeMs) as {
          id: number;
        };
        idByPath.set(item.rel, row.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, row.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const edge of item.imports) {
          pendingEdges.push({ fromId: row.id, to: edge.to, kind: edge.kind });
        }
      }

      for (const item of modifiedFiles) {
        updateFile.run(item.rootId, item.hash, item.mtimeMs, item.id);
        deleteSymbolsForFile.run(projectId, item.id);
        deleteEdgesForFile.run(projectId, item.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, item.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const edge of item.imports) {
          pendingEdges.push({ fromId: item.id, to: edge.to, kind: edge.kind });
        }
      }

      for (const item of refreshedEdges) {
        deleteEdgesForFile.run(projectId, item.id);
        for (const edge of item.imports) {
          pendingEdges.push({ fromId: item.id, to: edge.to, kind: edge.kind });
        }
      }

      for (const edge of pendingEdges) {
        const toId = idByPath.get(edge.to);
        insertEdge.run(projectId, edge.kind, edge.fromId, toId ?? null, edge.to);
      }

      db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(graphParserVersionKey(projectId), String(GRAPH_PARSER_VERSION));

      db.exec(useSavepoint ? "RELEASE SAVEPOINT graph_index" : "COMMIT");
    } catch (error) {
      db.exec(
        useSavepoint
          ? "ROLLBACK TO SAVEPOINT graph_index; RELEASE SAVEPOINT graph_index"
          : "ROLLBACK",
      );
      throw error;
    }

    return readGraphCounts(db, projectId);
  });
}

function readGraphCounts(db: DatabaseSync, projectId: string): GraphIndexResult {
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
}

export function getGraphCounts(
  dbOrPath: DatabaseSync | string,
  projectId: string,
): GraphIndexResult {
  return withDatabase(dbOrPath, (db) => readGraphCounts(db, projectId));
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

const MAX_NEIGHBOR_FILE_SYMBOLS = 12;

type NeighborSymbolRow = { name: string; kind?: string; line?: number | null };
type GraphRootDirs = Array<{ rootId: string | null; dir: string }>;
type ClaimTargetRow = Pick<ExistingFileRow, "root_id" | "mtime_ms"> & {
  registered_dir: string | null;
};

function isCurrentClaimTarget(path: string, row: ClaimTargetRow, rootDirs: GraphRootDirs): boolean {
  if (row.mtime_ms === null) return false;
  const root = rootDirs.find(({ rootId }) => rootId === row.root_id);
  if (!root) return false;

  try {
    const absRoot = resolve(root.dir);
    let relativePath = path;
    if (row.root_id !== null) {
      if (row.registered_dir === null || resolve(row.registered_dir) !== absRoot) return false;
      const slash = path.indexOf("/");
      if (!path.startsWith("@") || slash < 2) return false;
      relativePath = path.slice(slash + 1);
    }

    const candidate = resolve(absRoot, relativePath);
    if (toRelInsideRoot(absRoot, candidate) !== relativePath) return false;
    if (!lstatSync(absRoot).isDirectory()) return false;
    const realRoot = realpathSync(absRoot);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || Math.floor(stat.mtimeMs) !== row.mtime_ms) return false;
    const realCandidate = realpathSync(candidate);
    if (!isWithinRoot(realRoot, realCandidate)) return false;
    accessSync(realCandidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function prioritizeSymbolLocations(rows: NeighborSymbolRow[]): ClaimGraphFile["symbol_locations"] {
  const functions: Array<{ name: string; line: number }> = [];
  const others: Array<{ name: string; line: number }> = [];
  // Rows come in source order, with ID breaking ties. Keep that order within each group.
  for (const { name, kind, line } of rows) {
    if (line == null || !Number.isSafeInteger(line) || line < 1) continue;
    if (kind === "function" || kind === "method") {
      functions.push({ name, line });
      if (functions.length === MAX_CLAIM_SYMBOL_LOCATIONS) return functions;
    } else if (others.length < MAX_CLAIM_SYMBOL_LOCATIONS) {
      others.push({ name, line });
    }
  }
  const locations = [
    ...functions,
    ...others.slice(0, MAX_CLAIM_SYMBOL_LOCATIONS - functions.length),
  ];
  return locations.length > 0 ? locations : undefined;
}

export function queryGraphNeighbors(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  rawInput: z.input<typeof GraphNeighborsInput>,
  rootDirs?: GraphRootDirs,
): z.output<typeof GraphNeighborsOutput> {
  return queryGraphNeighborsInternal(dbOrPath, projectId, rawInput, rootDirs, false);
}

export function queryClaimGraphSlice(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  paths: string[],
  rootDirs: GraphRootDirs,
): ClaimGraphFile[] {
  return queryGraphNeighborsInternal(
    dbOrPath,
    projectId,
    { paths, depth: 1, limit: 15, include_symbols: true },
    rootDirs,
    true,
  ).files;
}

function queryGraphNeighborsInternal(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  rawInput: z.input<typeof GraphNeighborsInput>,
  rootDirs: GraphRootDirs | undefined,
  claimSlice: boolean,
): Omit<z.output<typeof GraphNeighborsOutput>, "files"> & { files: ClaimGraphFile[] } {
  const parsed = GraphNeighborsInput.parse(rawInput);
  const rawTargets = parsed.paths ?? (parsed.path ? [parsed.path] : []);
  const targetPaths = [...new Set(rawTargets)].slice(0, 5);

  return withDatabase(dbOrPath, (db) => {
    const freshness = rootDirs ? checkGraphFreshness(db, projectId, rootDirs) : undefined;
    const includeLocations = claimSlice && freshness?.stale === false;
    const claimTargetStmt = includeLocations
      ? db.prepare(
          `SELECT f.root_id, f.mtime_ms, r.path AS registered_dir
           FROM files f
           LEFT JOIN workspace_roots r ON r.project_id = f.project_id AND r.id = f.root_id
           WHERE f.project_id = ? AND f.path = ?`,
        )
      : null;
    const symbolStmt = parsed.include_symbols
      ? db.prepare(
          `SELECT s.name${includeLocations ? ", s.kind, s.line" : ""}
           FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE s.project_id = ? AND f.path = ?
           ORDER BY COALESCE(s.line, 2147483647), s.id
           LIMIT ?`,
        )
      : null;

    const files: ClaimGraphFile[] = [];
    const seenEdgeKeys = new Set<string>();
    const aggregatedEdges: Array<{ kind: string; from: string; to: string; label?: string }> = [];

    for (const targetPath of targetPaths) {
      const fileEdges = graphNeighbors(db, projectId, targetPath, parsed.limit, parsed.depth);
      for (const edge of fileEdges) {
        if (aggregatedEdges.length >= parsed.limit) break;
        const key = `${edge.kind}\0${edge.from}\0${edge.to}\0${edge.label ?? ""}`;
        if (seenEdgeKeys.has(key)) continue;
        seenEdgeKeys.add(key);
        aggregatedEdges.push(edge);
      }

      if (symbolStmt) {
        // Project sampling may miss this target or skip an unregistered root.
        const target = claimTargetStmt?.get(projectId, targetPath) as ClaimTargetRow | undefined;
        const targetCurrent =
          target !== undefined &&
          rootDirs !== undefined &&
          isCurrentClaimTarget(targetPath, target, rootDirs);
        const symbolLimit = targetCurrent ? MAX_INDEXED_FILE_SYMBOLS : MAX_NEIGHBOR_FILE_SYMBOLS;
        const symRows = symbolStmt.all(projectId, targetPath, symbolLimit) as NeighborSymbolRow[];
        const locations = targetCurrent ? prioritizeSymbolLocations(symRows) : undefined;
        files.push({
          path: targetPath,
          edges: fileEdges,
          symbols: symRows.slice(0, MAX_NEIGHBOR_FILE_SYMBOLS).map((row) => row.name),
          ...(locations ? { symbol_locations: locations } : {}),
        });
      } else {
        files.push({
          path: targetPath,
          edges: fileEdges,
        });
      }
    }

    const singlePath = parsed.path ?? (targetPaths.length === 1 ? targetPaths[0] : undefined);

    return {
      ...(singlePath !== undefined ? { path: singlePath } : {}),
      edges: aggregatedEdges,
      files,
      ...(freshness?.stale
        ? { stale: true, ...(freshness.reason ? { stale_reason: freshness.reason } : {}) }
        : {}),
    };
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

export type GraphFreshnessResult = {
  stale: boolean;
  reason?: string;
  checked_files?: number;
  modified_files?: string[];
};

export const MICRO_REINDEX_MAX_FILES = 10;
const MAX_FRESHNESS_CHECK_FILES = 100;
const MAX_UNINDEXED_SCAN_DIRS = 64;
const MAX_UNINDEXED_SCAN_ENTRIES = 256;
const MAX_MICRO_GITIGNORE_BYTES = 64 * 1024;

function hasAnyCodeFileBounded(absDir: string): boolean {
  let realRoot: string;
  try {
    const rootStat = lstatSync(absDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    realRoot = realpathSync(absDir);
  } catch {
    return false;
  }

  const queue: string[] = [realRoot];
  const visited = new Set<string>([realRoot]);
  let dirsChecked = 0;
  let entriesChecked = 0;

  while (queue.length > 0 && dirsChecked < MAX_UNINDEXED_SCAN_DIRS) {
    const dir = queue.shift();
    if (!dir) break;
    dirsChecked++;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entriesChecked >= MAX_UNINDEXED_SCAN_ENTRIES) return false;
      entriesChecked++;
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || DEFAULT_SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);
      try {
        const lst = lstatSync(full);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) {
          const realChild = realpathSync(full);
          if (isWithinRoot(realRoot, realChild) && !visited.has(realChild)) {
            visited.add(realChild);
            queue.push(realChild);
          }
          continue;
        }
        if (lst.isFile() && CODE_EXT.has(extname(entry.name).toLowerCase())) {
          const realFile = realpathSync(full);
          if (isWithinRoot(realRoot, realFile)) return true;
        }
      } catch {
        // Ignore transient or unreadable entries
      }
    }
  }

  return false;
}

const DEFAULT_GRAPH_FRESHNESS_TTL_MS = 5_000;
const MAX_FRESHNESS_CACHE_ENTRIES = 100;

interface FreshnessCacheEntry {
  totalFiles: number;
  gitSignature: string;
  expiresAt: number;
  result: GraphFreshnessResult;
}

const freshnessCache = new Map<string, FreshnessCacheEntry>();

export function clearGraphFreshnessCache(projectId?: string): void {
  if (!projectId) {
    freshnessCache.clear();
    return;
  }
  const prefix = `${projectId}\0`;
  for (const key of freshnessCache.keys()) {
    if (key.startsWith(prefix)) freshnessCache.delete(key);
  }
}

function resolveGitDir(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    const dotGit = join(current, ".git");
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      if (st.isFile()) {
        const raw = readFileSync(dotGit, "utf8");
        const match = raw.match(/^gitdir:\s*(.+)\s*$/m);
        if (match?.[1]) return resolve(current, match[1].trim());
      }
    } catch {
      // Not at this level
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function statMtimeMs(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return -1;
  }
}

function readGitStateMtimes(rootDirs: Array<{ rootId: string | null; dir: string }>): {
  hasGit: boolean;
  signature: string;
} {
  const gitDirs = new Set<string>();
  for (const rootDir of rootDirs) {
    const gitDir = resolveGitDir(rootDir.dir);
    if (gitDir) gitDirs.add(gitDir);
  }
  if (gitDirs.size === 0) return { hasGit: false, signature: "" };
  const parts = [...gitDirs].sort().map((gitDir) => {
    const indexMtime = statMtimeMs(join(gitDir, "index"));
    const headMtime = statMtimeMs(join(gitDir, "HEAD"));
    return `${gitDir}:${indexMtime}:${headMtime}`;
  });
  return { hasGit: true, signature: parts.join("|") };
}

export function checkGraphFreshness(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  rootDirs: Array<{ rootId: string | null; dir: string }>,
  options?: { ttlMs?: number },
): GraphFreshnessResult {
  return withDatabase(dbOrPath, (db) => {
    const totalFiles = (
      db.prepare("SELECT COUNT(*) AS c FROM files WHERE project_id = ?").get(projectId) as {
        c: number;
      }
    ).c;

    if (totalFiles === 0) {
      for (const rootDir of rootDirs) {
        if (hasAnyCodeFileBounded(resolve(rootDir.dir))) {
          return { stale: true, reason: "not_indexed", checked_files: 0 };
        }
      }
      return { stale: false, checked_files: 0 };
    }

    const gitState = readGitStateMtimes(rootDirs);
    const ttlMs = options?.ttlMs ?? (gitState.hasGit ? DEFAULT_GRAPH_FRESHNESS_TTL_MS : 0);
    const cacheKey = `${projectId}\0${rootDirs
      .map((r) => `${r.rootId ?? ""}:${resolve(r.dir)}`)
      .sort()
      .join("|")}`;

    if (ttlMs > 0) {
      const cached = freshnessCache.get(cacheKey);
      if (
        cached &&
        cached.totalFiles === totalFiles &&
        cached.gitSignature === gitState.signature &&
        Date.now() < cached.expiresAt
      ) {
        return cached.result;
      }
    }

    if (!isGraphParserCurrent(db, projectId)) {
      return { stale: true, reason: "parser_version", checked_files: 0 };
    }

    const rootById = new Map<string | null, { absDir: string; realDir: string }>();
    for (const rootDir of rootDirs) {
      const absDir = resolve(rootDir.dir);
      const realDir = safeRealpathSync(absDir);
      rootById.set(rootDir.rootId, { absDir, realDir });
    }

    type FreshnessRow = {
      id: number;
      root_id: string | null;
      path: string;
      mtime_ms: number | null;
    };

    let sampleRows: FreshnessRow[];
    if (totalFiles <= MAX_FRESHNESS_CHECK_FILES) {
      sampleRows = db
        .prepare(
          "SELECT id, root_id, path, mtime_ms FROM files WHERE project_id = ? ORDER BY id LIMIT ?",
        )
        .all(projectId, MAX_FRESHNESS_CHECK_FILES) as FreshnessRow[];
    } else {
      const half = Math.floor(MAX_FRESHNESS_CHECK_FILES / 2);
      const recentRows = db
        .prepare(
          "SELECT id, root_id, path, mtime_ms FROM files WHERE project_id = ? ORDER BY COALESCE(mtime_ms, 0) DESC, id ASC LIMIT ?",
        )
        .all(projectId, half) as FreshnessRow[];
      const spreadRows = db
        .prepare(
          "SELECT id, root_id, path, mtime_ms FROM files WHERE project_id = ? ORDER BY COALESCE(hash, ''), id ASC LIMIT ?",
        )
        .all(projectId, MAX_FRESHNESS_CHECK_FILES) as FreshnessRow[];
      const byId = new Map<number, FreshnessRow>();
      for (const row of recentRows) byId.set(row.id, row);
      for (const row of spreadRows) {
        if (byId.size >= MAX_FRESHNESS_CHECK_FILES) break;
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
      sampleRows = [...byId.values()];
    }

    let checked = 0;
    const modifiedFiles: string[] = [];
    for (const row of sampleRows) {
      const rootEntry = rootById.get(row.root_id);
      if (!rootEntry) continue;

      let relInRoot = row.path;
      if (row.root_id !== null && relInRoot.startsWith("@")) {
        const slashIdx = relInRoot.indexOf("/");
        if (slashIdx !== -1) relInRoot = relInRoot.slice(slashIdx + 1);
      }

      const candidate = resolve(rootEntry.absDir, relInRoot);
      if (!toRelInsideRoot(rootEntry.absDir, candidate)) continue;

      checked++;
      let diskMtimeMs: number;
      try {
        const lst = lstatSync(candidate);
        if (lst.isSymbolicLink() || !lst.isFile()) {
          return { stale: true, reason: "missing_files", checked_files: checked };
        }
        const realCandidate = realpathSync(candidate);
        if (!isWithinRoot(rootEntry.realDir, realCandidate)) {
          return { stale: true, reason: "missing_files", checked_files: checked };
        }
        diskMtimeMs = Math.floor(lst.mtimeMs);
      } catch {
        return { stale: true, reason: "missing_files", checked_files: checked };
      }

      if (row.mtime_ms === null || diskMtimeMs !== row.mtime_ms) {
        modifiedFiles.push(row.path);
        if (modifiedFiles.length > MICRO_REINDEX_MAX_FILES) {
          return { stale: true, reason: "modified_files", checked_files: checked };
        }
      }
    }

    if (modifiedFiles.length > 0) {
      return {
        stale: true,
        reason: "modified_files",
        checked_files: checked,
        modified_files: modifiedFiles,
      };
    }

    const result: GraphFreshnessResult = { stale: false, checked_files: checked };
    if (ttlMs > 0) {
      if (freshnessCache.size >= MAX_FRESHNESS_CACHE_ENTRIES) {
        const oldestKey = freshnessCache.keys().next().value;
        if (oldestKey !== undefined) freshnessCache.delete(oldestKey);
      }
      freshnessCache.set(cacheKey, {
        totalFiles,
        gitSignature: gitState.signature,
        expiresAt: Date.now() + ttlMs,
        result,
      });
    }
    return result;
  });
}

export type GraphFastPathState = {
  indexed_files: number;
  stale: boolean;
  reason?: string;
  modified_files?: string[];
};

export function getGraphIndexFastPathState(
  dbPath: string,
  projectId: string,
  rootDirs: Array<{ rootId: string | null; dir: string }>,
): GraphFastPathState {
  return withDatabase(dbPath, (db) => {
    const indexed_files = (
      db.prepare("SELECT COUNT(*) AS c FROM files WHERE project_id = ?").get(projectId) as {
        c: number;
      }
    ).c;

    const freshness = checkGraphFreshness(db, projectId, rootDirs);
    return {
      indexed_files,
      stale: freshness.stale,
      ...(freshness.reason ? { reason: freshness.reason } : {}),
      ...(freshness.modified_files ? { modified_files: freshness.modified_files } : {}),
    };
  });
}

export type MicroReindexResult = {
  applied: boolean;
  reindexed: number;
  counts: GraphIndexResult;
};

function splitPrefixedPath(
  path: string,
  rootId: string | null,
): { prefix: string; relInRoot: string } {
  if (rootId !== null && path.startsWith("@")) {
    const slashIdx = path.indexOf("/");
    if (slashIdx > 1) {
      return { prefix: path.slice(0, slashIdx), relInRoot: path.slice(slashIdx + 1) };
    }
  }
  return { prefix: "", relInRoot: path };
}

async function isMicroPathIgnoredOrUnsafe(
  realRoot: string,
  relInRoot: string,
  gitignoreCache: Map<string, GitignoreRule[]>,
): Promise<boolean> {
  const segments = relInRoot.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || seg.startsWith(".")) return true;
    if (i < segments.length - 1 && DEFAULT_SKIP_DIRS.has(seg)) return true;
  }

  let activeRules: GitignoreRule[] = [];
  let curRel = "";
  let curAbs = realRoot;
  for (let i = 0; i < segments.length; i++) {
    let dirRules = gitignoreCache.get(curRel);
    if (!dirRules) {
      const raw = await readBoundedUtf8File(
        join(curAbs, ".gitignore"),
        realRoot,
        MAX_MICRO_GITIGNORE_BYTES,
      );
      dirRules = raw !== null ? parseGitignore(raw, curRel) : [];
      gitignoreCache.set(curRel, dirRules);
    }
    if (dirRules.length > 0) {
      activeRules = [...activeRules, ...dirRules];
    }
    if (i < segments.length - 1) {
      const seg = segments[i];
      if (!seg) return true;
      curRel = curRel ? `${curRel}/${seg}` : seg;
      curAbs = join(curAbs, seg);
      try {
        const lst = await lstat(curAbs);
        if (lst.isSymbolicLink() || !lst.isDirectory()) return true;
      } catch {
        return true;
      }
    }
  }

  return isGitignored(relInRoot, false, activeRules);
}

export async function microReindexModifiedFiles(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  rootDirs: Array<{ rootId: string | null; dir: string }>,
  modifiedPaths?: readonly string[],
  options: Pick<GraphIndexOptions, "maxFileBytes"> = {},
): Promise<MicroReindexResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) {
    return withDatabase(dbOrPath, (db) => ({
      applied: false,
      reindexed: 0,
      counts: readGraphCounts(db, projectId),
    }));
  }

  return withDatabaseAsync(dbOrPath, async (db) => {
    const counts = readGraphCounts(db, projectId);
    if (counts.files === 0 || !isGraphParserCurrent(db, projectId)) {
      return { applied: false, reindexed: 0, counts };
    }

    clearGraphFreshnessCache(projectId);
    let targets: string[];
    if (modifiedPaths !== undefined) {
      targets = [...new Set(modifiedPaths.filter((p) => p.length > 0))];
    } else {
      const freshness = checkGraphFreshness(db, projectId, rootDirs, { ttlMs: 0 });
      if (!freshness.stale) {
        return { applied: true, reindexed: 0, counts };
      }
      if (freshness.reason !== "modified_files" || !freshness.modified_files?.length) {
        return { applied: false, reindexed: 0, counts };
      }
      targets = freshness.modified_files;
    }

    if (targets.length === 0) {
      return { applied: true, reindexed: 0, counts };
    }
    if (targets.length > MICRO_REINDEX_MAX_FILES) {
      return { applied: false, reindexed: 0, counts };
    }

    const existingRows = db
      .prepare("SELECT id, root_id, path, hash, mtime_ms FROM files WHERE project_id = ?")
      .all(projectId) as ExistingFileRow[];
    const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
    const idByPath = new Map(existingRows.map((row) => [row.path, row.id]));

    const knownFilesByRoot = new Map<string | null, Set<string>>();
    for (const row of existingRows) {
      const { relInRoot } = splitPrefixedPath(row.path, row.root_id);
      let rootKnown = knownFilesByRoot.get(row.root_id);
      if (!rootKnown) {
        rootKnown = new Set<string>();
        knownFilesByRoot.set(row.root_id, rootKnown);
      }
      rootKnown.add(relInRoot);
    }

    const rootMetaById = new Map<string | null, { absRoot: string; realRoot: string }>();
    for (const rootDir of rootDirs) {
      const absRoot = resolve(rootDir.dir);
      try {
        const lst = await lstat(absRoot);
        if (lst.isSymbolicLink() || !lst.isDirectory()) continue;
        const realRoot = await realpath(absRoot);
        rootMetaById.set(rootDir.rootId, { absRoot, realRoot });
      } catch {
        // Ignore unavailable root
      }
    }

    const gitignoreCacheByRoot = new Map<string, Map<string, GitignoreRule[]>>();
    const resolveImportsForEntry = createImportResolver(knownFilesByRoot);
    const mtimeOnlyUpdates: Array<{ id: number; mtimeMs: number }> = [];
    const modifiedFiles: Array<{
      id: number;
      hash: string;
      mtimeMs: number;
      symbols: Array<{ name: string; kind: string; line: number }>;
      imports: ResolvedEdgeTarget[];
    }> = [];

    for (const targetPath of targets) {
      const existing = existingByPath.get(targetPath);
      if (!existing) {
        return { applied: false, reindexed: 0, counts };
      }
      const rootMeta = rootMetaById.get(existing.root_id);
      if (!rootMeta) {
        return { applied: false, reindexed: 0, counts };
      }
      const { prefix, relInRoot } = splitPrefixedPath(existing.path, existing.root_id);
      const ext = extname(relInRoot).toLowerCase();
      if (!CODE_EXT.has(ext)) {
        return { applied: false, reindexed: 0, counts };
      }

      const candidate = resolve(rootMeta.absRoot, relInRoot);
      if (toRelInsideRoot(rootMeta.absRoot, candidate) !== relInRoot) {
        return { applied: false, reindexed: 0, counts };
      }

      let gitignoreCache = gitignoreCacheByRoot.get(rootMeta.realRoot);
      if (!gitignoreCache) {
        gitignoreCache = new Map<string, GitignoreRule[]>();
        gitignoreCacheByRoot.set(rootMeta.realRoot, gitignoreCache);
      }
      if (await isMicroPathIgnoredOrUnsafe(rootMeta.realRoot, relInRoot, gitignoreCache)) {
        return { applied: false, reindexed: 0, counts };
      }

      let mtimeMs: number;
      let realFile: string;
      try {
        const lst = await lstat(candidate);
        if (lst.isSymbolicLink() || !lst.isFile() || lst.size > maxFileBytes) {
          return { applied: false, reindexed: 0, counts };
        }
        realFile = await realpath(candidate);
        if (!isWithinRoot(rootMeta.realRoot, realFile)) {
          return { applied: false, reindexed: 0, counts };
        }
        mtimeMs = Math.floor(lst.mtimeMs);
      } catch {
        return { applied: false, reindexed: 0, counts };
      }

      const content = await readBoundedUtf8File(realFile, rootMeta.realRoot, maxFileBytes);
      if (content === null) {
        return { applied: false, reindexed: 0, counts };
      }

      const contentHash = hash(content);
      if (existing.hash === contentHash) {
        if (existing.mtime_ms !== mtimeMs) {
          mtimeOnlyUpdates.push({ id: existing.id, mtimeMs });
        }
        continue;
      }

      const symbols = parseSymbols(content, ext);
      const imports = resolveImportsForEntry(
        {
          rootId: existing.root_id,
          realRoot: rootMeta.realRoot,
          prefix,
          full: realFile,
          relInRoot,
          ext,
        },
        content,
      );
      modifiedFiles.push({ id: existing.id, hash: contentHash, mtimeMs, symbols, imports });
    }

    if (mtimeOnlyUpdates.length === 0 && modifiedFiles.length === 0) {
      return { applied: true, reindexed: 0, counts };
    }

    const useSavepoint = typeof dbOrPath !== "string";
    db.exec(useSavepoint ? "SAVEPOINT graph_micro_reindex" : "BEGIN IMMEDIATE");
    try {
      const updateMtime = db.prepare("UPDATE files SET mtime_ms = ? WHERE id = ?");
      const updateFile = db.prepare("UPDATE files SET hash = ?, mtime_ms = ? WHERE id = ?");
      const deleteSymbolsForFile = db.prepare(
        "DELETE FROM symbols WHERE project_id = ? AND file_id = ?",
      );
      const deleteEdgesForFile = db.prepare(
        "DELETE FROM edges WHERE project_id = ? AND from_file_id = ?",
      );
      const insertSymbol = db.prepare(
        "INSERT INTO symbols (project_id, file_id, name, kind, line) VALUES (?, ?, ?, ?, ?)",
      );
      const insertEdge = db.prepare(
        "INSERT INTO edges (project_id, kind, from_file_id, to_file_id, label) VALUES (?, ?, ?, ?, ?)",
      );

      for (const item of mtimeOnlyUpdates) {
        updateMtime.run(item.mtimeMs, item.id);
      }

      for (const item of modifiedFiles) {
        updateFile.run(item.hash, item.mtimeMs, item.id);
        deleteSymbolsForFile.run(projectId, item.id);
        deleteEdgesForFile.run(projectId, item.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, item.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const edge of item.imports) {
          const toId = idByPath.get(edge.to);
          insertEdge.run(projectId, edge.kind, item.id, toId ?? null, edge.to);
        }
      }

      db.exec(useSavepoint ? "RELEASE SAVEPOINT graph_micro_reindex" : "COMMIT");
    } catch (error) {
      db.exec(
        useSavepoint
          ? "ROLLBACK TO SAVEPOINT graph_micro_reindex; RELEASE SAVEPOINT graph_micro_reindex"
          : "ROLLBACK",
      );
      throw error;
    }

    return {
      applied: true,
      reindexed: mtimeOnlyUpdates.length + modifiedFiles.length,
      counts: readGraphCounts(db, projectId),
    };
  });
}
