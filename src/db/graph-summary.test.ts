import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CatenextConfigSchema, GraphImpactOutput, GraphSummaryOutput } from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalService } from "../local-service.js";
import { indexProjectGraph } from "./graph-index.js";
import {
  analyzeGraphImpact,
  groupForPath,
  renderArchitectureMarkdown,
  renderImpactMarkdown,
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
    expect(groupForPath(nested, 4)).toBe("apps/cli/src/db");

    const deeper = "apps/cli/src/v1/internal/graph-summary.ts";
    expect(groupForPath(deeper, 4)).toBe("apps/cli/src/v1");
    expect(groupForPath(deeper, 5)).toBe("apps/cli/src/v1/internal");

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

  it("notes excluded test files and stale warnings in architecture markdown", () => {
    const md = renderArchitectureMarkdown(
      {
        indexed: true,
        stale: true,
        stale_reason: "modified_files",
        totals: { files: 1, symbols: 1, edges: 0 },
        groups: [{ group: "src", files: 1, symbols: 1, edges_in: 0, edges_out: 0 }],
        group_edges: [],
        hubs: [],
      },
      { depth: 4, includeTests: false },
    );
    expect(md).toContain("(depth=4)");
    expect(md).toContain("_Test files excluded (`include_tests=false`)._");
    expect(md).toContain(
      "> Warning: local code graph index is stale (modified_files). Run `catenext index` to refresh.",
    );
  });
});

