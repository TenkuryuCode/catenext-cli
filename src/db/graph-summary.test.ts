import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CatenextConfigSchema, GraphSummaryOutput } from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalService } from "../local-service.js";
import { indexProjectGraph } from "./graph-index.js";
import {
  groupForPath,
  renderArchitectureMarkdown,
  summarizeProjectGraph,
} from "./graph-summary.js";
import { openDatabaseAt } from "./open.js";

let root: string;
let dbPath: string;
let projectId: string;

function ensureProject(db: DatabaseSync, id: string): void {
  db.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)").run(
    id,
    "2026-01-01T00:00:00.000Z",
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-graph-summary-"));
  dbPath = join(root, "state.sqlite");
  projectId = randomUUID();
  const db = openDatabaseAt(dbPath);
  try {
    ensureProject(db, projectId);
  } finally {
    db.close();
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("groupForPath", () => {
  it("maps root-level files to (root) and groups nested paths across depths 1, 2, 3", () => {
    expect(groupForPath("index.ts", 1)).toBe("(root)");
    expect(groupForPath("/README.md", 2)).toBe("(root)");
    expect(groupForPath("", 2)).toBe("(root)");

    const nested = "apps/cli/src/db/graph-summary.ts";
    expect(groupForPath(nested, 1)).toBe("apps");
    expect(groupForPath(nested, 2)).toBe("apps/cli");
    expect(groupForPath(nested, 3)).toBe("apps/cli/src");

    expect(groupForPath("src\\local-service.ts", 2)).toBe("src");
    expect(groupForPath("apps\\cli\\src\\index.ts", 3)).toBe("apps/cli/src");
  });
});

describe("summarizeProjectGraph", () => {
  it("returns indexed: false with zero totals and omits mermaid on empty DB", () => {
    const summary = summarizeProjectGraph(dbPath, projectId);
    expect(summary).toEqual({
      indexed: false,
      totals: { files: 0, symbols: 0, edges: 0 },
      groups: [],
      group_edges: [],
      hubs: [],
    });
    expect("mermaid" in summary).toBe(false);
    expect(GraphSummaryOutput.parse(summary)).toEqual(summary);
  });

  it("summarizes groups, group_edges, hub ranking, key_symbols cap, and mermaid toggle", async () => {
    await mkdir(join(root, "apps/api/src"), { recursive: true });
    await mkdir(join(root, "apps/web/src"), { recursive: true });
    await mkdir(join(root, "packages/shared/src"), { recursive: true });

    await writeFile(
      join(root, "packages/shared/src/types.ts"),
      [
        "export interface Sym1 {}",
        "export interface Sym2 {}",
        "export interface Sym3 {}",
        "export interface Sym4 {}",
        "export interface Sym5 {}",
        "export interface Sym6 {}",
        "export interface Sym7 {}",
        "export interface Sym8 {}",
      ].join("\n"),
    );
    await writeFile(
      join(root, "apps/api/src/db.ts"),
      [
        `import type { Sym1 } from "../../../packages/shared/src/types.js";`,
        "export function queryDb(x: Sym1) { return x; }",
      ].join("\n"),
    );
    await writeFile(
      join(root, "apps/api/src/routes.ts"),
      [
        `import { queryDb } from "./db.js";`,
        `import type { Sym2 } from "../../../packages/shared/src/types.js";`,
        "export function registerRoutes(s: Sym2) { return queryDb(s); }",
      ].join("\n"),
    );
    await writeFile(
      join(root, "apps/web/src/app.ts"),
      [
        `import type { Sym3 } from "../../../packages/shared/src/types.js";`,
        "export function renderApp(s: Sym3) { return s; }",
      ].join("\n"),
    );

    const indexed = await indexProjectGraph(dbPath, projectId, root);
    expect(indexed).toEqual({ files: 4, symbols: 11, edges: 4 });

    const withoutMermaid = summarizeProjectGraph(dbPath, projectId, {
      depth: 2,
      max_hubs: 2,
      include_mermaid: false,
    });
    expect(withoutMermaid.indexed).toBe(true);
    expect(withoutMermaid.totals).toEqual({ files: 4, symbols: 11, edges: 4 });
    expect("mermaid" in withoutMermaid).toBe(false);
    expect(withoutMermaid.hubs).toHaveLength(2);

    const full = summarizeProjectGraph(dbPath, projectId, {
      depth: 2,
      max_hubs: 12,
      include_mermaid: true,
    });
    expect(GraphSummaryOutput.parse(full)).toEqual(full);

    expect(full.groups).toEqual([
      { group: "packages/shared", files: 1, symbols: 8, edges_in: 3, edges_out: 0 },
      { group: "apps/api", files: 2, symbols: 2, edges_in: 0, edges_out: 2 },
      { group: "apps/web", files: 1, symbols: 1, edges_in: 0, edges_out: 1 },
    ]);

    expect(full.group_edges).toEqual([
      { from: "apps/api", to: "packages/shared", count: 2 },
      { from: "apps/web", to: "packages/shared", count: 1 },
    ]);

    // Ranked by in_edges + out_edges desc, then symbol_count desc, then path asc
    expect(full.hubs.map((h) => h.path)).toEqual([
      "packages/shared/src/types.ts",
      "apps/api/src/db.ts",
      "apps/api/src/routes.ts",
      "apps/web/src/app.ts",
    ]);
    expect(full.hubs[0]).toEqual({
      path: "packages/shared/src/types.ts",
      group: "packages/shared",
      in_edges: 3,
      out_edges: 0,
      symbol_count: 8,
      key_symbols: ["Sym1", "Sym2", "Sym3", "Sym4", "Sym5", "Sym6"],
    });
    expect(full.hubs[0]?.key_symbols.length).toBeLessThanOrEqual(6);
    expect(full.hubs[1]).toMatchObject({ in_edges: 1, out_edges: 1, symbol_count: 1 });
    expect(full.hubs[2]).toMatchObject({ in_edges: 0, out_edges: 2, symbol_count: 1 });
    expect(full.hubs[3]).toMatchObject({ in_edges: 0, out_edges: 1, symbol_count: 1 });

    expect(full.mermaid).toBeDefined();
    expect(full.mermaid?.startsWith("flowchart LR\n")).toBe(true);
    expect(full.mermaid).toContain('g0["packages/shared (1 file)"]');
    expect(full.mermaid).toContain('g1["apps/api (2 files)"]');
    expect(full.mermaid).toContain("g1 -->|2| g0");
    expect(full.mermaid).toContain("g2 -->|1| g0");
  });

  it("sanitizes unsafe characters in mermaid node labels", () => {
    const db = openDatabaseAt(dbPath);
    try {
      db.prepare("INSERT INTO files (project_id, path, hash) VALUES (?, ?, ?)").run(
        projectId,
        'apps/[web]<admin>/"edge"`case`/index.ts',
        "h1",
      );
      db.prepare("INSERT INTO files (project_id, path, hash) VALUES (?, ?, ?)").run(
        projectId,
        "core/{utils}/helper.ts",
        "h2",
      );
      const summary = summarizeProjectGraph(db, projectId, {
        depth: 2,
        include_mermaid: true,
      });
      expect(summary.mermaid).toBeDefined();
      const nodeLines = (summary.mermaid ?? "")
        .split("\n")
        .filter((line) => /^\s*g\d+\["/.test(line));
      expect(nodeLines).toHaveLength(2);
      for (const line of nodeLines) {
        const inner = line.replace(/^\s*g\d+\["/, "").replace(/"\]$/, "");
        expect(inner).not.toMatch(/["`<>[\]{}\r\n]/);
      }
    } finally {
      db.close();
    }
  });

  it("executes cleanly through LocalService.callTool('graph_summary', ...)", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/main.ts"), `import "./util";\nexport function run() {}\n`);
    await writeFile(join(root, "src/util.ts"), "export const answer = 42;\n");

    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: projectId,
      project_name: "SummaryServiceTest",
      repo_name: "catenext",
      state_file: "state.sqlite",
    });
    const service = new LocalService(root, config);
    await service.callTool("session_brief", {});
    await indexProjectGraph(service.stateFile, projectId, root);

    const defaultOut = await service.callTool("graph_summary", {});
    expect(defaultOut.indexed).toBe(true);
    expect(defaultOut.totals).toEqual({ files: 2, symbols: 2, edges: 1 });
    expect(defaultOut.mermaid).toContain("flowchart LR");

    const customOut = await service.callTool("graph_summary", {
      depth: 1,
      max_hubs: 1,
      include_mermaid: false,
    });
    expect(customOut.hubs).toHaveLength(1);
    expect(customOut.mermaid).toBeUndefined();
  });

  it("checkpoints WAL and cleans up -wal/-shm sidecars on standalone path call", () => {
    const db = openDatabaseAt(dbPath);
    db.prepare("INSERT INTO files (project_id, path, hash) VALUES (?, ?, ?)").run(
      projectId,
      "src/wal-check.ts",
      "h-wal",
    );
    db.close();

    const summary = summarizeProjectGraph(dbPath, projectId);
    expect(summary.indexed).toBe(true);
    expect(summary.totals.files).toBe(1);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe("renderArchitectureMarkdown", () => {
  it("renders unindexed notice when graph is empty", () => {
    const empty = summarizeProjectGraph(dbPath, projectId);
    const md = renderArchitectureMarkdown(empty);
    expect(md).toContain("# Project architecture");
    expect(md).toContain("Code graph is not indexed yet. Run `catenext index`");
    expect(md).not.toContain("```mermaid");
  });

  it("renders headings, totals, mermaid fence, and summary tables for indexed graph", async () => {
    await mkdir(join(root, "src/core"), { recursive: true });
    await mkdir(join(root, "src/api"), { recursive: true });
    await writeFile(join(root, "src/core/store.ts"), "export class Store {}\n");
    await writeFile(
      join(root, "src/api/handler.ts"),
      `import { Store } from "../core/store.js";\nexport function handle(s: Store) { return s; }\n`,
    );

    await indexProjectGraph(dbPath, projectId, root);
    const summary = summarizeProjectGraph(dbPath, projectId, {
      depth: 2,
      include_mermaid: true,
    });
    const md = renderArchitectureMarkdown(summary, { title: "Custom Arch", depth: 2 });

    expect(md).toContain("# Custom Arch");
    expect(md).toContain(
      "Auto-generated from local SQLite code graph (depth=2): **2** files, **2** symbols, **1** import edges across **2** module groups.",
    );
    expect(md).toContain("## Module Dependency Graph");
    expect(md).toContain("```mermaid\nflowchart LR");
    expect(md).toContain("## Module Groups");
    expect(md).toContain("| Group | Files | Symbols | Edges In | Edges Out |");
    expect(md).toContain("| `src/core` | 1 | 1 | 1 | 0 |");
    expect(md).toContain("## Key Dependency Flows");
    expect(md).toContain("| From | To | Imports |");
    expect(md).toContain("| `src/api` | `src/core` | 1 |");
    expect(md).toContain("## Architectural Hubs");
    expect(md).toContain("| File | Group | In | Out | Symbols | Key Symbols |");
    expect(md).toContain("`src/core/store.ts`");
    expect(md).toContain("`Store`");
  });

  it("sanitizes pipes, backticks, and CR/LF newlines in table cells", () => {
    const md = renderArchitectureMarkdown({
      indexed: true,
      totals: { files: 2, symbols: 1, edges: 1 },
      groups: [
        {
          group: "apps/a|b`c\r\nd",
          files: 1,
          symbols: 1,
          edges_in: 0,
          edges_out: 1,
        },
        {
          group: "pkg/x`y\nz|w",
          files: 1,
          symbols: 0,
          edges_in: 1,
          edges_out: 0,
        },
      ],
      group_edges: [{ from: "apps/a|b`c\r\nd", to: "pkg/x`y\nz|w", count: 1 }],
      hubs: [
        {
          path: "apps/a|b`c\r\nd/file|1`name\n.ts",
          group: "apps/a|b`c\r\nd",
          in_edges: 0,
          out_edges: 1,
          symbol_count: 1,
          key_symbols: ["sym|1`foo\r\nbar"],
        },
      ],
    });

    expect(md).toContain("| `apps/a\\|b'c d` | 1 | 1 | 0 | 1 |");
    expect(md).toContain("| `pkg/x'y z\\|w` | 1 | 0 | 1 | 0 |");
    expect(md).toContain("| `apps/a\\|b'c d` | `pkg/x'y z\\|w` | 1 |");
    expect(md).toContain(
      "| `apps/a\\|b'c d/file\\|1'name .ts` | `apps/a\\|b'c d` | 0 | 1 | 1 | `sym\\|1'foo bar` |",
    );

    const tableRows = md.split("\n").filter((line) => line.startsWith("|"));
    expect(tableRows).toHaveLength(10);
  });
});
