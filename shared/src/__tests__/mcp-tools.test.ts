import { describe, expect, it } from "vitest";
import {
  CreateTasksInput,
  findCycle,
  GetReadyTasksInput,
  ManageTaskInput,
  MCP_TOOL_NAMES,
  UpsertPersonaInput,
} from "../index.js";

const EPIC = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const EXISTING = "0e1d2c3b-4a59-4687-9a5b-4c3d2e1f0a9b";

describe("registry tool MCP", () => {
  it("mengekspos tool yang didaftarkan server", () => {
    expect(MCP_TOOL_NAMES.sort()).toEqual(
      [
        "claim_task",
        "complete_handoff",
        "create_epic",
        "create_tasks",
        "get_document",
        "get_project_board",
        "get_project_context",
        "get_ready_tasks",
        "list_epics",
        "list_personas",
        "load_skill",
        "manage_task",
        "report_blocker",
        "release_task",
        "review_pull_request",
        "save_document",
        "save_repo_skill",
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