describe("summarizeProjectGraph depth 4/5, include_tests, and stale flag", () => {
  it("supports depth 4 and 5 and filters test files from hubs, groups, and mermaid when include_tests is false", async () => {
    await mkdir(join(root, "apps/api/src/v1/users"), { recursive: true });
    await mkdir(join(root, "apps/api/src/v1/orders"), { recursive: true });
    await mkdir(join(root, "apps/api/src/__tests__"), { recursive: true });
    await mkdir(join(root, "tests/e2e"), { recursive: true });

    await writeFile(
      join(root, "apps/api/src/v1/users/repo.ts"),
      "export function findUser() { return 'u'; }\n",
    );
    await writeFile(
      join(root, "apps/api/src/v1/orders/service.ts"),
      `import { findUser } from "../users/repo.js";\nexport function createOrder() { return findUser(); }\n`,
    );
    await writeFile(
      join(root, "apps/api/src/v1/users/repo.test.ts"),
      `import { findUser } from "./repo.js";\nexport function testUser() { return findUser(); }\n`,
    );
    await writeFile(
      join(root, "apps/api/src/__tests__/helper.ts"),
      `import { findUser } from "../v1/users/repo.js";\nexport function helper() { return findUser(); }\n`,
    );
    await writeFile(
      join(root, "tests/e2e/flow.spec.ts"),
      `import { createOrder } from "../../apps/api/src/v1/orders/service.js";\nexport function e2e() { return createOrder(); }\n`,
    );

    const indexed = await indexProjectGraph(dbPath, projectId, root);
    expect(indexed).toEqual({ files: 5, symbols: 5, edges: 4 });

    const depth4NoTests = summarizeProjectGraph(dbPath, projectId, {
      depth: 4,
      include_mermaid: true,
      include_tests: false,
    });
    expect(GraphSummaryOutput.parse(depth4NoTests)).toEqual(depth4NoTests);
    expect(depth4NoTests.totals).toEqual({ files: 2, symbols: 2, edges: 1 });
    expect(depth4NoTests.groups.map((g) => g.group)).toEqual(["apps/api/src/v1"]);
    expect(depth4NoTests.hubs.map((h) => h.path)).toEqual([
      "apps/api/src/v1/orders/service.ts",
      "apps/api/src/v1/users/repo.ts",
    ]);
    expect(depth4NoTests.mermaid).toContain("apps/api/src/v1 (2 files)");
    expect(depth4NoTests.mermaid).not.toContain("__tests__");
    expect(depth4NoTests.mermaid).not.toContain("tests/e2e");

    const depth5NoTests = summarizeProjectGraph(dbPath, projectId, {
      depth: 5,
      include_mermaid: true,
      include_tests: false,
    });
    expect(depth5NoTests.groups).toEqual([
      {
        group: "apps/api/src/v1/orders",
        files: 1,
        symbols: 1,
        edges_in: 0,
        edges_out: 1,
      },
      {
        group: "apps/api/src/v1/users",
        files: 1,
        symbols: 1,
        edges_in: 1,
        edges_out: 0,
      },
    ]);
    expect(depth5NoTests.group_edges).toEqual([
      { from: "apps/api/src/v1/orders", to: "apps/api/src/v1/users", count: 1 },
    ]);
    expect(depth5NoTests.mermaid).toContain("apps/api/src/v1/orders (1 file)");
    expect(depth5NoTests.mermaid).toContain("apps/api/src/v1/users (1 file)");

    const depth5WithTests = summarizeProjectGraph(dbPath, projectId, {
      depth: 5,
      include_mermaid: true,
      include_tests: true,
    });
    expect(depth5WithTests.totals).toEqual({ files: 5, symbols: 5, edges: 4 });
    expect(depth5WithTests.groups.map((g) => g.group)).toEqual([
      "apps/api/src/v1/users",
      "apps/api/src/v1/orders",
      "apps/api/src/__tests__",
      "tests/e2e",
    ]);
    expect(depth5WithTests.hubs.map((h) => h.path)).toContain("apps/api/src/v1/users/repo.test.ts");
    expect(depth5WithTests.mermaid).toContain("apps/api/src/__tests__ (1 file)");
    expect(depth5WithTests.mermaid).toContain("tests/e2e (1 file)");
  });

  it("reports stale: true with stale_reason when unindexed, modified, or missing on disk", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    const targetPath = join(root, "src/mod.ts");
    await writeFile(targetPath, "export const v = 1;\n");

    const rootDirs = [{ rootId: null, dir: root }];
    const notIndexed = summarizeProjectGraph(dbPath, projectId, {}, rootDirs);
    expect(notIndexed.indexed).toBe(false);
    expect(notIndexed.stale).toBe(true);
    expect(notIndexed.stale_reason).toBe("not_indexed");

    await indexProjectGraph(dbPath, projectId, root);
    const fresh = summarizeProjectGraph(dbPath, projectId, {}, rootDirs);
    expect(fresh.indexed).toBe(true);
    expect(fresh.stale).toBeUndefined();
    expect("stale" in fresh).toBe(false);

    // Shift mtime deterministically so Math.floor(mtimeMs) differs from DB mtime_ms
    await writeFile(targetPath, "export const v = 2;\n");
    const shifted = new Date(Date.now() + 5_000);
    await utimes(targetPath, shifted, shifted);

    const modified = summarizeProjectGraph(dbPath, projectId, {}, rootDirs);
    expect(modified.stale).toBe(true);
    expect(modified.stale_reason).toBe("modified_files");

    await rm(targetPath);
    const missing = summarizeProjectGraph(dbPath, projectId, {}, rootDirs);
    expect(missing.stale).toBe(true);
    expect(missing.stale_reason).toBe("missing_files");
  });
});

