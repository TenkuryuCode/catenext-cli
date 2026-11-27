import { describe, expect, it } from "vitest";
import {
  ClaimContextPackSchema,
  ClaimTaskInput,
  ClaimTaskOutput,
  CompleteHandoffInput,
  CreateTasksInput,
  findCycle,
  GetReadyTasksInput,
  GraphImpactInput,
  GraphImpactOutput,
  GraphNeighborsInput,
  GraphNeighborsOutput,
  GraphSummaryInput,
  ManageTaskInput,
  MCP_TOOL_NAMES,
  PlannedTaskSchema,
  SearchContextInput,
  SymbolSearchOutput,
  UpsertPersonaInput,
} from "../index.js";

const EPIC = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const EXISTING = "0e1d2c3b-4a59-4687-9a5b-4c3d2e1f0a9b";

describe("registry tool MCP", () => {
  it("mengekspos tool yang didaftarkan server", () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(
      [
        "archive_document",
        "cancel_task",
        "claim_task",
        "complete_handoff",
        "create_epic",
        "create_tasks",
        "get_document",
        "get_project_board",
        "get_project_context",
        "get_ready_tasks",
        "graph_impact",
        "graph_neighbors",
        "graph_summary",
        "interview_setup",
        "list_epics",
        "list_personas",
        "remove_persona",
        "load_skill",
        "manage_roots",
        "manage_task",
        "report_blocker",
        "release_task",
        "restore_document",
        "review_pull_request",
        "save_document",
        "save_repo_skill",
        "search_context",
        "session_brief",
        "set_dependencies",
        "symbol_search",
        "update_task",
        "update_epic",
        "upsert_persona",
      ].sort(),
    );
  });

  it("upsert_persona tidak menerima project_id dari agen (selalu proyek dari config)", () => {
    const parsed = UpsertPersonaInput.parse({
      alias: "bambang",
      role: "backend",
      project_id: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    } as never);
    expect(parsed).toEqual({ alias: "bambang", role: "backend" });
  });

  it("get_ready_tasks memberi limit default dan tidak menerima repo_name dari agen", () => {
    expect(GetReadyTasksInput.parse({})).toEqual({ limit: 10 });
    const parsed = GetReadyTasksInput.parse({ repo_name: "frontend" } as never);
    expect(parsed).not.toHaveProperty("repo_name");
  });

  it("complete_handoff menerima commit lokal dengan atau tanpa pull_request", () => {
    const task_id = EXISTING;
    const lease_id = "3c9f1e2d-8a7b-4c6d-9e5f-1a2b3c4d5e6f";
    const base = {
      task_id,
      lease_id,
      handoff_summary: {
        files_modified: ["apps/api/src/x.ts"],
        key_decisions: ["Keputusan singkat"],
        verification_command: "pnpm test",
        notes_for_next_agent: "Siap review.",
        git_branch: "feat/x",
        last_commit_hash: "a".repeat(40),
      },
    };
    expect(CompleteHandoffInput.safeParse(base).success).toBe(true);
    expect(CompleteHandoffInput.safeParse({ ...base, lease_id: undefined }).success).toBe(false);
    expect(
      CompleteHandoffInput.safeParse({
        ...base,
        handoff_summary: {
          ...base.handoff_summary,
          pull_request: {
            url: "https://github.com/org/repo/pull/1",
            base_branch: "main",
            head_sha: "a".repeat(40),
          },
        },
      }).success,
    ).toBe(true);
  });

  it("manage_task: revisi butuh feedback, assign butuh persona atau role", () => {
    const task_id = EXISTING;
    expect(ManageTaskInput.safeParse({ action: "request_revision", task_id }).success).toBe(false);
    expect(
      ManageTaskInput.safeParse({ action: "request_revision", task_id, feedback: "Perbaiki tes" })
        .success,
    ).toBe(true);
    expect(ManageTaskInput.safeParse({ action: "assign", task_id }).success).toBe(false);
    expect(
      ManageTaskInput.safeParse({ action: "assign", task_id, agent_alias: null }).success,
    ).toBe(true);
  });

  it("search_context defaults to document/skill/task and allows code source", () => {
    expect(SearchContextInput.parse({ query: "auth" }).sources).toEqual([
      "document",
      "skill",
      "task",
    ]);
    expect(
      SearchContextInput.parse({
        query: "auth",
        sources: ["document", "skill", "task", "code"],
      }).sources,
    ).toEqual(["document", "skill", "task", "code"]);
  });

  it("graph_summary applies defaults and enforces depth (1..5), max_hubs, and include_tests", () => {
    expect(GraphSummaryInput.parse({})).toEqual({
      depth: 2,
      max_hubs: 12,
      include_mermaid: true,
      include_tests: false,
    });
    expect(GraphSummaryInput.safeParse({ depth: 0 }).success).toBe(false);
    expect(GraphSummaryInput.safeParse({ depth: 5 }).success).toBe(true);
    expect(GraphSummaryInput.safeParse({ depth: 6 }).success).toBe(false);
    expect(GraphSummaryInput.safeParse({ max_hubs: 0 }).success).toBe(false);
    expect(GraphSummaryInput.safeParse({ max_hubs: 31 }).success).toBe(false);
    expect(GraphSummaryInput.parse({ include_tests: true }).include_tests).toBe(true);
    expect(GraphSummaryInput.parse({ prefix: "apps/cli/src" }).prefix).toBe("apps/cli/src");
    expect(GraphSummaryInput.safeParse({ prefix: "" }).success).toBe(false);
    expect(GraphSummaryInput.safeParse({ prefix: "a".repeat(301) }).success).toBe(false);
  });

  it("graph_neighbors supports single path, batched paths (1..5), include_symbols, and files output", () => {
    expect(GraphNeighborsInput.parse({ path: "src/a.ts" })).toEqual({
      path: "src/a.ts",
      depth: 1,
      limit: 20,
    });
    expect(
      GraphNeighborsInput.parse({
        paths: ["src/a.ts", "src/b.ts"],
        include_symbols: true,
        depth: 2,
        limit: 10,
      }),
    ).toEqual({
      paths: ["src/a.ts", "src/b.ts"],
      include_symbols: true,
      depth: 2,
      limit: 10,
    });
    expect(GraphNeighborsInput.safeParse({}).success).toBe(false);
    expect(GraphNeighborsInput.safeParse({ paths: [] }).success).toBe(false);
    expect(
      GraphNeighborsInput.safeParse({
        paths: ["1.ts", "2.ts", "3.ts", "4.ts", "5.ts", "6.ts"],
      }).success,
    ).toBe(false);
    expect(GraphNeighborsInput.safeParse({ path: "src/a.ts", paths: ["src/b.ts"] }).success).toBe(
      false,
    );
    expect(
      GraphNeighborsInput.safeParse({ path: "src/a.ts", paths: ["src/a.ts", "src/b.ts"] }).success,
    ).toBe(true);

    expect(
      GraphNeighborsOutput.parse({
        edges: [],
        files: [
          {
            path: "src/a.ts",
            edges: [{ kind: "imports", from: "src/a.ts", to: "src/b.ts" }],
            symbols: ["Alpha"],
          },
        ],
      }),
    ).toMatchObject({
      files: [{ path: "src/a.ts", symbols: ["Alpha"] }],
    });
  });

  it("graph_impact validates input bounds and output freshness hints", () => {
    expect(GraphImpactInput.parse({ path: "src/db.ts" })).toEqual({
      path: "src/db.ts",
      depth: 2,
      limit: 20,
      include_tests: false,
    });
    expect(GraphImpactInput.safeParse({ path: "" }).success).toBe(false);
    expect(GraphImpactInput.safeParse({ path: "src/a.ts", depth: 0 }).success).toBe(false);
    expect(GraphImpactInput.safeParse({ path: "src/a.ts", depth: 3 }).success).toBe(true);
    expect(GraphImpactInput.safeParse({ path: "src/a.ts", depth: 4 }).success).toBe(false);
    expect(GraphImpactInput.safeParse({ path: "src/a.ts", limit: 41 }).success).toBe(false);

    expect(
      GraphImpactOutput.parse({
        target: "src/db.ts",
        indexed: true,
        stale: true,
        stale_reason: "modified_files",
        total_affected: 2,
        truncated: false,
        impacted: [
          { path: "src/service.ts", distance: 1, kind: "direct", symbols_count: 3 },
          {
            path: "src/routes.ts",
            distance: 2,
            kind: "transitive",
            via: "src/service.ts",
            symbols_count: 2,
          },
        ],
      }),
    ).toMatchObject({ stale: true, total_affected: 2 });

    expect(
      GraphNeighborsOutput.parse({ path: "src/a.ts", edges: [], stale: true, stale_reason: "x" }),
    ).toMatchObject({ stale: true });
    expect(
      SymbolSearchOutput.parse({ hits: [], stale: true, stale_reason: "not_indexed" }),
    ).toMatchObject({ stale: true });
  });

  it("claim_task menerima worktree tanpa atau dengan worktree_path dan base_branch", () => {
    const session_id = "3c9f1e2d-8a7b-4c6d-9e5f-1a2b3c4d5e6f";
    expect(
      ClaimTaskInput.safeParse({
        task_id: EXISTING,
        worktree: { session_id, branch: "feat/e1" },
      }).success,
    ).toBe(true);
    expect(
      ClaimTaskInput.parse({
        task_id: EXISTING,
        worktree: {
          session_id,
          branch: "feat/e1",
          worktree_path: "/tmp/worktrees/e1",
          base_branch: "main",
        },
      }),
    ).toEqual({
      task_id: EXISTING,
      worktree: {
        session_id,
        branch: "feat/e1",
        worktree_path: "/tmp/worktrees/e1",
        base_branch: "main",
      },
    });
    expect(
      ClaimTaskInput.safeParse({
        task_id: EXISTING,
        worktree: { session_id, branch: "feat/e1", worktree_path: "" },
      }).success,
    ).toBe(false);
    expect(
      ClaimTaskInput.safeParse({
        task_id: EXISTING,
        worktree: { session_id, branch: "feat/e1", base_branch: "HEAD" },
      }).success,
    ).toBe(false);

    expect(
      ClaimTaskInput.parse({
        task_id: EXISTING,
        include_context: true,
      }),
    ).toEqual({
      task_id: EXISTING,
      include_context: true,
    });

    const out = ClaimTaskOutput.parse({
      task: {
        id: EXISTING,
        title: "Scoped task",
        prompt_instruction: "Do work",
        status: "IN_PROGRESS",
        revision_count: 0,
        scope_files: [" packages/shared/src/task.ts "],
        verify_command: " pnpm test ",
        doc_refs: [" blueprint "],
      },
      lease_id: session_id,
      lease_expires_at: "2026-11-27T12:00:00.000Z",
      dependencies: [],
      context_pack: {
        epic_summary: "Zero-waste delegation",
        sync_board_excerpt: "DECISIONS: Wave 1",
        skills_hint: ["be-node"],
        graph_slice: [
          {
            path: "packages/shared/src/task.ts",
            edges: [{ kind: "imports", from: "a.ts", to: "b.ts" }],
            symbols: ["TaskSchema"],
            symbol_locations: [{ name: "TaskSchema", line: 12 }],
          },
        ],
      },
    });
    expect(out.task.scope_files).toEqual(["packages/shared/src/task.ts"]);
    expect(out.task.verify_command).toBe("pnpm test");
    expect(out.task.doc_refs).toEqual(["blueprint"]);
    expect(out.context_pack?.skills_hint).toEqual(["be-node"]);
    expect(out.context_pack?.graph_slice?.[0]?.symbol_locations).toEqual([
      { name: "TaskSchema", line: 12 },
    ]);
  });

  it("validates start lines and location count in claim only", () => {
    const legacyFile = { path: "src/a.ts", edges: [], symbols: ["run"] };
    const parseClaim = (symbol_locations: unknown) =>
      ClaimContextPackSchema.safeParse({ graph_slice: [{ ...legacyFile, symbol_locations }] });
    const location = { name: "run", line: 1 };
    expect(parseClaim([location]).success).toBe(true);
    expect(parseClaim(Array(4).fill(location)).success).toBe(false);
    for (const line of [undefined, null, 0, -1, 1.5]) {
      expect(parseClaim([{ ...location, line }]).success).toBe(false);
    }
    expect(
      GraphNeighborsOutput.parse({
        edges: [],
        files: [{ ...legacyFile, symbol_locations: [location] }],
      }),
    ).toEqual({ edges: [], files: [legacyFile] });
  });

  it("PlannedTaskSchema validates optional scope_files, verify_command, and doc_refs", () => {
    const valid = PlannedTaskSchema.parse({
      ref: "t1",
      title: "Contracts",
      prompt_instruction: "Extend Zod",
      scope_files: [" packages/shared/src/task.ts "],
      verify_command: " pnpm test ",
      doc_refs: [" sync-board "],
    });
    expect(valid.scope_files).toEqual(["packages/shared/src/task.ts"]);
    expect(valid.verify_command).toBe("pnpm test");
    expect(valid.doc_refs).toEqual(["sync-board"]);

    expect(
      PlannedTaskSchema.safeParse({
        ref: "t1",
        title: "Bad",
        prompt_instruction: "Too many files",
        scope_files: Array.from({ length: 21 }, (_, i) => `f${i}.ts`),
      }).success,
    ).toBe(false);
    expect(
      PlannedTaskSchema.safeParse({
        ref: "t1",
        title: "Bad",
        prompt_instruction: "Too many doc_refs",
        doc_refs: Array.from({ length: 11 }, (_, i) => `doc-${i}`),
      }).success,
    ).toBe(false);
    expect(
      PlannedTaskSchema.safeParse({
        ref: "t1",
        title: "Bad",
        prompt_instruction: "Empty verify",
        verify_command: "   ",
      }).success,
    ).toBe(false);
  });
});

