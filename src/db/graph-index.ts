import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { openDatabaseAt } from "./open.js";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".catenext",
  "dist",
  "build",
  ".turbo",
  "coverage",
]);
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
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

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".catenext") {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
      continue;
    }
    const ext = entry.name.includes(".") ? `.${entry.name.split(".").pop()}` : "";
    if (CODE_EXT.has(ext)) out.push(full);
  }
}

function parseImports(content: string): string[] {
  const hits: string[] = [];
  const re =
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(re)) {
    const spec = match[1] ?? match[2];
    if (spec?.startsWith(".")) hits.push(spec);
  }
  return [...new Set(hits)];
}

function parseSymbols(content: string): Array<{ name: string; kind: string; line: number }> {
  const symbols: Array<{ name: string; kind: string; line: number }> = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<[RegExp, string]> = [
    [/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w$]*)/, "function"],
    [/^(?:export\s+)?class\s+([A-Za-z_][\w$]*)/, "class"],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w$]*)\s*=/, "variable"],
    [/^def\s+([A-Za-z_][\w$]*)\s*\(/, "function"],
    [/^class\s+([A-Za-z_][\w$]*)\s*[:(]/, "class"],
  ];
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

function resolveImport(fromFile: string, spec: string, root: string): string | null {
  const base = join(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  for (const candidate of candidates) {
    try {
      // sync existence via relative path only; indexer checked files set separately
      if (candidate.startsWith(root)) return relative(root, candidate).replaceAll("\\", "/");
    } catch {
      /* ignore */
    }
  }
  return relative(root, base).replaceAll("\\", "/");
}

export type GraphIndexResult = {
  files: number;
  symbols: number;
  edges: number;
};

export async function indexProjectGraph(
  dbPath: string,
  projectId: string,
  root: string,
): Promise<GraphIndexResult> {
  const db = openDatabaseAt(dbPath);
  try {
    db.prepare("DELETE FROM edges WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM symbols WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM files WHERE project_id = ?").run(projectId);

    const files: string[] = [];
    await walk(root, root, files);
    const insertFile = db.prepare(
      "INSERT INTO files (project_id, path, hash, mtime_ms) VALUES (?, ?, ?, ?) RETURNING id",
    );
    const insertSymbol = db.prepare(
      "INSERT INTO symbols (project_id, file_id, name, kind, line) VALUES (?, ?, ?, ?, ?)",
    );
    const insertEdge = db.prepare(
      "INSERT INTO edges (project_id, kind, from_file_id, to_file_id, label) VALUES (?, ?, ?, ?, ?)",
    );

    const idByPath = new Map<string, number>();
    let symbolCount = 0;
    let edgeCount = 0;
    const pendingImports: Array<{ from: string; to: string }> = [];

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const full of files) {
        const rel = relative(root, full).replaceAll("\\", "/");
        const content = await readFile(full, "utf8");
        const st = await stat(full);
        const row = insertFile.get(projectId, rel, hash(content), Math.floor(st.mtimeMs)) as {
          id: number;
        };
        idByPath.set(rel, row.id);
        for (const symbol of parseSymbols(content)) {
          insertSymbol.run(projectId, row.id, symbol.name, symbol.kind, symbol.line);
          symbolCount += 1;
        }
        for (const spec of parseImports(content)) {
          const to = resolveImport(full, spec, root);
          if (to) pendingImports.push({ from: rel, to });
        }
      }
      for (const edge of pendingImports) {
        const fromId = idByPath.get(edge.from);
        const toId = idByPath.get(edge.to);
        if (fromId === undefined) continue;
        insertEdge.run(projectId, "imports", fromId, toId ?? null, edge.to);
        edgeCount += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return { files: idByPath.size, symbols: symbolCount, edges: edgeCount };
  } finally {
    db.close();
  }
}

export function graphNeighbors(
  dbPath: string,
  projectId: string,
  path: string,
  limit: number,
): Array<{ kind: string; from: string; to: string; label?: string }> {
  const db = openDatabaseAt(dbPath);
  try {
    const file = db
      .prepare("SELECT id, path FROM files WHERE project_id = ? AND path = ?")
      .get(projectId, path) as { id: number; path: string } | undefined;
    if (!file) return [];
    const rows = db
      .prepare(
        `SELECT e.kind, f1.path AS from_path, COALESCE(f2.path, e.label) AS to_path, e.label
         FROM edges e
         JOIN files f1 ON f1.id = e.from_file_id
         LEFT JOIN files f2 ON f2.id = e.to_file_id
         WHERE e.project_id = ? AND (e.from_file_id = ? OR e.to_file_id = ?)
         LIMIT ?`,
      )
      .all(projectId, file.id, file.id, limit) as Array<{
      kind: string;
      from_path: string;
      to_path: string;
      label: string | null;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      from: row.from_path,
      to: row.to_path,
      ...(row.label ? { label: row.label } : {}),
    }));
  } finally {
    db.close();
  }
}

export function symbolSearch(
  dbPath: string,
  projectId: string,
  query: string,
  limit: number,
): Array<{ name: string; kind: string; path: string; line?: number }> {
  const db = openDatabaseAt(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT s.name, s.kind, s.line, f.path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.project_id = ? AND s.name LIKE ? ESCAPE '\\'
         ORDER BY s.name
         LIMIT ?`,
      )
      .all(projectId, `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, limit) as Array<{
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
  } finally {
    db.close();
  }
}