describe("analyzeGraphImpact", () => {
  it("returns indexed: false when DB is empty and sets stale when code files exist", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");

    const unindexed = analyzeGraphImpact(dbPath, projectId, { path: "src/a.ts" }, [
      { rootId: null, dir: root },
    ]);
    expect(GraphImpactOutput.parse(unindexed)).toEqual(unindexed);
    expect(unindexed).toEqual({
      target: "src/a.ts",
      indexed: false,
      stale: true,
      stale_reason: "not_indexed",
      total_affected: 0,
      truncated: false,
      impacted: [],
    });
  });

  it("traces direct and transitive reverse dependents, handles cycles, enforces limit/truncated, and filters tests", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src/core.ts"),
      "export function coreA() {}\nexport function coreB() {}\n",
    );
    await writeFile(
      join(root, "src/service.ts"),
      `import { coreA } from "./core.js";\nexport function runService() { return coreA(); }\n`,
    );
    await writeFile(
      join(root, "src/handler.ts"),
      `import { runService } from "./service.js";\nexport function handle() { return runService(); }\n`,
    );
    await writeFile(
      join(root, "src/router.ts"),
      `import { handle } from "./handler.js";\nexport function route() { return handle(); }\n`,
    );
    // Cycle: cycleA <-> cycleB, and leaf -> cycleB
    await writeFile(
      join(root, "src/cycle-a.ts"),
      `import { cycleB } from "./cycle-b.js";\nexport function cycleA() { return cycleB(); }\n`,
    );
    await writeFile(
      join(root, "src/cycle-b.ts"),
      `import { cycleA } from "./cycle-a.js";\nexport function cycleB() { return cycleA(); }\n`,
    );
    await writeFile(
      join(root, "src/cycle-leaf.ts"),
      `import { cycleB } from "./cycle-b.js";\nexport function useCycle() { return cycleB(); }\n`,
    );
    // Test file depending on core.ts and intermediate test helper
    await writeFile(
      join(root, "src/core.test.ts"),
      `import { coreA } from "./core.js";\nexport function testCore() { return coreA(); }\n`,
    );
    await writeFile(
      join(root, "src/core-spec-consumer.ts"),
      `import { testCore } from "./core.test.js";\nexport function useTest() { return testCore(); }\n`,
    );

    await indexProjectGraph(dbPath, projectId, root);

    // depth=2: direct + 1-hop transitive, test files excluded
    const depth2 = analyzeGraphImpact(dbPath, projectId, {
      path: "./src/core.ts",
      depth: 2,
      include_tests: false,
    });
    expect(GraphImpactOutput.parse(depth2)).toEqual(depth2);
    expect(depth2).toEqual({
      target: "src/core.ts",
      indexed: true,
      total_affected: 2,
      truncated: false,
      impacted: [
        { path: "src/service.ts", distance: 1, kind: "direct", symbols_count: 1 },
        {
          path: "src/handler.ts",
          distance: 2,
          kind: "transitive",
          via: "src/service.ts",
          symbols_count: 1,
        },
      ],
    });

    // depth=3 reaches router.ts; include_tests=true includes core.test.ts and its dependent
    const depth3WithTests = analyzeGraphImpact(dbPath, projectId, {
      path: "src/core.ts",
      depth: 3,
      include_tests: true,
    });
    expect(depth3WithTests.total_affected).toBe(5);
    expect(depth3WithTests.truncated).toBe(false);
    expect(depth3WithTests.impacted.map((h) => [h.path, h.distance, h.kind])).toEqual([
      ["src/core.test.ts", 1, "direct"],
      ["src/service.ts", 1, "direct"],
      ["src/handler.ts", 2, "transitive"],
      ["src/core-spec-consumer.ts", 2, "transitive"],
      ["src/router.ts", 3, "transitive"],
    ]);

    // limit & truncated
    const limited = analyzeGraphImpact(dbPath, projectId, {
      path: "src/core.ts",
      depth: 3,
      limit: 2,
      include_tests: true,
    });
    expect(limited.total_affected).toBe(5);
    expect(limited.truncated).toBe(true);
    expect(limited.impacted).toHaveLength(2);

    // Cycle handling: terminates cleanly, does not revisit target
    const cycleImpact = analyzeGraphImpact(dbPath, projectId, {
      path: "src/cycle-a.ts",
      depth: 3,
    });
    expect(cycleImpact.total_affected).toBe(2);
    expect(cycleImpact.impacted).toEqual([
      { path: "src/cycle-b.ts", distance: 1, kind: "direct", symbols_count: 1 },
      {
        path: "src/cycle-leaf.ts",
        distance: 2,
        kind: "transitive",
        via: "src/cycle-b.ts",
        symbols_count: 1,
      },
    ]);

    // Stale detection on analyzeGraphImpact
    const rootDirs = [{ rootId: null, dir: root }];
    await writeFile(join(root, "src/core.ts"), "export function coreA() { return 1; }\n");
    const shifted = new Date(Date.now() + 5_000);
    await utimes(join(root, "src/core.ts"), shifted, shifted);
    const staleImpact = analyzeGraphImpact(dbPath, projectId, { path: "src/core.ts" }, rootDirs);
    expect(staleImpact.stale).toBe(true);
    expect(staleImpact.stale_reason).toBe("modified_files");

    const md = renderImpactMarkdown(staleImpact);
    expect(md).toContain("# Impact analysis: `src/core.ts`");
    expect(md).toContain("stale (modified_files)");
    expect(md).toContain("| `src/service.ts` | 1 | direct | - | 1 |");
  });
});