describe("create_tasks", () => {
  const task = (ref: string, depends_on: string[] = []) => ({
    ref,
    title: `Task ${ref}`,
    prompt_instruction: "Kerjakan.",
    depends_on,
  });

  it("menerima DAG dengan ref lokal dan UUID task yang sudah ada", () => {
    const r = CreateTasksInput.safeParse({
      epic_id: EPIC,
      tasks: [task("db"), task("api", ["db", EXISTING]), task("ui", ["api"])],
    });
    expect(r.success).toBe(true);
  });

  it("menolak ref duplikat, dependensi tak dikenal, dan self-dependency", () => {
    expect(
      CreateTasksInput.safeParse({ epic_id: EPIC, tasks: [task("a"), task("a")] }).success,
    ).toBe(false);
    expect(
      CreateTasksInput.safeParse({ epic_id: EPIC, tasks: [task("a", ["ghost"])] }).success,
    ).toBe(false);
    expect(CreateTasksInput.safeParse({ epic_id: EPIC, tasks: [task("a", ["a"])] }).success).toBe(
      false,
    );
  });

  it("menolak dependensi melingkar", () => {
    const r = CreateTasksInput.safeParse({
      epic_id: EPIC,
      tasks: [task("a", ["c"]), task("b", ["a"]), task("c", ["b"])],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("melingkar");
  });
});

describe("findCycle", () => {
  it("mengembalikan null untuk DAG dan jalur untuk siklus", () => {
    expect(findCycle([{ task: "b", dependsOn: "a" }])).toBeNull();
    expect(
      findCycle([
        { task: "a", dependsOn: "b" },
        { task: "b", dependsOn: "a" },
      ]),
    ).toEqual(["a", "b", "a"]);
  });
});
