import type { DatabaseSync } from "node:sqlite";
import {
  GraphImpactInput,
  type GraphImpactInputType,
  type GraphImpactOutputType,
  GraphSummaryInput,
  type GraphSummaryInputType,
  type GraphSummaryOutputType,
} from "@catenext/shared";
import { checkGraphFreshness } from "./graph-index.js";
import { checkpointWalAndClose, openDatabaseAt } from "./open.js";

const MAX_GROUP_EDGES = 30;
const MAX_KEY_SYMBOLS = 6;
const MAX_MERMAID_NODES = 25;
const TEST_FILE_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[^/]+$/i;

export type GraphRootDir = {
  rootId: string | null;
  dir: string;
};

export function isTestFilePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return TEST_FILE_RE.test(normalized);
}

function freshnessFields(
  db: DatabaseSync,
  projectId: string,
  rootDirs?: GraphRootDir[],
): { stale?: boolean; stale_reason?: string } {
  if (!rootDirs) return {};
  const freshness = checkGraphFreshness(db, projectId, rootDirs);
  if (!freshness.stale) return {};
  return {
    stale: true,
    ...(freshness.reason ? { stale_reason: freshness.reason } : {}),
  };
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

export function groupForPath(filePath: string, depth: number): string {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return "(root)";
  const dirs = parts.slice(0, -1);
  return dirs.slice(0, depth).join("/") || "(root)";
}

function sanitizeMermaidLabel(label: string): string {
  return (
    label
      .replace(/["`<>[\]{}\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "module"
  );
}

function renderMermaid(
  groups: GraphSummaryOutputType["groups"],
  groupEdges: GraphSummaryOutputType["group_edges"],
): string {
  const lines = ["flowchart LR"];
  const edgeParticipants = new Set<string>();
  for (const edge of groupEdges) {
    edgeParticipants.add(edge.from);
    edgeParticipants.add(edge.to);
  }
  const selected = [
    ...groups.filter((g) => edgeParticipants.has(g.group)),
    ...groups.filter((g) => !edgeParticipants.has(g.group)),
  ].slice(0, MAX_MERMAID_NODES);

  const nodeIdByGroup = new Map<string, string>();
  for (let i = 0; i < selected.length; i++) {
    const group = selected[i];
    if (!group) continue;
    const id = `g${i}`;
    nodeIdByGroup.set(group.group, id);
    const unit = group.files === 1 ? "file" : "files";
    const label = sanitizeMermaidLabel(`${group.group} (${group.files} ${unit})`);
    lines.push(`  ${id}["${label}"]`);
  }

  for (const edge of groupEdges) {
    const fromId = nodeIdByGroup.get(edge.from);
    const toId = nodeIdByGroup.get(edge.to);
    if (fromId && toId) {
      lines.push(`  ${fromId} -->|${edge.count}| ${toId}`);
    }
  }

  return lines.join("\n");
}

function normalizePrefix(raw: string | undefined): string {
  if (!raw) return "";
  const normalized = raw
    .replaceAll("\\", "/")
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
  return normalized === "." ? "" : normalized;
}

export function summarizeProjectGraph(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  opts: Partial<GraphSummaryInputType> = {},
  rootDirs?: GraphRootDir[],
): GraphSummaryOutputType {
  const parsed = GraphSummaryInput.parse(opts);
  const prefix = normalizePrefix(parsed.prefix);
  return withDatabase(dbOrPath, (db) => {
    const freshness = freshnessFields(db, projectId, rootDirs);
    const fileRows = db
      .prepare("SELECT id, path FROM files WHERE project_id = ?")
      .all(projectId) as Array<{ id: number; path: string }>;

    if (fileRows.length === 0) {
      return {
        indexed: false,
        ...freshness,
        totals: { files: 0, symbols: 0, edges: 0 },
        groups: [],
        group_edges: [],
        hubs: [],
      };
    }

    const testFilteredRows = parsed.include_tests
      ? fileRows
      : fileRows.filter((file) => !isTestFilePath(file.path));
    const activeFileRows = prefix
      ? testFilteredRows.filter(
          (file) => file.path === prefix || file.path.startsWith(`${prefix}/`),
        )
      : testFilteredRows;

    if (activeFileRows.length === 0) {
      return {
        indexed: true,
        ...freshness,
        totals: { files: 0, symbols: 0, edges: 0 },
        groups: [],
        group_edges: [],
        hubs: [],
        ...(parsed.include_mermaid ? { mermaid: renderMermaid([], []) } : {}),
      };
    }

    const symbolRows = db
      .prepare(
        `SELECT file_id, name
         FROM symbols
         WHERE project_id = ?
         ORDER BY file_id, COALESCE(line, 2147483647), id`,
      )
      .all(projectId) as Array<{ file_id: number; name: string }>;

    const edgeRows = db
      .prepare("SELECT from_file_id, to_file_id FROM edges WHERE project_id = ?")
      .all(projectId) as Array<{ from_file_id: number | null; to_file_id: number | null }>;

    const filesById = new Map<
      number,
      {
        path: string;
        group: string;
        in_edges: number;
        out_edges: number;
        symbol_count: number;
        key_symbols: string[];
      }
    >();
    const groupStats = new Map<
      string,
      {
        group: string;
        files: number;
        symbols: number;
        edges_in: number;
        edges_out: number;
      }
    >();

    for (const file of activeFileRows) {
      const group = groupForPath(file.path, parsed.depth);
      filesById.set(file.id, {
        path: file.path,
        group,
        in_edges: 0,
        out_edges: 0,
        symbol_count: 0,
        key_symbols: [],
      });
      const existingGroup = groupStats.get(group);
      if (existingGroup) {
        existingGroup.files += 1;
      } else {
        groupStats.set(group, { group, files: 1, symbols: 0, edges_in: 0, edges_out: 0 });
      }
    }

    let filteredSymbols = 0;
    for (const sym of symbolRows) {
      const file = filesById.get(sym.file_id);
      if (!file) continue;
      filteredSymbols += 1;
      file.symbol_count += 1;
      if (file.key_symbols.length < MAX_KEY_SYMBOLS && !file.key_symbols.includes(sym.name)) {
        file.key_symbols.push(sym.name);
      }
      const group = groupStats.get(file.group);
      if (group) group.symbols += 1;
    }

    let filteredEdges = 0;
    const groupEdgeCounts = new Map<string, { from: string; to: string; count: number }>();
    for (const edge of edgeRows) {
      if (edge.from_file_id === null || edge.to_file_id === null) continue;
      const fromFile = filesById.get(edge.from_file_id);
      const toFile = filesById.get(edge.to_file_id);
      if (!fromFile || !toFile) continue;
      filteredEdges += 1;

      if (edge.from_file_id !== edge.to_file_id) {
        fromFile.out_edges += 1;
        toFile.in_edges += 1;
      }

      if (fromFile.group !== toFile.group) {
        const fromGroup = groupStats.get(fromFile.group);
        const toGroup = groupStats.get(toFile.group);
        if (fromGroup) fromGroup.edges_out += 1;
        if (toGroup) toGroup.edges_in += 1;

        const key = `${fromFile.group}\0${toFile.group}`;
        const existingEdge = groupEdgeCounts.get(key);
        if (existingEdge) {
          existingEdge.count += 1;
        } else {
          groupEdgeCounts.set(key, { from: fromFile.group, to: toFile.group, count: 1 });
        }
      }
    }

    const groups = [...groupStats.values()].sort(
      (a, b) =>
        b.edges_in + b.edges_out - (a.edges_in + a.edges_out) ||
        b.files - a.files ||
        a.group.localeCompare(b.group),
    );

    const group_edges = [...groupEdgeCounts.values()]
      .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      .slice(0, MAX_GROUP_EDGES);

    const hubs = [...filesById.values()]
      .sort(
        (a, b) =>
          b.in_edges + b.out_edges - (a.in_edges + a.out_edges) ||
          b.symbol_count - a.symbol_count ||
          a.path.localeCompare(b.path),
      )
      .slice(0, parsed.max_hubs);

    return {
      indexed: true,
      ...freshness,
      totals: {
        files: activeFileRows.length,
        symbols: filteredSymbols,
        edges: filteredEdges,
      },
      groups,
      group_edges,
      hubs,
      ...(parsed.include_mermaid ? { mermaid: renderMermaid(groups, group_edges) } : {}),
    };
  });
}

export function analyzeGraphImpact(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  opts: Partial<GraphImpactInputType> & { path: string },
  rootDirs?: GraphRootDir[],
): GraphImpactOutputType {
  const parsed = GraphImpactInput.parse(opts);
  const rawPath = parsed.path.replaceAll("\\", "/").trim();
  const strippedPath = rawPath.replace(/^\.\//, "");

  return withDatabase(dbOrPath, (db) => {
    const freshness = freshnessFields(db, projectId, rootDirs);
    const fileRows = db
      .prepare("SELECT id, path FROM files WHERE project_id = ?")
      .all(projectId) as Array<{ id: number; path: string }>;

    if (fileRows.length === 0) {
      return {
        target: strippedPath || rawPath,
        indexed: false,
        ...freshness,
        total_affected: 0,
        truncated: false,
        impacted: [],
      };
    }

    const fileById = new Map<number, { id: number; path: string }>();
    const fileByPath = new Map<string, { id: number; path: string }>();
    for (const row of fileRows) {
      fileById.set(row.id, row);
      fileByPath.set(row.path, row);
    }

    const targetFile =
      fileByPath.get(rawPath) ??
      (strippedPath !== rawPath ? fileByPath.get(strippedPath) : undefined);

    if (!targetFile) {
      return {
        target: strippedPath || rawPath,
        indexed: true,
        ...freshness,
        total_affected: 0,
        truncated: false,
        impacted: [],
      };
    }

    const symbolCountRows = db
      .prepare("SELECT file_id, COUNT(*) AS c FROM symbols WHERE project_id = ? GROUP BY file_id")
      .all(projectId) as Array<{ file_id: number; c: number }>;
    const symbolCountByFileId = new Map<number, number>(
      symbolCountRows.map((row) => [row.file_id, row.c]),
    );

    const edgeRows = db
      .prepare("SELECT from_file_id, to_file_id FROM edges WHERE project_id = ?")
      .all(projectId) as Array<{ from_file_id: number | null; to_file_id: number | null }>;

    const isExcluded = (filePath: string): boolean =>
      !parsed.include_tests && isTestFilePath(filePath);

    const inEdgesCount = new Map<number, number>();
    const reverseAdj = new Map<number, Set<number>>();
    for (const edge of edgeRows) {
      if (edge.from_file_id === null || edge.to_file_id === null) continue;
      if (edge.from_file_id === edge.to_file_id) continue;
      const fromFile = fileById.get(edge.from_file_id);
      const toFile = fileById.get(edge.to_file_id);
      if (!fromFile || !toFile) continue;
      if (isExcluded(fromFile.path)) continue;

      let dependents = reverseAdj.get(edge.to_file_id);
      if (!dependents) {
        dependents = new Set<number>();
        reverseAdj.set(edge.to_file_id, dependents);
      }
      if (!dependents.has(edge.from_file_id)) {
        dependents.add(edge.from_file_id);
        if (!isExcluded(toFile.path)) {
          inEdgesCount.set(edge.to_file_id, (inEdgesCount.get(edge.to_file_id) ?? 0) + 1);
        }
      }
    }

    const compareFileIds = (aId: number, bId: number): number => {
      const inDiff = (inEdgesCount.get(bId) ?? 0) - (inEdgesCount.get(aId) ?? 0);
      if (inDiff !== 0) return inDiff;
      const aPath = fileById.get(aId)?.path ?? "";
      const bPath = fileById.get(bId)?.path ?? "";
      return aPath.localeCompare(bPath);
    };

    const visited = new Set<number>([targetFile.id]);
    let frontier: number[] = [targetFile.id];
    const allHits: Array<{
      path: string;
      distance: number;
      kind: "direct" | "transitive";
      via?: string;
      symbols_count: number;
      in_edges: number;
    }> = [];

    for (let distance = 1; distance <= parsed.depth && frontier.length > 0; distance++) {
      const orderedFrontier = [...frontier].sort(compareFileIds);
      const nextFrontier: number[] = [];
      for (const nodeId of orderedFrontier) {
        const parentPath = fileById.get(nodeId)?.path;
        if (!parentPath) continue;
        const dependents = [...(reverseAdj.get(nodeId) ?? [])].sort(compareFileIds);
        for (const depId of dependents) {
          if (visited.has(depId)) continue;
          visited.add(depId);
          const depFile = fileById.get(depId);
          if (!depFile || isExcluded(depFile.path)) continue;
          nextFrontier.push(depId);
          allHits.push({
            path: depFile.path,
            distance,
            kind: distance === 1 ? "direct" : "transitive",
            ...(distance > 1 ? { via: parentPath } : {}),
            symbols_count: symbolCountByFileId.get(depId) ?? 0,
            in_edges: inEdgesCount.get(depId) ?? 0,
          });
        }
      }
      frontier = nextFrontier;
    }

    allHits.sort(
      (a, b) => a.distance - b.distance || b.in_edges - a.in_edges || a.path.localeCompare(b.path),
    );

    const total_affected = allHits.length;
    const impacted = allHits.slice(0, parsed.limit).map(({ in_edges: _inEdges, ...hit }) => hit);

    return {
      target: targetFile.path,
      indexed: true,
      ...freshness,
      total_affected,
      truncated: total_affected > impacted.length,
      impacted,
    };
  });
}

function escapeCell(text: string): string {
  return text
    .replaceAll("|", "\\|")
    .replaceAll("`", "'")
    .replace(/[\r\n]+/g, " ");
}

export function renderArchitectureMarkdown(
  summary: GraphSummaryOutputType,
  opts: { title?: string; depth?: number; includeTests?: boolean; prefix?: string } = {},
): string {
  const title = opts.title ?? "Project architecture";
  const lines: string[] = [`# ${title}`, ""];

  if (!summary.indexed) {
    lines.push(
      "Code graph is not indexed yet. Run `catenext index` to build the local SQLite code graph.",
    );
    return `${lines.join("\n")}\n`;
  }

  const normalizedPrefix = normalizePrefix(opts.prefix);
  const scopeNotes: string[] = [];
  if (opts.depth !== undefined) scopeNotes.push(`depth=${opts.depth}`);
  if (normalizedPrefix) scopeNotes.push(`prefix=${escapeCell(normalizedPrefix)}`);
  const depthNote = scopeNotes.length > 0 ? ` (${scopeNotes.join(", ")})` : "";
  lines.push(
    `Auto-generated from local SQLite code graph${depthNote}: **${summary.totals.files}** files, **${summary.totals.symbols}** symbols, **${summary.totals.edges}** import edges across **${summary.groups.length}** module groups.`,
  );
  if (opts.includeTests === false) {
    lines.push("", "_Test files excluded (`include_tests=false`)._");
  }
  if (summary.stale) {
    const reason = summary.stale_reason ? ` (${summary.stale_reason})` : "";
    lines.push(
      "",
      `> Warning: local code graph index is stale${reason}. Run \`catenext index\` to refresh.`,
    );
  }

  if (summary.mermaid) {
    lines.push("", "## Module Dependency Graph", "", "```mermaid", summary.mermaid, "```");
  }

  if (summary.groups.length > 0) {
    lines.push(
      "",
      "## Module Groups",
      "",
      "| Group | Files | Symbols | Edges In | Edges Out |",
      "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const g of summary.groups) {
      lines.push(
        `| \`${escapeCell(g.group)}\` | ${g.files} | ${g.symbols} | ${g.edges_in} | ${g.edges_out} |`,
      );
    }
  }

  if (summary.group_edges.length > 0) {
    lines.push(
      "",
      "## Key Dependency Flows",
      "",
      "| From | To | Imports |",
      "| --- | --- | ---: |",
    );
    for (const edge of summary.group_edges) {
      lines.push(`| \`${escapeCell(edge.from)}\` | \`${escapeCell(edge.to)}\` | ${edge.count} |`);
    }
  }

  if (summary.hubs.length > 0) {
    lines.push(
      "",
      "## Architectural Hubs",
      "",
      "| File | Group | In | Out | Symbols | Key Symbols |",
      "| --- | --- | ---: | ---: | ---: | --- |",
    );
    for (const hub of summary.hubs) {
      const syms = hub.key_symbols.length
        ? hub.key_symbols.map((s) => `\`${escapeCell(s)}\``).join(", ")
        : "-";
      lines.push(
        `| \`${escapeCell(hub.path)}\` | \`${escapeCell(hub.group)}\` | ${hub.in_edges} | ${hub.out_edges} | ${hub.symbol_count} | ${syms} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderImpactMarkdown(impact: GraphImpactOutputType): string {
  const lines: string[] = [`# Impact analysis: \`${escapeCell(impact.target)}\``, ""];

  if (!impact.indexed) {
    lines.push(
      "Code graph is not indexed yet. Run `catenext index` to build the local SQLite code graph.",
    );
    return `${lines.join("\n")}\n`;
  }

  if (impact.stale) {
    const reason = impact.stale_reason ? ` (${impact.stale_reason})` : "";
    lines.push(
      `> Warning: local code graph index is stale${reason}. Run \`catenext index\` to refresh.`,
      "",
    );
  }

  const shownNote = impact.truncated ? ` (showing top ${impact.impacted.length})` : "";
  lines.push(`Affected files: **${impact.total_affected}**${shownNote}.`);

  if (impact.impacted.length === 0) {
    lines.push("", "No reverse dependents found.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("", "| File | Distance | Kind | Via | Symbols |", "| --- | ---: | --- | --- | ---: |");
  for (const hit of impact.impacted) {
    const via = hit.via ? `\`${escapeCell(hit.via)}\`` : "-";
    lines.push(
      `| \`${escapeCell(hit.path)}\` | ${hit.distance} | ${hit.kind} | ${via} | ${hit.symbols_count ?? 0} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}
