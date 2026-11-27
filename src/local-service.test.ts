import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type CatenextConfig,
  CatenextConfigSchema,
  type HandoffSummary,
  LOCK_LEASE_MS,
  type McpToolInput,
} from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graphIndex from "./db/graph-index.js";
import { LocalService } from "./local-service.js";
import * as worktreeStatus from "./worktree-status.js";

function readTaskJsonField(
  stateFile: string,
  projectId: string,
  taskId: string,
  column: "lease_json" | "branch_json" | "review_json" | "integrated_commit_json",
): Record<string, unknown> | undefined {
  const db = new DatabaseSync(stateFile, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT ${column} AS raw FROM tasks WHERE project_id = ? AND id = ?`)
      .get(projectId, taskId) as { raw: string | null } | undefined;
    if (!row?.raw) return undefined;
    return JSON.parse(row.raw) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

const exec = promisify(execFile);
const start = Date.parse("2026-01-01T09:00:00.000Z");
const heads = { current: "a".repeat(40), next: "b".repeat(40) };
const testSecret = `ghp_${"x".repeat(24)}`;
const plan = (
  ref: string,
  options: Partial<McpToolInput<"create_tasks">["tasks"][number]> = {},
) => ({
  ref,
  title: `Task ${ref}`,
  prompt_instruction: `Instructions for ${ref}.`,
  ...options,
});
const handoff = (options: Partial<HandoffSummary> = {}): HandoffSummary => ({
  files_modified: ["src/main.ts"],
  key_decisions: ["Reuse existing data model"],
  verification_command: "pnpm test",
  notes_for_next_agent: "Reviewed locally",
  git_branch: "feat/local",
  last_commit_hash: heads.current,
  ...options,
});

let root: string;
let config: CatenextConfig;
let service: LocalService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-local-"));
  config = CatenextConfigSchema.parse({
    schema_version: 1,
    project_id: randomUUID(),
    project_name: "Offline",
    repo_name: "be",
  });
  service = new LocalService(root, config);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function draft(tasks: McpToolInput<"create_tasks">["tasks"], local = service) {
  const { epic } = await local.callTool("create_epic", { title: "Delivery" });
  const { created } = await local.callTool("create_tasks", { epic_id: epic.id, tasks });
  return {
    epic,
    created,
    id(ref: string) {
      const task = created.find((item) => item.ref === ref);
      if (!task) throw new Error(`Test task ${ref} not created`);
      return task.task_id;
    },
  };
}

const manage = (action: string, task_id: string, extra = {}, local = service) =>
  local.callTool("manage_task", { action, task_id, ...extra });

async function repo(name: string, projectId = config.project_id) {
  const newRoot = join(root, `${name}-${projectId}`);
  await mkdir(newRoot);
  return new LocalService(newRoot, {
    ...config,
    repo_name: name,
    project_id: projectId,
    state_file: relative(newRoot, service.stateFile),
  });
}

describe("LocalService task workflows", () => {
  it("keeps drafts out of ready tasks and unlocks cross-repo dependencies only after local approval", async () => {
    const fe = await repo("fe");
    await service.callTool("upsert_persona", {
      alias: "bambang",
      role: "backend",
      repos: ["be"],
      rules: ["Run tests"],
    });
    await fe.callTool("upsert_persona", { alias: "mira", role: "frontend", repos: ["fe"] });
    await service.callTool("upsert_persona", { alias: "bambang", role: "backend" });
    const { id, epic, created } = await draft([
      plan("api", { persona: "bambang" }),
      plan("ui", { role: "frontend", depends_on: ["api"] }),
    ]);
    expect(created.map((task) => task.status)).toEqual(["DRAFT", "DRAFT"]);
    expect(await service.callTool("list_epics", {})).toMatchObject({
      epics: [{ id: epic.id, task_counts: { DRAFT: 2 } }],
    });
    expect(await service.callTool("get_ready_tasks", { agent_alias: "bambang" })).toEqual({
      tasks: [],
    });
    await manage("approve_plan", id("api"));
    await manage("return_to_draft", id("api"));
    await expect(
      service.callTool("claim_task", { task_id: id("api"), agent_alias: "bambang" }),
    ).rejects.toMatchObject({ code: "task_not_claimable" });
    await manage("approve_plan", id("api"));
    await manage("approve_plan", id("ui"));
    await expect(
      fe.callTool("claim_task", { task_id: id("ui"), agent_alias: "mira" }),
    ).rejects.toMatchObject({ code: "dependencies_pending" });
    await expect(
      fe.callTool("claim_task", { task_id: id("api"), agent_alias: "bambang" }),
    ).rejects.toMatchObject({ code: "wrong_repo" });
    await expect(
      service.callTool("claim_task", { task_id: id("api"), agent_alias: "mira" }),
    ).rejects.toMatchObject({ code: "persona_mismatch" });
    expect(await service.callTool("get_ready_tasks", {})).toEqual({ tasks: [] });
    const claim = await service.callTool("claim_task", {
      task_id: id("api"),
      agent_alias: "bambang",
    });
    expect(claim).toMatchObject({
      task: { status: "IN_PROGRESS", target_repo: "be" },
      persona: { rules: ["Run tests"] },
    });
    const summary = handoff({ notes_for_next_agent: `Key should not persist: ${testSecret}` });
    expect(
      await service.callTool("complete_handoff", {
        lease_id: claim.lease_id,
        task_id: id("api"),
        handoff_summary: summary,
      }),
    ).toMatchObject({ status: "NEEDS_REVIEW", unlocked_task_ids: [] });
    expect(await service.callTool("review_pull_request", { request: { action: "list" } })).toEqual({
      reviews: [],
    });
    expect(await fe.callTool("get_ready_tasks", { agent_alias: "mira" })).toEqual({ tasks: [] });
    expect(await manage("approve", id("api"))).toMatchObject({
      status: "DONE",
      unlocked_task_ids: [id("ui")],
    });
    expect(await fe.callTool("get_ready_tasks", { agent_alias: "mira" })).toMatchObject({
      tasks: [{ id: id("ui"), target_repo: "fe" }],
    });
    const context = await fe.callTool("get_project_context", { agent_alias: "mira" });
    expect(context.project_repos).toEqual(["be", "fe"]);
    expect(context.recent_handoffs).toMatchObject([
      {
        task_id: id("api"),
        handoff_summary: {
          notes_for_next_agent: "Key should not persist: [REDACTED:github_token]",
        },
      },
    ]);
    expect(context.recent_handoffs[0]).not.toHaveProperty("integrated_commit");
    const board = await service.callTool("get_project_board", {
      status: ["DONE", "TODO"],
      limit: 1,
    });
    expect(board).toMatchObject({ epics: [{ counts: { DONE: 1, TODO: 1 } }], truncated: true });
    expect(await readFile(service.stateFile, "utf8")).not.toContain(testSecret);
  });

  it("rejects cycles, foreign dependencies, and incompatible persona repos atomically", async () => {
    const { id } = await draft([plan("good")]);
    const foreign = await repo("other", randomUUID());
    const { id: foreignId } = await draft([plan("foreign")], foreign);
    const { epic } = await service.callTool("create_epic", { title: "Invalid plan" });
    const create = (tasks: McpToolInput<"create_tasks">["tasks"]) =>
      service.callTool("create_tasks", { epic_id: epic.id, tasks });
    await expect(
      create([plan("a", { depends_on: ["b"] }), plan("b", { depends_on: ["a"] })]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      create([
        plan("a", { depends_on: [id("good")] }),
        plan("b", { depends_on: [foreignId("foreign")] }),
      ]),
    ).rejects.toMatchObject({ code: "dependency_not_found" });
    await service.callTool("upsert_persona", { alias: "mira", role: "frontend", repos: ["fe"] });
    await expect(
      create([plan("a"), plan("b", { persona: "mira", target_repo: "be" })]),
    ).rejects.toMatchObject({ code: "persona_repo_mismatch" });
    expect(await service.callTool("get_project_board", { epic_id: epic.id })).toMatchObject({
      tasks: [],
    });
    const result = await create([plan("a", { depends_on: [id("good")] })]);
    const taskId = result.created[0]?.task_id;
    expect(await service.callTool("get_project_board", { epic_id: epic.id })).toMatchObject({
      tasks: [{ id: taskId, depends_on: [id("good")] }],
    });
  });

  it("keeps revision context through release, block and unblock; marks started descendants stale", async () => {
    const { id } = await draft([
      plan("up"),
      plan("down", { depends_on: ["up"] }),
      plan("later", { depends_on: ["down"] }),
    ]);
    for (const ref of ["up", "down", "later"]) await manage("approve_plan", id(ref));
    for (const ref of ["up", "down"]) {
      const { lease_id } = await service.callTool("claim_task", { task_id: id(ref) });
      await service.callTool("complete_handoff", {
        lease_id,
        task_id: id(ref),
        handoff_summary: handoff(),
      });
      await manage("approve", id(ref));
    }
    const later = await service.callTool("claim_task", { task_id: id("later") });
    expect(
      await manage("request_revision", id("up"), { feedback: "Fix cross-repo contract." }),
    ).toMatchObject({
      status: "REVISION_REQUESTED",
      revision_count: 1,
      stale_task_ids: [id("down"), id("later")],
    });
    expect(
      await service.callTool("get_project_board", { status: ["DONE", "IN_PROGRESS"] }),
    ).toMatchObject({
      tasks: [
        { id: id("down"), is_stale: true },
        { id: id("later"), is_stale: true },
      ],
    });
    await expect(service.callTool("claim_task", { task_id: id("up") })).rejects.toMatchObject({
      code: "repo_busy",
    });
    await service.callTool("release_task", { task_id: id("later"), lease_id: later.lease_id });
    // Task stale tetap claimable (flag `is_stale` di board, bukan status); tanpa ini ia terkunci permanen.
    expect(await service.callTool("get_ready_tasks", {})).toMatchObject({
      tasks: [{ id: id("up"), revision: true }, { id: id("later") }],
    });
    const upClaim = await service.callTool("claim_task", { task_id: id("up") });
    expect(upClaim).toMatchObject({
      revision: {
        review_feedback: "Fix cross-repo contract.",
        previous_handoff: { last_commit_hash: heads.current },
      },
    });
    expect(
      await service.callTool("release_task", { task_id: id("up"), lease_id: upClaim.lease_id }),
    ).toMatchObject({
      status: "REVISION_REQUESTED",
    });
    const upAgain = await service.callTool("claim_task", { task_id: id("up") });
    await service.callTool("report_blocker", {
      lease_id: upAgain.lease_id,
      task_id: id("up"),
      category: "missing_env",
      reason: "Missing test environment.",
    });
    expect(await service.callTool("get_project_board", { status: ["BLOCKED"] })).toMatchObject({
      tasks: [{ blocker_reason: "Missing test environment." }],
    });
    expect(await manage("unblock", id("up"))).toMatchObject({ status: "REVISION_REQUESTED" });
    expect(
      await service.callTool("get_project_board", { status: ["REVISION_REQUESTED"] }),
    ).toMatchObject({ tasks: [{ blocker_reason: null }] });
  });

  it("enforces branch/session reservations and expires worktrees without matching heartbeats", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const mono = new LocalService(root, { ...config, layout: "monorepo" });
    const { id } = await draft([plan("a"), plan("b"), plan("c")], mono);
    for (const ref of ["a", "b", "c"]) await manage("approve_plan", id(ref), {}, mono);
    const a = { branch: "feat/a", session_id: randomUUID() };
    const b = { branch: "feat/b", session_id: randomUUID() };
    await expect(mono.callTool("claim_task", { task_id: id("a") })).rejects.toMatchObject({
      code: "worktree_required",
    });
    const { lease_id: aLease } = await mono.callTool("claim_task", {
      task_id: id("a"),
      worktree: a,
    });
    expect(aLease).toBeDefined();
    await expect(
      mono.callTool("claim_task", { task_id: id("b"), worktree: a }),
    ).rejects.toMatchObject({ code: "session_busy" });
    await expect(
      mono.callTool("claim_task", { task_id: id("b"), worktree: { ...b, branch: a.branch } }),
    ).rejects.toMatchObject({ code: "branch_busy" });
    const { lease_id: bLease } = await mono.callTool("claim_task", {
      task_id: id("b"),
      worktree: b,
    });
    await expect(
      mono.callTool("release_task", { task_id: id("a"), lease_id: bLease }),
    ).rejects.toMatchObject({ code: "not_lock_holder" });
    clock.mockReturnValue(start + LOCK_LEASE_MS - 1);
    await mono.callTool("get_ready_tasks", { lease_id: aLease });
    clock.mockReturnValue(start + LOCK_LEASE_MS);
    // Lease `a` expired tapi belum dilepas (handoff terlambat tetap diterima); `b` masih dipegang.
    expect(await mono.callTool("get_project_board", {})).toMatchObject({
      tasks: [{ status: "IN_PROGRESS" }, { status: "IN_PROGRESS" }, { status: "TODO" }],
    });
    await expect(
      mono.callTool("complete_handoff", {
        task_id: id("a"),
        lease_id: aLease,
        handoff_summary: handoff(),
      }),
    ).rejects.toMatchObject({ code: "branch_mismatch" });
    await mono.callTool("complete_handoff", {
      task_id: id("a"),
      lease_id: aLease,
      handoff_summary: handoff({ git_branch: a.branch }),
    });
    await expect(
      mono.callTool("claim_task", { task_id: id("c"), worktree: { ...b, branch: a.branch } }),
    ).rejects.toMatchObject({ code: "branch_busy" });
    await manage("request_revision", id("a"), { feedback: "Follow up on tests." }, mono);
    await expect(
      mono.callTool("claim_task", { task_id: id("a"), worktree: b }),
    ).rejects.toMatchObject({ code: "reserved_branch" });
    expect(await mono.callTool("claim_task", { task_id: id("a"), worktree: a })).toMatchObject({
      revision: { review_feedback: "Follow up on tests." },
    });
    await expect(
      mono.callTool("release_task", { task_id: id("a"), lease_id: aLease }),
    ).rejects.toMatchObject({ code: "not_lock_holder" });
  });
});

describe("LocalService approval gate", () => {
  it("menolak approve dan approve_plan dari agen MCP, sedangkan CLI manusia tetap bisa", async () => {
    const agent = new LocalService(root, config, "agent");
    const { id } = await draft([plan("gated")]);
    await expect(manage("approve_plan", id("gated"), {}, agent)).rejects.toMatchObject({
      code: "human_approval_required",
      message: expect.stringContaining(`catenext task approve ${id("gated")}`),
    });
    expect(await service.readTaskEvents({ taskId: id("gated") })).toEqual([]);
    await manage("approve_plan", id("gated"));
    const { lease_id } = await service.callTool("claim_task", { task_id: id("gated") });
    await service.callTool("complete_handoff", {
      lease_id,
      task_id: id("gated"),
      handoff_summary: handoff(),
    });
    await expect(manage("approve", id("gated"), {}, agent)).rejects.toMatchObject({
      code: "human_approval_required",
      message: expect.stringContaining(`catenext review approve ${id("gated")}`),
    });
    expect(await service.readTaskEvents({ taskId: id("gated"), event: "approve" })).toEqual([]);
    expect(await service.callTool("get_project_board", {})).toMatchObject({
      tasks: [{ id: id("gated"), status: "NEEDS_REVIEW" }],
    });
    await expect(manage("approve", id("gated"))).resolves.toMatchObject({ status: "DONE" });
  });

  it("tidak bisa dibypass lewat field input (agent_alias palsu tetap ditolak)", async () => {
    const agent = new LocalService(root, config, "agent");
    const { id } = await draft([plan("spoof")]);
    await expect(
      agent.callTool("manage_task", {
        action: "approve_plan",
        task_id: id("spoof"),
        agent_alias: "manusia",
      }),
    ).rejects.toMatchObject({ code: "human_approval_required" });
  });

  it("menegakkan matriks izin untuk upsert_persona dan manage_roots pada pemanggil agent", async () => {
    const agent = new LocalService(root, config, "agent");
    // Belum di-seed: permissions kosong -> agent ditolak.
    await expect(
      agent.callTool("upsert_persona", { alias: "sec", role: "security" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(agent.callTool("remove_persona", { alias: "sec" })).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(
      agent.callTool("manage_roots", { action: "add", path: root }),
    ).rejects.toMatchObject({ code: "permission_denied" });

    await service.ensureSeed({ personaSeed: "minimal" });
    await expect(
      agent.callTool("upsert_persona", { alias: "sec", role: "security" }),
    ).resolves.toMatchObject({ created: true });

    // Cabut izin orchestrator (sisakan human saja) -> agent harus ditolak meski human masih ada.
    await service.revokePermission("upsert_persona", "orchestrator");
    await expect(
      agent.callTool("upsert_persona", { alias: "sec2", role: "security" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(agent.callTool("remove_persona", { alias: "sec" })).rejects.toMatchObject({
      code: "permission_denied",
    });

    await service.setPermissions("manage_roots", ["human"]);
    const extDir = await mkdtemp(join(tmpdir(), "catenext-perm-root-"));
    try {
      await expect(
        agent.callTool("manage_roots", { action: "add", path: extDir }),
      ).rejects.toMatchObject({ code: "permission_denied" });
      // Human CLI tetap boleh menambah root valid.
      await expect(
        service.callTool("manage_roots", { action: "add", path: extDir }),
      ).resolves.toMatchObject({ roots: [{ path: extDir }] });
    } finally {
      await rm(extDir, { recursive: true, force: true });
    }
  });

  it("remove_persona menolak lease aktif, workspace root, dan menghapus bila aman", async () => {
    await service.callTool("upsert_persona", {
      alias: "be",
      role: "backend",
      repos: ["be"],
      rules: ["Tests"],
    });
    const { id } = await draft([plan("rm", { persona: "be" })]);
    await manage("approve_plan", id("rm"));

    const claim = await service.callTool("claim_task", {
      task_id: id("rm"),
      agent_alias: "be",
    });
    await expect(service.callTool("remove_persona", { alias: "be" })).rejects.toMatchObject({
      code: "persona_in_use",
    });
    await service.callTool("release_task", { task_id: id("rm"), lease_id: claim.lease_id });

    await expect(service.callTool("remove_persona", { alias: "be" })).resolves.toMatchObject({
      alias: "be",
      removed: true,
    });
    expect(
      (await service.callTool("list_personas", {})).personas.map((p) => p.alias),
    ).not.toContain("be");

    await service.callTool("upsert_persona", { alias: "fe", role: "frontend", repos: ["fe"] });
    const extDir = await mkdtemp(join(tmpdir(), "catenext-rm-root-"));
    try {
      await service.callTool("manage_roots", {
        action: "add",
        path: extDir,
        persona: "fe",
      });
      await expect(service.callTool("remove_persona", { alias: "fe" })).rejects.toMatchObject({
        code: "persona_owns_roots",
      });
      const listed = await service.callTool("manage_roots", { action: "list" });
      const owned = listed.roots.find((r) => r.path === extDir);
      if (!owned) throw new Error("Expected workspace root for fe fixture");
      await service.callTool("manage_roots", {
        action: "remove",
        root_id: owned.id,
      });
      await expect(service.callTool("remove_persona", { alias: "fe" })).resolves.toMatchObject({
        removed: true,
      });
    } finally {
      await rm(extDir, { recursive: true, force: true });
    }
  });

  it("denies agent attempts to reseed project state or change permissions", async () => {
    const agent = new LocalService(root, config, "agent");
    await expect(agent.ensureSeed()).rejects.toMatchObject({ code: "permission_denied" });
    await expect(agent.setPermissions("manage_roots", ["orchestrator"])).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(agent.grantPermission("approve_plan", "human")).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(agent.revokePermission("approve_plan", "human")).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("manage_roots menolak path hilang, file biasa, dan symlink", async () => {
    const missing = join(root, "does-not-exist");
    await expect(
      service.callTool("manage_roots", { action: "add", path: missing }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const regularFile = join(root, "plain.txt");
    await writeFile(regularFile, "not a directory\n");
    await expect(
      service.callTool("manage_roots", { action: "add", path: regularFile }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const realDir = join(root, "real-dir");
    const linkDir = join(root, "link-dir");
    await mkdir(realDir);
    await symlink(realDir, linkDir, "junction");
    await expect(
      service.callTool("manage_roots", { action: "add", path: linkDir }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("LocalService lease hashing", () => {
  it("menyimpan hash di state, menerima token plaintext claim, menolak token/hash palsu", async () => {
    const { id } = await draft([plan("hashed")]);
    await manage("approve_plan", id("hashed"));
    const { lease_id } = await service.callTool("claim_task", { task_id: id("hashed") });
    expect(lease_id).not.toMatch(/^sha256\./);

    const stored = readTaskJsonField(
      service.stateFile,
      config.project_id,
      id("hashed"),
      "lease_json",
    )?.id as string | undefined;
    expect(stored).toMatch(/^sha256\.[0-9a-f]{64}$/);
    expect(stored).not.toBe(lease_id);

    await expect(service.callTool("get_ready_tasks", { lease_id })).resolves.toMatchObject({
      tasks: [],
    });
    await expect(
      service.callTool("release_task", { task_id: id("hashed"), lease_id }),
    ).resolves.toMatchObject({ status: "TODO" });

    const again = await service.callTool("claim_task", { task_id: id("hashed") });
    const storedAgain = readTaskJsonField(
      service.stateFile,
      config.project_id,
      id("hashed"),
      "lease_json",
    )?.id as string | undefined;
    if (storedAgain === undefined) throw new Error("Missing hashed lease in state");
    expect(storedAgain).toMatch(/^sha256\.[0-9a-f]{64}$/);
    await expect(
      service.callTool("release_task", {
        task_id: id("hashed"),
        lease_id: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_lock_holder" });
    // Hash di state bukan UUID: input schema menolak sebelum sampai held().
    await expect(
      service.callTool("release_task", {
        task_id: id("hashed"),
        lease_id: storedAgain,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      service.callTool("release_task", {
        task_id: id("hashed"),
        lease_id: again.lease_id,
      }),
    ).resolves.toMatchObject({ status: "TODO" });
  });

  it("menyimpan hash review lease dan menolak submit dengan token palsu", async () => {
    const { id } = await draft([plan("revhash")]);
    const task_id = id("revhash");
    await manage("approve_plan", task_id);
    const { lease_id: claimLease } = await service.callTool("claim_task", { task_id });
    await service.callTool("complete_handoff", {
      lease_id: claimLease,
      task_id,
      handoff_summary: handoff({
        pull_request: {
          url: "https://github.com/example/repo/pull/7",
          head_sha: heads.current,
          base_branch: "main",
        },
      }),
    });

    const claimed = await service.callTool("review_pull_request", {
      request: { action: "claim", task_id },
    });
    if (!("lease_id" in claimed)) throw new Error("Missing review lease");
    expect(claimed.lease_id).not.toMatch(/^sha256\./);

    const review = readTaskJsonField(service.stateFile, config.project_id, task_id, "review_json");
    const stored = (review?.lease as { id?: string } | undefined)?.id;
    if (stored === undefined) throw new Error("Missing hashed review lease in state");
    expect(stored).toMatch(/^sha256\.[0-9a-f]{64}$/);
    expect(stored).not.toBe(claimed.lease_id);

    expect(
      await service.callTool("review_pull_request", {
        request: {
          action: "submit",
          task_id,
          head_sha: heads.current,
          lease_id: randomUUID(),
          decision: "request_changes",
          feedback: "Token palsu tidak boleh lolos.",
        },
      }),
    ).toMatchObject({ warning: expect.stringContaining("lease atau head SHA") });
    await expect(
      service.callTool("review_pull_request", {
        request: {
          action: "submit",
          task_id,
          head_sha: heads.current,
          lease_id: stored,
          decision: "request_changes",
          feedback: "Hash dari state tidak boleh dipakai sebagai token.",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(
      await service.callTool("review_pull_request", {
        request: {
          action: "submit",
          task_id,
          head_sha: heads.current,
          lease_id: claimed.lease_id,
          decision: "request_changes",
          feedback: "Perbaiki dulu sebelum approve.",
        },
      }),
    ).toMatchObject({ status: "REVISION_REQUESTED" });
  });
});

describe("LocalService lease expiry", () => {
  it("menerima handoff terlambat dari holder lama selama belum ada claim baru", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const { id } = await draft([plan("late")]);
    await manage("approve_plan", id("late"));
    const { lease_id } = await service.callTool("claim_task", { task_id: id("late") });
    clock.mockReturnValue(start + LOCK_LEASE_MS + 1);
    await expect(
      service.callTool("complete_handoff", {
        lease_id,
        task_id: id("late"),
        handoff_summary: handoff(),
      }),
    ).resolves.toMatchObject({ status: "NEEDS_REVIEW" });
  });

  it("menolak handoff dengan lease_id lama setelah task diambil ulang", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const { id } = await draft([plan("reclaim")]);
    await manage("approve_plan", id("reclaim"));
    const old = await service.callTool("claim_task", { task_id: id("reclaim") });
    clock.mockReturnValue(start + LOCK_LEASE_MS + 1);
    const fresh = await service.callTool("claim_task", { task_id: id("reclaim") });
    expect(fresh.lease_id).not.toBe(old.lease_id);
    await expect(
      service.callTool("complete_handoff", {
        lease_id: old.lease_id,
        task_id: id("reclaim"),
        handoff_summary: handoff(),
      }),
    ).rejects.toMatchObject({ code: "not_lock_holder" });
  });

  it("menyaring lease kedaluwarsa di session_brief dan get_project_board serta menyimpan worktree_path/base_branch", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const mono = new LocalService(root, { ...config, layout: "monorepo" });
    const { id } = await draft([plan("wt")], mono);
    await manage("approve_plan", id("wt"), {}, mono);

    // Path mengandung pola mirip token agar teruji tidak tersensor oleh scrubber.
    const worktreePath = `/tmp/worktrees/wt-${testSecret}`;
    const sessionId = randomUUID();
    await mono.callTool("claim_task", {
      task_id: id("wt"),
      worktree: {
        session_id: sessionId,
        branch: "feat/wt",
        worktree_path: worktreePath,
        base_branch: "main",
      },
    });

    const storedLease = readTaskJsonField(
      mono.stateFile,
      config.project_id,
      id("wt"),
      "lease_json",
    );
    expect(storedLease?.worktree).toEqual({
      session: sessionId,
      worktree_path: worktreePath,
      base_branch: "main",
    });

    const activeBrief = await mono.callTool("session_brief", {});
    expect(activeBrief.lines.filter((line) => line.kind === "worktree")).toMatchObject([
      {
        task_id: id("wt"),
        text: expect.stringContaining(`feat/wt (base=main) · path=${worktreePath}`),
      },
    ]);
    expect(await mono.callTool("get_project_board", {})).toMatchObject({
      tasks: [{ id: id("wt"), locked_by_repo: "be" }],
    });

    // Setelah lease kedaluwarsa, tidak muncul di activeWorktrees atau locked_by_repo.
    clock.mockReturnValue(start + LOCK_LEASE_MS + 1);
    const expiredBrief = await mono.callTool("session_brief", {});
    expect(expiredBrief.lines.filter((line) => line.kind === "worktree")).toEqual([]);
    expect(await mono.callTool("get_project_board", {})).toMatchObject({
      tasks: [{ id: id("wt"), status: "IN_PROGRESS", locked_by_repo: null }],
    });
  });

  it("allows another claim to commit while session_brief awaits its worktree hint", async () => {
    const mono = new LocalService(root, { ...config, layout: "monorepo" });
    const { id } = await draft([plan("first"), plan("second"), plan("parallel")], mono);
    const claim = (ref: string, client = mono) =>
      client.callTool("claim_task", {
        task_id: id(ref),
        worktree: { session_id: randomUUID(), branch: `feat/${ref}` },
      });
    for (const ref of ["first", "second", "parallel"]) {
      await manage("approve_plan", id(ref), {}, mono);
    }
    await claim("first");
    await claim("second");

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finish!: (overlaps: worktreeStatus.WorktreeFileOverlap[]) => void;
    const pendingHint = new Promise<worktreeStatus.WorktreeFileOverlap[]>((resolve) => {
      finish = resolve;
    });
    const scanner = vi.spyOn(worktreeStatus, "readWorktreeOverlapHint").mockImplementation(() => {
      markStarted();
      return pendingHint;
    });
    const pendingBrief = mono.callTool("session_brief", {});
    try {
      await Promise.race([
        started,
        pendingBrief.then(() => {
          throw new Error("Brief returned before the scanner started");
        }),
      ]);
      await expect(access(`${mono.stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(scanner).toHaveBeenCalledWith(root, [
        {
          task_id: id("first"),
          branch: "feat/first",
          baseBranch: null,
          persona: null,
          worktreePaths: [],
        },
        {
          task_id: id("second"),
          branch: "feat/second",
          baseBranch: null,
          persona: null,
          worktreePaths: [],
        },
      ]);
      const other = new LocalService(root, { ...config, layout: "monorepo" });
      await expect(claim("parallel", other)).resolves.toMatchObject({
        task: { id: id("parallel"), status: "IN_PROGRESS" },
      });
    } finally {
      finish([{ file: "shared.ts", worktrees: ["first", "second"] }]);
      await pendingBrief;
    }
    expect(await pendingBrief).toMatchObject({
      ready_count: 1,
      hints: [expect.stringContaining("Worktree file overlap detected (1): shared.ts")],
    });

    scanner.mockRejectedValue(new Error("Git unavailable"));
    const failedHint = await mono.callTool("session_brief", {});
    expect(failedHint.ready_count).toBe(0);
    expect(failedHint.hints).toBeUndefined();
  });

  it("mengisi integrated_commit pada dependency handoff bila tersedia di state dan memigrasikan DB lama", async () => {
    const { id } = await draft([plan("up"), plan("down", { depends_on: ["up"] })]);
    await manage("approve_plan", id("up"));
    await manage("approve_plan", id("down"));
    const claim = await service.callTool("claim_task", { task_id: id("up") });
    await service.callTool("complete_handoff", {
      lease_id: claim.lease_id,
      task_id: id("up"),
      handoff_summary: handoff(),
    });
    await manage("approve", id("up"));

    const integrated = { branch: "main", sha: heads.next };
    const db = new DatabaseSync(service.stateFile);
    try {
      db.prepare("UPDATE tasks SET integrated_commit_json = ? WHERE project_id = ? AND id = ?").run(
        JSON.stringify(integrated),
        config.project_id,
        id("up"),
      );
    } finally {
      db.close();
    }

    const context = await service.callTool("get_project_context", {});
    expect(context.recent_handoffs).toMatchObject([
      { task_id: id("up"), integrated_commit: integrated },
    ]);
    const downClaim = await service.callTool("claim_task", { task_id: id("down") });
    expect(downClaim.dependencies).toMatchObject([
      { task_id: id("up"), integrated_commit: integrated },
    ]);
    await service.callTool("release_task", { task_id: id("down"), lease_id: downClaim.lease_id });

    // Revisi menghapus integrated_commit lama agar tidak usang.
    await manage("request_revision", id("up"), { feedback: "Perlu perbaikan kontrak." });
    expect(
      readTaskJsonField(service.stateFile, config.project_id, id("up"), "integrated_commit_json"),
    ).toBeUndefined();
  });
});

describe("LocalService reviews and context", () => {
  it("records PR review locally, refuses stale lease/SHA and never asserts remote merge", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
    await service.callTool("upsert_persona", { alias: "qori", role: "reviewer", repos: ["be"] });
    await service.callTool("upsert_persona", {
      alias: "reviewer-two",
      role: "reviewer",
      repos: ["be"],
    });
    const { id } = await draft([plan("pr")]);
    const task_id = id("pr");
    const agent = new LocalService(root, config, "agent");
    const review = (request: Record<string, unknown>) =>
      agent.callTool("review_pull_request", { request: { task_id, ...request } });
    const pr = {
      url: "https://github.com/example/repo/pull/42",
      head_sha: heads.current,
      base_branch: "main",
    };
    await manage("approve_plan", task_id);
    const { lease_id: qoriLease } = await service.callTool("claim_task", {
      task_id,
      agent_alias: "qori",
    });
    await service.callTool("complete_handoff", {
      lease_id: qoriLease,
      task_id,
      handoff_summary: handoff({ pull_request: pr }),
    });
    expect(await review({ action: "list" })).toMatchObject({
      reviews: [{ task_id, review: { stage: "awaiting_review", merge_sha: null } }],
    });
    await expect(review({ action: "claim", agent_alias: "qori" })).rejects.toMatchObject({
      code: "self_review",
    });
    const first = await review({ action: "claim", agent_alias: "reviewer-two" });
    expect(first).toMatchObject({
      review: { stage: "in_review", reviewer: "reviewer-two" },
      notice: expect.any(String),
    });
    expect(first).not.toHaveProperty("warning");
    if (!("lease_id" in first)) throw new Error("Missing review lease");
    expect(await review({ action: "claim" })).not.toHaveProperty("lease_id");
    expect(
      await review({
        action: "submit",
        lease_id: first.lease_id,
        head_sha: heads.next,
        decision: "approve",
        feedback: "Looks good",
      }),
    ).toHaveProperty("warning");
    clock.mockReturnValue(start + LOCK_LEASE_MS);
    expect(
      await review({
        action: "submit",
        lease_id: first.lease_id,
        head_sha: heads.current,
        decision: "approve",
        feedback: "Looks good",
      }),
    ).toHaveProperty("warning");
    const second = await review({ action: "claim", agent_alias: "reviewer-two" });
    if (!("lease_id" in second)) throw new Error("Missing replacement review lease");
    expect(
      await review({
        action: "submit",
        lease_id: second.lease_id,
        head_sha: heads.current,
        decision: "request_changes",
        feedback: "Add edge case coverage.",
      }),
    ).toMatchObject({ status: "REVISION_REQUESTED", review: { stage: "changes_requested" } });
    const revisionClaim = await service.callTool("claim_task", { task_id });
    expect(revisionClaim).toMatchObject({
      revision: { review_feedback: "Add edge case coverage." },
    });
    await service.callTool("complete_handoff", {
      lease_id: revisionClaim.lease_id,
      task_id,
      handoff_summary: handoff({
        pull_request: { ...pr, head_sha: heads.next },
        last_commit_hash: heads.next,
      }),
    });
    const third = await review({ action: "claim", agent_alias: "reviewer-two" });
    if (!("lease_id" in third)) throw new Error("Missing next-head review lease");
    expect(
      await review({
        action: "submit",
        lease_id: third.lease_id,
        head_sha: heads.next,
        decision: "approve",
        feedback: "Looks good",
      }),
    ).toMatchObject({ status: "NEEDS_REVIEW", review: { stage: "awaiting_human_approval" } });
    expect(await service.readTaskEvents({ taskId: task_id, event: "approve" })).toEqual([]);
    expect(await manage("approve", task_id)).toMatchObject({ status: "DONE" });
    expect(await review({ action: "refresh" })).toMatchObject({
      status: "DONE",
      notice: expect.stringContaining("tidak diperiksa"),
      review: { stage: "approved_locally", merge_sha: null, head_sha: heads.next },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports complete_handoff and review_pull_request with pull_request without url for local review", async () => {
    await service.callTool("upsert_persona", { alias: "dev", role: "backend", repos: ["be"] });
    await service.callTool("upsert_persona", { alias: "rev", role: "reviewer", repos: ["be"] });
    const { id } = await draft([plan("local-rev")]);
    const task_id = id("local-rev");
    await manage("approve_plan", task_id);
    const { lease_id } = await service.callTool("claim_task", { task_id, agent_alias: "dev" });

    const done = await service.callTool("complete_handoff", {
      lease_id,
      task_id,
      handoff_summary: handoff({
        pull_request: { base_branch: "main", head_sha: heads.current },
      }),
    });
    expect(done).toMatchObject({
      status: "NEEDS_REVIEW",
      next_step_hint: expect.stringContaining("Review lokal"),
    });

    const listed = await service.callTool("review_pull_request", { request: { action: "list" } });
    expect(listed).toMatchObject({
      reviews: [
        {
          task_id,
          status: "NEEDS_REVIEW",
          review: {
            base_branch: "main",
            head_sha: heads.current,
            stage: "awaiting_review",
            merge_sha: null,
          },
        },
      ],
    });
    if ("reviews" in listed) {
      expect(listed.reviews[0]?.review.url).toBeUndefined();
    }

    const claimed = await service.callTool("review_pull_request", {
      request: { action: "claim", task_id, agent_alias: "rev" },
    });
    if (!("lease_id" in claimed) || !claimed.lease_id) throw new Error("Missing review lease");

    const submitted = await service.callTool("review_pull_request", {
      request: {
        action: "submit",
        task_id,
        lease_id: claimed.lease_id,
        head_sha: heads.current,
        decision: "approve",
        feedback: "Local review approved.",
      },
    });
    expect(submitted).toMatchObject({
      status: "NEEDS_REVIEW",
      review: { stage: "awaiting_human_approval", head_sha: heads.current },
    });
  });

  it("searches versioned project documents, tasks and local skill index without remote services", async () => {
    const doc = {
      slug: "design",
      kind: "architecture",
      title: "Quota Design",
      content: `Quota applies to every request. ${testSecret}`,
    };
    expect(await service.callTool("save_document", { ...doc, expected_version: 0 })).toMatchObject({
      created: true,
      document: { version: 1 },
    });
    await expect(service.callTool("save_document", doc)).rejects.toMatchObject({
      code: "document_version_conflict",
      details: { current_version: 1 },
    });
    const result = await Promise.allSettled([
      service.callTool("save_document", {
        ...doc,
        expected_version: 1,
        content: `${doc.content} Updated.`,
      }),
      new LocalService(root, config).callTool("save_document", {
        ...doc,
        expected_version: 1,
        content: `${doc.content} Alternative.`,
      }),
    ]);
    expect(result.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    await service.callTool("save_repo_skill", {
      name: "limits",
      when_to_use: "Quota and rate limit checks",
      content: "Run pnpm test.",
    });
    expect(await service.callTool("load_skill", { name: "limits" })).toMatchObject({
      name: "limits",
      content: "Run pnpm test.",
    });
    await draft([
      plan("quota", { title: "Quota response", prompt_instruction: "Implement quota response." }),
    ]);
    const restarted = new LocalService(root, config);
    expect(await restarted.callTool("get_document", { slug: doc.slug })).toMatchObject({
      version: 2,
      content: expect.stringContaining("[REDACTED:github_token]"),
    });
    const { hits } = await restarted.callTool("search_context", { query: "quota" });
    expect(hits.map(({ source }) => source).sort()).toEqual(["document", "skill", "task"]);
    expect(
      await restarted.callTool("search_context", { query: "quota", sources: ["skill"], limit: 1 }),
    ).toMatchObject({ hits: [{ ref: "be:limits" }], reranked: false });
    expect(await restarted.callTool("get_project_context", {})).toMatchObject({
      project: { name: "Offline" },
      documents: [{ slug: doc.slug, version: 2 }],
      skills: [{ name: "limits" }],
    });
    expect(await restarted.callTool("list_epics", {})).toMatchObject({
      epics: [{ title: "Delivery", task_counts: { DRAFT: 1 } }],
    });
    const foreign = await repo("fe", randomUUID());
    expect(await foreign.callTool("search_context", { query: "quota" })).toMatchObject({
      hits: [],
    });
    await expect(foreign.callTool("get_document", { slug: doc.slug })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("archives and restores documents with default visibility excluding archived in context and search", async () => {
    const content = "# Quota\n\nArchive me.";
    await service.callTool("save_document", {
      slug: "quota-archive",
      title: "Quota Archive",
      kind: "decision",
      content,
      expected_version: 0,
    });
    const archived = await service.callTool("archive_document", { slug: "quota-archive" });
    expect(archived.document.archived_at).toEqual(expect.any(String));
    expect(archived.document.version).toBe(2);

    expect(await service.callTool("get_project_context", {})).toMatchObject({ documents: [] });
    const withArchived = await service.callTool("get_project_context", {
      include_archived: true,
    });
    expect(withArchived.documents.map((d) => d.slug)).toEqual(["quota-archive"]);

    expect(
      await service.callTool("search_context", {
        query: "archive",
        sources: ["document"],
      }),
    ).toMatchObject({ hits: [] });
    const searchAll = await service.callTool("search_context", {
      query: "archive",
      sources: ["document"],
      include_archived: true,
    });
    expect(searchAll.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "document", ref: "quota-archive" }),
      ]),
    );

    const outline = await service.callTool("get_document", {
      slug: "quota-archive",
      outline_only: true,
    });
    expect(outline.outline).toEqual([{ level: 1, title: "Quota", line: 1 }]);
    const section = await service.callTool("get_document", {
      slug: "quota-archive",
      section: "Quota",
    });
    expect(section.section).toBe("Quota");
    expect(section.content).toContain("Archive me.");

    await expect(
      service.callTool("archive_document", { slug: "quota-archive" }),
    ).rejects.toMatchObject({ code: "already_archived" });

    const restored = await service.callTool("restore_document", { slug: "quota-archive" });
    expect(restored.document.archived_at).toBeNull();
    expect(await new LocalService(root, config).callTool("get_project_context", {})).toMatchObject({
      documents: [expect.objectContaining({ slug: "quota-archive", archived_at: null })],
    });

    await expect(
      service.callTool("restore_document", { slug: "quota-archive" }),
    ).rejects.toMatchObject({ code: "not_archived" });
  });

  it("exposes code source in search_context and workspace_roots summary in session_brief and get_project_context", async () => {
    const extDir = await mkdtemp(join(tmpdir(), "catenext-ext-root-"));
    try {
      await service.callTool("upsert_persona", { alias: "fe", role: "frontend" });
      await service.callTool("manage_roots", {
        action: "add",
        path: extDir,
        persona: "fe",
        label: "web-app",
      });
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src/billing.ts"),
        "export function calculateQuotaTier() { return 'pro'; }\n",
      );
      await mkdir(join(extDir, "pages"), { recursive: true });
      await writeFile(
        join(extDir, "pages/billing.tsx"),
        "export function QuotaTierBadge() { return null; }\n",
      );

      const codeSearch = await service.callTool("search_context", {
        query: "QuotaTier",
        sources: ["code"],
        limit: 5,
      });
      expect(codeSearch.degraded).toBe(false);
      expect(codeSearch.hits.map((h) => h.ref).sort()).toEqual([
        "@web-app/pages/billing.tsx",
        "src/billing.ts",
      ]);

      const brief = await service.callTool("session_brief", {});
      expect(brief.workspace_roots).toMatchObject([
        { path: extDir, owner_persona: "fe", label: "web-app" },
      ]);
      expect(brief.lines.some((l) => l.kind === "info" && l.text.includes("web-app(fe)"))).toBe(
        true,
      );

      const ctx = await service.callTool("get_project_context", {});
      expect(ctx.workspace_roots).toMatchObject([
        { path: extDir, owner_persona: "fe", label: "web-app" },
      ]);
    } finally {
      await rm(extDir, { recursive: true, force: true });
    }
  });
});

describe("LocalService state persistence", () => {
  it("serializes independent processes and persists winning task claim after restart", async () => {
    const { id } = await draft([plan("a"), plan("b")]);
    for (const ref of ["a", "b"]) await manage("approve_plan", id(ref));
    const modulePath = new URL("./local-service.ts", import.meta.url).href;
    const script = `
      import { LocalService } from ${JSON.stringify(modulePath)};
      const local = new LocalService(${JSON.stringify(root)}, ${JSON.stringify(config)});
      const args = process.argv.slice(1);
      try {
        const out = await local.callTool(args[0], JSON.parse(args[1]));
        console.log(JSON.stringify({ ok: true, out }));
      } catch (err) { console.log(JSON.stringify({ ok: false, code: err.code })); }
    `;
    const run = async (name: string, input: unknown) => {
      const { stdout } = await exec(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script, name, JSON.stringify(input)],
        { cwd: fileURLToPath(new URL("..", import.meta.url)) },
      );
      return JSON.parse(stdout);
    };
    const outcomes = await Promise.all([
      run("claim_task", { task_id: id("a") }),
      run("claim_task", { task_id: id("b") }),
      run("create_epic", { title: "Parallel epic A" }),
      run("create_epic", { title: "Parallel epic B" }),
    ]);
    expect(outcomes.slice(0, 2)).toContainEqual({ ok: false, code: "repo_busy" });
    expect(outcomes.slice(0, 2).filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.slice(2).every((result) => result.ok)).toBe(true);
    const { out } = await run("get_project_board", {});
    expect(
      out.tasks.filter((task: { status: string }) => task.status === "IN_PROGRESS"),
    ).toHaveLength(1);
    expect(out.epics.map((epic: { title: string }) => epic.title).sort()).toEqual([
      "Delivery",
      "Parallel epic A",
      "Parallel epic B",
    ]);
  }, 20_000);

  it.each([
    "{bad json",
    '{"version":42,"projects":{}}',
    '{"version":1,"projects":{"bad":{"tasks":[]}}}',
  ])("refuses corrupt/unknown state without changing bytes: %s", async (contents) => {
    await mkdir(dirname(service.stateFile), { recursive: true });
    await writeFile(service.stateFile, contents);
    await expect(
      service.callTool("create_epic", { title: "Must not overwrite" }),
    ).rejects.toMatchObject({ code: "corrupt_state" });
    expect(await readFile(service.stateFile, "utf8")).toBe(contents);
  });

  it("records task_events across task lifecycle transitions and rolls back on failure", async () => {
    let now = start;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 1000;
      return now;
    });

    await service.callTool("upsert_persona", { alias: "be", role: "backend" });
    const { id } = await draft([plan("alpha"), plan("beta")]);

    await manage("assign", id("alpha"), { agent_alias: "be" });
    await manage("approve_plan", id("alpha"));
    await manage("approve_plan", id("beta"));

    const firstClaim = await service.callTool("claim_task", {
      task_id: id("alpha"),
      agent_alias: "be",
      worktree: { session_id: randomUUID(), branch: "feat/alpha" },
    });
    await service.callTool("release_task", {
      task_id: id("alpha"),
      lease_id: firstClaim.lease_id,
    });

    const secondClaim = await service.callTool("claim_task", {
      task_id: id("alpha"),
      agent_alias: "be",
      worktree: { session_id: randomUUID(), branch: "feat/alpha" },
    });
    await service.callTool("report_blocker", {
      task_id: id("alpha"),
      lease_id: secondClaim.lease_id,
      category: "dependency_issue",
      reason: "Waiting for schema",
    });
    await manage("unblock", id("alpha"));

    const thirdClaim = await service.callTool("claim_task", {
      task_id: id("alpha"),
      agent_alias: "be",
      worktree: { session_id: randomUUID(), branch: "feat/alpha" },
    });
    // Failed handoff (branch_mismatch) must not emit a handoff event
    await expect(
      service.callTool("complete_handoff", {
        task_id: id("alpha"),
        lease_id: thirdClaim.lease_id,
        handoff_summary: handoff({ git_branch: "wrong/branch" }),
      }),
    ).rejects.toMatchObject({ code: "branch_mismatch" });

    await service.callTool("complete_handoff", {
      task_id: id("alpha"),
      lease_id: thirdClaim.lease_id,
      handoff_summary: handoff({ git_branch: "feat/alpha" }),
    });
    await manage("request_revision", id("alpha"), { feedback: "Add index test" });

    const fourthClaim = await service.callTool("claim_task", {
      task_id: id("alpha"),
      agent_alias: "be",
      worktree: { session_id: randomUUID(), branch: "feat/alpha" },
    });
    await service.callTool("complete_handoff", {
      task_id: id("alpha"),
      lease_id: fourthClaim.lease_id,
      handoff_summary: handoff({ git_branch: "feat/alpha" }),
    });
    await manage("approve", id("alpha"));

    // Claim beta and let lease expire so lease_expired is recorded when reclaimed
    await service.callTool("claim_task", { task_id: id("beta"), agent_alias: "be" });
    now += LOCK_LEASE_MS + 5_000;
    await service.callTool("claim_task", { task_id: id("beta"), agent_alias: "be" });

    const alphaEvents = await service.readTaskEvents({ taskId: id("alpha"), limit: 50 });
    expect(alphaEvents.map((e) => e.event)).toEqual([
      "approve",
      "handoff",
      "claim",
      "revision",
      "handoff",
      "claim",
      "unblock",
      "blocker",
      "claim",
      "release",
      "claim",
      "approve_plan",
      "assign",
    ]);
    expect(alphaEvents[0]).toMatchObject({
      task_id: id("alpha"),
      task_title: "Task alpha",
      actor: "human",
      detail: { from: "NEEDS_REVIEW", to: "DONE" },
    });
    expect(alphaEvents.find((e) => e.event === "blocker")).toMatchObject({
      actor: "be",
      note: "[dependency_issue] Waiting for schema",
    });

    const betaEvents = await service.readTaskEvents({ taskId: id("beta"), limit: 10 });
    expect(betaEvents.map((e) => e.event)).toEqual([
      "claim",
      "lease_expired",
      "claim",
      "approve_plan",
    ]);

    const limited = await new LocalService(root, config).readTaskEvents({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("exposes session_prefs.locale in session_brief and get_project_context when configured", async () => {
    const beforeBrief = await service.callTool("session_brief", {});
    const beforeCtx = await service.callTool("get_project_context", {});
    expect(beforeBrief.locale).toBeUndefined();
    expect(beforeCtx.locale).toBeUndefined();

    await service.ensureSeed({ locale: "id" });

    const afterBrief = await service.callTool("session_brief", {});
    const afterCtx = await service.callTool("get_project_context", {});
    expect(afterBrief.locale).toBe("id");
    expect(afterCtx.locale).toBe("id");
  });

  it("supports updateEpic, updateTask, setTaskDependencies, and cancelTask with DAG/safety/agent checks", async () => {
    await service.callTool("upsert_persona", { alias: "be", role: "backend", repos: ["be"] });
    await service.callTool("upsert_persona", { alias: "fe", role: "frontend", repos: ["fe"] });
    const { epic, id } = await draft([plan("a"), plan("b", { depends_on: ["a"] }), plan("c")]);

    const updatedEpic = await service.updateEpic(epic.id, {
      title: "Delivery v2",
      description: "Updated scope",
    });
    expect(updatedEpic.title).toBe("Delivery v2");
    expect(updatedEpic.description).toBe("Updated scope");
    expect(updatedEpic.task_counts).toEqual({ DRAFT: 3 });

    // Trigger stale=true on b via complete -> approve -> request_revision on a
    await manage("approve_plan", id("a"));
    await manage("approve_plan", id("b"));
    const claimA = await service.callTool("claim_task", { task_id: id("a") });
    await service.callTool("complete_handoff", {
      task_id: id("a"),
      lease_id: claimA.lease_id,
      handoff_summary: handoff(),
    });
    await manage("approve", id("a"));
    const claimB = await service.callTool("claim_task", { task_id: id("b") });
    await service.callTool("complete_handoff", {
      task_id: id("b"),
      lease_id: claimB.lease_id,
      handoff_summary: handoff(),
    });
    await manage("request_revision", id("a"), { feedback: "Need extra test coverage" });

    const boardStale = await service.callTool("get_project_board", {});
    expect(boardStale.tasks.find((t) => t.id === id("b"))?.is_stale).toBe(true);

    // Update task b: clear stale, change title, prompt, persona, requires_approval
    const updatedB = await service.updateTask(id("b"), {
      title: "Task b updated",
      prompt_instruction: "Updated instructions",
      persona: "be",
      requires_approval: true,
      is_stale: false,
    });
    expect(updatedB.title).toBe("Task b updated");
    expect(updatedB.instruction).toBe("Updated instructions");
    expect(updatedB.persona).toBe("be");
    expect(updatedB.role).toBe("backend");
    expect(updatedB.requiresApproval).toBe(true);
    expect(updatedB.stale).toBe(false);

    // Reject persona/repo mismatch
    await expect(
      service.updateTask(id("c"), { target_repo: "be", persona: "fe" }),
    ).rejects.toMatchObject({ code: "persona_repo_mismatch" });

    // setTaskDependencies: reject missing dep and cycle, allow valid DAG change
    await expect(
      service.setTaskDependencies(id("c"), { depends_on: [randomUUID()] }),
    ).rejects.toMatchObject({ code: "dependency_not_found" });
    await expect(
      service.setTaskDependencies(id("a"), { depends_on: [id("b")] }),
    ).rejects.toMatchObject({ code: "dependency_cycle" });

    const depsC = await service.setTaskDependencies(id("c"), { depends_on: [id("a")] });
    expect(depsC.depends_on).toEqual([id("a")]);

    // cancelTask: block when other tasks depend on it, block when IN_PROGRESS
    await expect(service.cancelTask(id("a"))).rejects.toMatchObject({ code: "has_dependents" });

    await manage("approve_plan", id("c"));
    await service.setTaskDependencies(id("c"), { depends_on: [] });
    await service.callTool("claim_task", { task_id: id("c") });
    await expect(service.cancelTask(id("c"))).rejects.toMatchObject({ code: "task_locked" });

    // Cancel task b (NEEDS_REVIEW, no dependents)
    const cancelledB = await service.cancelTask(id("b"));
    expect(cancelledB).toEqual({
      task_id: id("b"),
      title: "Task b updated",
      previous_status: "NEEDS_REVIEW",
      cancelled: true,
    });

    const boardAfter = await service.callTool("get_project_board", {});
    expect(boardAfter.tasks.some((t) => t.id === id("b"))).toBe(false);

    // Audit events recorded for update, set_dependencies, cancel
    const bEvents = await service.readTaskEvents({ taskId: id("b"), limit: 10 });
    expect(bEvents.map((e) => e.event)).toContain("update");
    expect(bEvents.map((e) => e.event)).toContain("cancel");
    const cEvents = await service.readTaskEvents({ taskId: id("c"), limit: 10 });
    expect(cEvents.map((e) => e.event)).toContain("set_dependencies");

    // Agent caller is denied CRUD mutations
    const agent = new LocalService(root, config, "agent");
    for (const [name, args] of [
      ["update_epic", { epic_id: epic.id, title: "X" }],
      ["update_task", { task_id: id("a"), title: "X" }],
      ["cancel_task", { task_id: id("a") }],
      ["set_dependencies", { task_id: id("a"), depends_on: [] }],
    ] as const) {
      await expect(
        agent.callTool(name, { ...args, allowCrud: true, caller: "human" }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    }
    await expect(agent.updateEpic(epic.id, { title: "X" })).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(agent.updateTask(id("a"), { title: "X" })).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(agent.cancelTask(id("a"))).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(agent.setTaskDependencies(id("a"), { depends_on: [] })).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("persists positions through reopening and uses insertion order for ties", async () => {
    const { epic, id } = await draft([plan("a"), plan("b"), plan("c")]);
    const agent = new LocalService(root, config, "agent", { allowCrud: true });
    expect(
      await agent.callTool("update_task", { task_id: id("c"), position: -0.25 }),
    ).toMatchObject({ position: -0.25 });
    expect(await service.updateTask(id("b"), { position: 0 })).toMatchObject({ position: 0 });
    const reopened = new LocalService(root, config);
    const board = await reopened.callTool("get_project_board", {});
    expect(board.tasks.map((task) => task.id)).toEqual([id("c"), id("a"), id("b")]);
    expect(await reopened.updateTask(id("c"), {})).toMatchObject({ position: -0.25 });
    const { created } = await reopened.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [plan("d")],
    });
    const appended = await reopened.callTool("get_project_board", {});
    expect(appended.tasks.map((task) => task.id)).toEqual([
      id("c"),
      id("a"),
      id("b"),
      created[0]?.task_id,
    ]);
    expect(await reopened.readTaskEvents({ taskId: id("c") })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "update",
          actor: "agent",
          detail: { fields: ["position"] },
        }),
      ]),
    );
  });

  it("resolves discoverable persona IDs only in their project and validates alias, repo and null", async () => {
    const be = { alias: "be", role: "backend", repos: ["be"] };
    await service.callTool("upsert_persona", be);
    await service.callTool("upsert_persona", { alias: "fe", role: "frontend", repos: ["fe"] });
    const other = await repo("be", randomUUID());
    await other.callTool("upsert_persona", be);
    const { personas } = await service.callTool("list_personas", {});
    const ownId = personas.find((persona) => persona.alias === "be")?.id;
    const feId = personas.find((persona) => persona.alias === "fe")?.id;
    const foreignId = (await other.callTool("list_personas", {})).personas.find(
      (persona) => persona.alias === "be",
    )?.id;
    if (!ownId || !feId || !foreignId) throw new Error("Persona IDs missing from test fixture");
    expect(ownId).not.toBe(foreignId);
    expect(ownId).toMatch(/^[0-9a-f-]{14}5[0-9a-f-]{21}$/);
    const { id } = await draft([plan("a", { target_repo: "be" })]);
    const task = id("a");
    const agent = new LocalService(root, config, "agent", { allowCrud: true });
    expect(
      await agent.callTool("update_task", { task_id: task, persona_id: ownId.toUpperCase() }),
    ).toMatchObject({ persona: "be", persona_id: ownId, role: "backend" });
    expect(
      await agent.callTool("update_task", { task_id: task, persona: "be", persona_id: ownId }),
    ).toMatchObject({ persona: "be" });
    for (const persona_id of [foreignId, randomUUID()]) {
      await expect(service.updateTask(task, { persona_id })).rejects.toMatchObject({
        code: "persona_not_found",
      });
    }
    await expect(
      service.updateTask(task, { persona: "fe", persona_id: ownId }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      service.updateTask(task, { persona: null, persona_id: ownId }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(service.updateTask(task, { persona_id: feId })).rejects.toMatchObject({
      code: "persona_repo_mismatch",
    });
    const reopened = new LocalService(root, config);
    expect((await reopened.callTool("list_personas", {})).personas).toEqual(personas);
    expect(await reopened.updateTask(task, {})).toMatchObject({ persona: "be" });
    expect(await agent.callTool("update_task", { task_id: task, persona_id: null })).toMatchObject({
      persona: null,
      persona_id: null,
      role: "backend",
    });
    await reopened.updateTask(task, { persona_id: ownId });
    expect(await reopened.updateTask(task, { persona: null })).toMatchObject({
      persona: null,
      role: "backend",
    });
    expect(await reopened.updateTask(task, { persona: null, persona_id: null })).toMatchObject({
      persona: null,
    });
  });

  it("preserves literal trailing hashes in outlines and exact section lookups", async () => {
    await service.callTool("save_document", {
      slug: "language-guide",
      title: "Language Guide",
      kind: "architecture",
      content: [
        "## C# setup",
        "Setup details.",
        "## C#",
        "Language details.",
        "## F# ###  ",
        "More details.",
        "## Usage ###",
        "## Notes##",
      ].join("\n"),
    });

    const outline = await service.callTool("get_document", {
      slug: "language-guide",
      outline_only: true,
    });
    expect(outline.outline).toEqual([
      { level: 2, title: "C# setup", line: 1 },
      { level: 2, title: "C#", line: 3 },
      { level: 2, title: "F#", line: 5 },
      { level: 2, title: "Usage", line: 7 },
      { level: 2, title: "Notes##", line: 8 },
    ]);

    await expect(
      service.callTool("get_document", { slug: "language-guide", section: "C#" }),
    ).resolves.toMatchObject({ section: "C#", content: "## C#\nLanguage details." });
    await expect(
      service.callTool("get_document", { slug: "language-guide", section: "F#" }),
    ).resolves.toMatchObject({ section: "F#", content: "## F# ###  \nMore details." });
  });

  it("supports outline_only and section extraction in get_document and compact delta handoffs in claim_task", async () => {
    const markdown = [
      "# Architecture",
      "",
      "High-level overview.",
      "",
      "```md",
      "# Not a real heading",
      "```",
      "",
      "## Auth Flow",
      "",
      "Uses JWT tokens.",
      "",
      "### Refresh Tokens",
      "",
      "Rotate every 7 days.",
      "",
      "## Database",
      "",
      "SQLite WAL mode.",
    ].join("\n");

    await service.callTool("save_document", {
      slug: "arch-doc",
      title: "Architecture",
      kind: "architecture",
      content: markdown,
    });

    const outlineDoc = await service.callTool("get_document", {
      slug: "arch-doc",
      outline_only: true,
    });
    expect(outlineDoc.content).toBe("");
    expect(outlineDoc.truncated).toBe(true);
    expect(outlineDoc.outline).toEqual([
      { level: 1, title: "Architecture", line: 1 },
      { level: 2, title: "Auth Flow", line: 9 },
      { level: 3, title: "Refresh Tokens", line: 13 },
      { level: 2, title: "Database", line: 17 },
    ]);

    const authSection = await service.callTool("get_document", {
      slug: "arch-doc",
      section: "auth flow",
    });
    expect(authSection.section).toBe("Auth Flow");
    expect(authSection.truncated).toBe(true);
    expect(authSection.content).toContain("## Auth Flow");
    expect(authSection.content).toContain("### Refresh Tokens");
    expect(authSection.content).not.toContain("## Database");
    expect(authSection.content.length).toBeLessThan(markdown.length);

    await expect(
      service.callTool("get_document", { slug: "arch-doc", section: "Missing" }),
    ).rejects.toMatchObject({ code: "not_found" });

    // Compact delta handoffs in claim_task vs full default + on-demand lookup via get_project_context
    const { id } = await draft([plan("dep"), plan("main", { depends_on: ["dep"] })]);
    await manage("approve_plan", id("dep"));
    await manage("approve_plan", id("main"));
    const depClaim = await service.callTool("claim_task", { task_id: id("dep") });
    await service.callTool("complete_handoff", {
      task_id: id("dep"),
      lease_id: depClaim.lease_id,
      handoff_summary: handoff({
        files_modified: ["src/auth.ts"],
        key_decisions: ["Use JWT"],
        verification_command: "pnpm test",
        notes_for_next_agent: "Auth middleware ready.",
      }),
    });
    await manage("approve", id("dep"));

    const compactClaim = await service.callTool("claim_task", {
      task_id: id("main"),
      compact: true,
    });
    expect(compactClaim.dependencies).toHaveLength(1);
    expect(compactClaim.dependencies[0]?.handoff_summary).toBeUndefined();
    expect(compactClaim.dependencies[0]?.compact_handoff).toEqual({
      files_modified: ["src/auth.ts"],
      key_decisions: ["Use JWT"],
      notes_for_next_agent: "Auth middleware ready.",
    });

    // On-demand full lookup via get_project_context with active lease_id
    const fullCtx = await service.callTool("get_project_context", {
      lease_id: compactClaim.lease_id,
    });
    expect(fullCtx.recent_handoffs[0]?.handoff_summary).toMatchObject({
      git_branch: "feat/local",
      verification_command: "pnpm test",
    });

    // Backward-compatible default (compact omitted) returns full handoff_summary
    await service.callTool("release_task", {
      task_id: id("main"),
      lease_id: compactClaim.lease_id,
    });
    const fullClaim = await service.callTool("claim_task", { task_id: id("main") });
    expect(fullClaim.dependencies[0]?.handoff_summary).toMatchObject({
      git_branch: "feat/local",
      verification_command: "pnpm test",
    });
    expect(fullClaim.dependencies[0]?.compact_handoff).toBeUndefined();
  });
});

describe("LocalService code graph tools", () => {
  it("supports graph_impact, graph_summary depth 5 / include_tests, and stale hints across all graph tools", async () => {
    await mkdir(join(root, "apps/api/src/v1/users"), { recursive: true });
    await mkdir(join(root, "apps/api/src/v1/routes"), { recursive: true });

    const repoFile = join(root, "apps/api/src/v1/users/repo.ts");
    const serviceFile = join(root, "apps/api/src/v1/users/service.ts");
    const routeFile = join(root, "apps/api/src/v1/routes/users.ts");
    const testFile = join(root, "apps/api/src/v1/users/repo.test.ts");

    await writeFile(repoFile, "export function loadUserRecord() { return { id: 1 }; }\n");
    await writeFile(
      serviceFile,
      `import { loadUserRecord } from "./repo.js";\nexport function getUserProfile() { return loadUserRecord(); }\n`,
    );
    await writeFile(
      routeFile,
      `import { getUserProfile } from "../users/service.js";\nexport function usersRoute() { return getUserProfile(); }\n`,
    );
    await writeFile(
      testFile,
      `import { loadUserRecord } from "./repo.js";\nexport function testLoadUser() { return loadUserRecord(); }\n`,
    );

    // Ensure DB exists before indexing; unindexed graph tools report stale: true (not_indexed).
    await service.callTool("session_brief", {});
    for (const [name, args] of [
      ["graph_neighbors", { path: "apps/api/src/v1/users/repo.ts" }],
      ["symbol_search", { query: "loadUserRecord" }],
      ["graph_summary", {}],
      ["graph_impact", { path: "apps/api/src/v1/users/repo.ts" }],
    ] as const) {
      const unindexed = await service.callTool(name, args);
      expect(unindexed).toMatchObject({ stale: true, stale_reason: "not_indexed" });
    }

    await graphIndex.indexProjectGraph(service.stateFile, config.project_id, root);

    // Fresh index: stale omitted on all 4 tools.
    const neighbors = await service.callTool("graph_neighbors", {
      path: "apps/api/src/v1/users/repo.ts",
    });
    expect(neighbors.stale).toBeUndefined();
    expect(neighbors.edges.length).toBeGreaterThan(0);

    const symbols = await service.callTool("symbol_search", { query: "loadUserRecord" });
    expect(symbols.stale).toBeUndefined();
    expect(symbols.hits).toMatchObject([
      { name: "loadUserRecord", path: "apps/api/src/v1/users/repo.ts" },
    ]);

    // graph_summary depth 5 & include_tests toggle
    const summaryNoTests = await service.callTool("graph_summary", {
      depth: 5,
      include_tests: false,
    });
    expect(summaryNoTests.stale).toBeUndefined();
    expect(summaryNoTests.totals).toEqual({ files: 3, symbols: 3, edges: 2 });
    expect(summaryNoTests.groups.map((g) => g.group).sort()).toEqual([
      "apps/api/src/v1/routes",
      "apps/api/src/v1/users",
    ]);
    expect(summaryNoTests.hubs.map((h) => h.path)).not.toContain(
      "apps/api/src/v1/users/repo.test.ts",
    );

    const summaryWithTests = await service.callTool("graph_summary", {
      depth: 5,
      include_tests: true,
    });
    expect(summaryWithTests.totals).toEqual({ files: 4, symbols: 4, edges: 3 });
    expect(summaryWithTests.hubs.map((h) => h.path)).toContain(
      "apps/api/src/v1/users/repo.test.ts",
    );

    // graph_impact direct + transitive, with include_tests false vs true
    const impactNoTests = await service.callTool("graph_impact", {
      path: "apps/api/src/v1/users/repo.ts",
      depth: 2,
      include_tests: false,
    });
    expect(impactNoTests).toEqual({
      target: "apps/api/src/v1/users/repo.ts",
      indexed: true,
      total_affected: 2,
      truncated: false,
      impacted: [
        {
          path: "apps/api/src/v1/users/service.ts",
          distance: 1,
          kind: "direct",
          symbols_count: 1,
        },
        {
          path: "apps/api/src/v1/routes/users.ts",
          distance: 2,
          kind: "transitive",
          via: "apps/api/src/v1/users/service.ts",
          symbols_count: 1,
        },
      ],
    });

    const impactWithTests = await service.callTool("graph_impact", {
      path: "apps/api/src/v1/users/repo.ts",
      depth: 2,
      include_tests: true,
    });
    expect(impactWithTests.total_affected).toBe(3);
    expect(impactWithTests.impacted.map((h) => h.path)).toContain(
      "apps/api/src/v1/users/repo.test.ts",
    );

    // Modify indexed file with shifted mtime -> all 4 tools report stale: true (modified_files).
    await writeFile(repoFile, "export function loadUserRecord() { return { id: 2 }; }\n");
    const shifted = new Date(Date.now() + 5_000);
    await utimes(repoFile, shifted, shifted);

    for (const [name, args] of [
      ["graph_neighbors", { path: "apps/api/src/v1/users/repo.ts" }],
      ["symbol_search", { query: "loadUserRecord" }],
      ["graph_summary", { depth: 5 }],
      ["graph_impact", { path: "apps/api/src/v1/users/repo.ts" }],
    ] as const) {
      const staleOut = await service.callTool(name, args);
      expect(staleOut).toMatchObject({ stale: true, stale_reason: "modified_files" });
    }
  });

  it("supports batched graph_neighbors, graph_summary prefix, and session_brief stale hints", async () => {
    await mkdir(join(root, "apps/api/src/users"), { recursive: true });
    await mkdir(join(root, "apps/api/src/billing"), { recursive: true });

    const usersRepo = join(root, "apps/api/src/users/repo.ts");
    const usersSvc = join(root, "apps/api/src/users/service.ts");
    const billingSvc = join(root, "apps/api/src/billing/service.ts");

    await writeFile(usersRepo, "export function fetchUser() { return 1; }\n");
    await writeFile(
      usersSvc,
      `import { fetchUser } from "./repo.js";\nexport function userHandler() { return fetchUser(); }\n`,
    );
    await writeFile(billingSvc, "export function charge() { return 2; }\n");

    // Unindexed project: session_brief omits hints.
    const unindexedBrief = await service.callTool("session_brief", {});
    expect(unindexedBrief.hints).toBeUndefined();

    await graphIndex.indexProjectGraph(service.stateFile, config.project_id, root);

    // Clean indexed project: session_brief omits hints.
    const cleanBrief = await service.callTool("session_brief", {});
    expect(cleanBrief.hints).toBeUndefined();

    const batched = await service.callTool("graph_neighbors", {
      paths: ["apps/api/src/users/repo.ts", "apps/api/src/users/service.ts"],
      include_symbols: true,
    });
    expect(batched.files).toEqual([
      {
        path: "apps/api/src/users/repo.ts",
        edges: [
          {
            kind: "imports",
            from: "apps/api/src/users/service.ts",
            to: "apps/api/src/users/repo.ts",
            label: "apps/api/src/users/repo.ts",
          },
        ],
        symbols: ["fetchUser"],
      },
      {
        path: "apps/api/src/users/service.ts",
        edges: [
          {
            kind: "imports",
            from: "apps/api/src/users/service.ts",
            to: "apps/api/src/users/repo.ts",
            label: "apps/api/src/users/repo.ts",
          },
        ],
        symbols: ["userHandler"],
      },
    ]);

    const prefixed = await service.callTool("graph_summary", {
      prefix: "apps/api/src/users",
      depth: 5,
    });
    expect(prefixed.totals).toEqual({ files: 2, symbols: 2, edges: 1 });
    expect(prefixed.hubs.map((h) => h.path)).not.toContain("apps/api/src/billing/service.ts");

    // Stale indexed file -> session_brief emits concise stale graph hint.
    await writeFile(usersRepo, "export function fetchUser() { return 42; }\n");
    const shifted = new Date(Date.now() + 5_000);
    await utimes(usersRepo, shifted, shifted);

    const freshness = vi.spyOn(graphIndex, "checkGraphFreshness");
    const staleBrief = await service.callTool("session_brief", {});
    expect(staleBrief.hints).toEqual([
      expect.stringContaining("Code graph index is stale (modified_files)"),
    ]);
    freshness.mockImplementation(() => {
      throw new Error("Graph unavailable");
    });
    const withoutGraphHint = { ...staleBrief };
    delete withoutGraphHint.hints;
    expect(await service.callTool("session_brief", {})).toEqual(withoutGraphHint);
  });

  it("persists scope_files/verify_command/doc_refs and builds claim_task context_pack when include_context=true", async () => {
    await service.callTool("upsert_persona", {
      alias: "be",
      role: "backend",
      repos: ["be"],
    });
    await service.callTool("save_document", {
      slug: "sync-board",
      title: "Sync Board",
      kind: "other",
      content: [
        "# Sync Board",
        "## DECISIONS",
        "- Keep MCP payloads compact",
        "## OPEN ASKS",
        "- ASK: be · NEED: verify scope_files",
        "## ARCHIVE NOISE",
        "- Unrelated historical log line",
      ].join("\n"),
    });
    await mkdir(join(root, ".catenext/skills"), { recursive: true });
    await writeFile(
      join(root, ".catenext/skills/alpha-unrelated.md"),
      `---\nname: alpha-unrelated\nwhen_to_use: For frontend css tweaks\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n\nUnrelated.\n`,
    );
    await writeFile(
      join(root, ".catenext/skills/be-service.md"),
      `---\nname: be-service\nwhen_to_use: Backend service conventions\nupdated_at: "2026-01-01T00:00:00.000Z"\n---\n\nBackend rules.\n`,
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src/entry.ts"),
      `import { helper } from "./helper.js";\nexport function runEntry() { return helper(); }\n`,
    );
    await writeFile(join(root, "src/helper.ts"), `export function helper() { return 1; }\n`);

    const { epic } = await service.callTool("create_epic", {
      title: "v0.16 Context Pack",
      description: "Single-shot claim context",
    });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [
        plan("t1", {
          persona: "be",
          scope_files: ["src/entry.ts"],
          verify_command: "pnpm --filter catenext test",
          doc_refs: ["be-service", "sync-board"],
        }),
        plan("t2", {
          persona: "be",
          scope_files: ["src/helper.ts"],
        }),
      ],
    });
    const [first, second] = created;
    if (!first || !second) throw new Error("Expected created tasks");
    const t1 = first.task_id;
    const t2 = second.task_id;

    const updatedT2 = await service.updateTask(t2, {
      scope_files: ["src/entry.ts", "src/helper.ts"],
      verify_command: "pnpm lint",
      doc_refs: ["sync-board"],
    });
    expect(updatedT2.scope_files).toEqual(["src/entry.ts", "src/helper.ts"]);
    expect(updatedT2.verify_command).toBe("pnpm lint");
    expect(updatedT2.doc_refs).toEqual(["sync-board"]);

    const events = await service.readTaskEvents({ taskId: t2 });
    expect(events.some((e) => e.event === "update" && e.note?.includes("scope_files"))).toBe(true);

    await manage("approve_plan", t1);
    await manage("approve_plan", t2);
    await graphIndex.indexProjectGraph(service.stateFile, config.project_id, root);

    // Omitted include_context -> no context_pack, but scoping fields on task are returned.
    const plainClaim = await service.callTool("claim_task", {
      task_id: t1,
      agent_alias: "be",
    });
    expect(plainClaim.context_pack).toBeUndefined();
    expect(plainClaim.task).toMatchObject({
      scope_files: ["src/entry.ts"],
      verify_command: "pnpm --filter catenext test",
      doc_refs: ["be-service", "sync-board"],
    });

    await service.callTool("release_task", { task_id: t1, lease_id: plainClaim.lease_id });

    // include_context: true -> returns 1-shot context_pack.
    const richClaim = await service.callTool("claim_task", {
      task_id: t1,
      agent_alias: "be",
      include_context: true,
    });
    expect(richClaim.context_pack).toBeDefined();
    expect(richClaim.context_pack?.epic_summary).toContain("v0.16 Context Pack");
    expect(richClaim.context_pack?.sync_board_excerpt).toContain("DECISIONS");
    expect(richClaim.context_pack?.sync_board_excerpt).toContain("OPEN ASKS");
    expect(richClaim.context_pack?.sync_board_excerpt).not.toContain("Unrelated historical log");
    expect(richClaim.context_pack?.sync_board_excerpt?.length ?? 0).toBeLessThanOrEqual(800);
    expect(richClaim.context_pack?.skills_hint?.[0]).toBe("be-service");
    expect(richClaim.context_pack?.truncated).toBeUndefined();
    expect(richClaim.context_pack?.graph_slice).toEqual([
      {
        path: "src/entry.ts",
        edges: [
          { kind: "imports", from: "src/entry.ts", to: "src/helper.ts", label: "src/helper.ts" },
        ],
        symbols: ["runEntry"],
        symbol_locations: [{ name: "runEntry", line: 2 }],
      },
    ]);

    // Stale index retains graph hints, but not start lines that may have moved.
    await service.callTool("release_task", { task_id: t1, lease_id: richClaim.lease_id });
    const shifted = new Date(Date.now() + 5_000);
    await utimes(join(root, "src/entry.ts"), shifted, shifted);
    const expectedFiles = await service.callTool("graph_neighbors", {
      paths: ["src/entry.ts", "src/helper.ts"],
      include_symbols: true,
    });
    expect(expectedFiles.stale_reason).toBe("modified_files");
    const staleClaim = await service.callTool("claim_task", {
      task_id: t2,
      agent_alias: "be",
      include_context: true,
    });
    expect(staleClaim.context_pack?.graph_slice).toEqual(expectedFiles.files);
    expect(staleClaim.context_pack?.graph_slice).toHaveLength(2);
    for (const file of staleClaim.context_pack?.graph_slice ?? []) {
      expect(file).not.toHaveProperty("symbol_locations");
    }
  });

  it("retains claim graph hints without locations from a removed workspace root", async () => {
    const extRoot = await mkdtemp(join(tmpdir(), "catenext-claim-ext-"));
    try {
      const paths = ["@external/entry.ts", "entry.ts"];
      await service.callTool("upsert_persona", { alias: "be", role: "backend" });
      await service.callTool("manage_roots", { action: "add", path: extRoot, label: "external" });
      await writeFile(join(extRoot, "entry.ts"), "\nexport function externalEntry() {}\n");
      await writeFile(join(root, "entry.ts"), "export function mainEntry() {}\n");
      await graphIndex.indexProjectGraph(service.stateFile, config.project_id, root);

      const batch = await draft([plan("entry", { persona: "be", scope_files: paths })]);
      const taskId = batch.id("entry");
      await manage("approve_plan", taskId);
      const claimInput = { task_id: taskId, agent_alias: "be", include_context: true };
      const legacyInput = { paths, include_symbols: true };
      const externalFile = { path: "@external/entry.ts", edges: [], symbols: ["externalEntry"] };
      const mainFile = { path: "entry.ts", edges: [], symbols: ["mainEntry"] };
      const expectedLegacy = { edges: [], files: [externalFile, mainFile] };
      expect(await service.callTool("graph_neighbors", legacyInput)).toEqual(expectedLegacy);
      const fresh = await service.callTool("claim_task", claimInput);
      const mainWithLocations = {
        ...mainFile,
        symbol_locations: [{ name: "mainEntry", line: 1 }],
      };
      expect(fresh.context_pack?.graph_slice).toEqual([
        { ...externalFile, symbol_locations: [{ name: "externalEntry", line: 2 }] },
        mainWithLocations,
      ]);
      await service.callTool("release_task", { task_id: taskId, lease_id: fresh.lease_id });

      // Keep the indexed row and disk file untouched; only remove its root registration.
      await service.callTool("manage_roots", { action: "remove", path: extRoot });
      expect(await service.callTool("graph_neighbors", legacyInput)).toEqual(expectedLegacy);
      const removed = await service.callTool("claim_task", claimInput);
      expect(removed.context_pack?.graph_slice).toEqual([externalFile, mainWithLocations]);
    } finally {
      await rm(extRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "JSON escaping", heavy: '\u0001"\\'.repeat(450), multibyte: false },
    { name: "multibyte UTF-8", heavy: "界".repeat(1500), multibyte: true },
  ])(
    "drops oversized graph detail with $name before other context",
    async ({ heavy, multibyte }) => {
      const scope = "entry.ts";
      const taskFields = {
        prompt_instruction: "Keep canonical instructions verbatim. 🚀\n".repeat(130),
        scope_files: [scope],
        doc_refs: ["sync-board"],
        verify_command: "pnpm test --filter catenext",
      };
      const excerpt = '## Decisions\n- Keep quote " and backslash \\ and 東京';
      await service.callTool("save_document", {
        slug: "sync-board",
        title: "Sync Board",
        kind: "other",
        content: excerpt,
      });
      const { id } = await draft([plan("bounded", taskFields)]);
      await manage("approve_plan", id("bounded"));
      await writeFile(join(root, scope), "export const entry = 1;\n");
      await graphIndex.indexProjectGraph(service.stateFile, config.project_id, root);
      const graph = [
        { path: scope, edges: [], symbols: [heavy], symbol_locations: [{ name: heavy, line: 1 }] },
      ];
      vi.spyOn(graphIndex, "queryClaimGraphSlice").mockReturnValue(graph);
      const unbounded = {
        epic_summary: "Delivery",
        sync_board_excerpt: excerpt,
        graph_slice: graph,
      };
      const raw = JSON.stringify(unbounded);
      expect(heavy.length).toBeLessThan(4096);
      if (multibyte) expect(raw.length).toBeLessThan(4096);
      else expect(JSON.stringify(heavy).length).toBeGreaterThan(4096);
      expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(4096);

      const claim = await service.callTool("claim_task", {
        task_id: id("bounded"),
        include_context: true,
      });
      expect(claim.task).toMatchObject(taskFields);
      expect(claim.context_pack).toEqual({
        epic_summary: "Delivery",
        sync_board_excerpt: excerpt,
        truncated: true,
      });
      expect(Buffer.byteLength(JSON.stringify(claim.context_pack), "utf8")).toBeLessThanOrEqual(
        4096,
      );
    },
  );

  it("drops only symbol locations when Unicode and truncation metadata fill the byte budget", async () => {
    const scope = "entry.ts";
    const { id } = await draft([plan("locations", { scope_files: [scope] })]);
    await manage("approve_plan", id("locations"));
    await writeFile(join(root, scope), "export function entry() {}\n");
    await graphIndex.indexProjectGraph(service.stateFile, config.project_id, root);

    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
    const legacyFile = { path: scope, edges: [], symbols: ["界".repeat(1250), "entry", ""] };
    const legacyPack = { epic_summary: "Delivery", graph_slice: [legacyFile] };
    const expected = { ...legacyPack, truncated: true };
    legacyFile.symbols[2] = "x".repeat(4096 - bytes(expected));
    expect(bytes(expected)).toBe(4096);

    const graph = [{ ...legacyFile, symbol_locations: [{ name: "entry", line: 1 }] }];
    const unbounded = { ...legacyPack, graph_slice: graph };
    expect(JSON.stringify(unbounded).length).toBeLessThan(4096);
    expect(bytes(unbounded)).toBeGreaterThan(4096);
    vi.spyOn(graphIndex, "queryClaimGraphSlice").mockReturnValue(graph);

    const claim = await service.callTool("claim_task", {
      task_id: id("locations"),
      include_context: true,
    });
    expect(claim.context_pack).toEqual(expected);
    expect(bytes(claim.context_pack)).toBe(4096);
  });

  it("shortens a non-graph excerpt without splitting a code point and counts the marker", async () => {
    const { epic } = await service.callTool("create_epic", {
      title: "Delivery",
      description: "界".repeat(240),
    });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [plan("excerpt")],
    });
    const [task] = created;
    if (!task) throw new Error("Missing task");
    await manage("approve_plan", task.task_id);
    const excerpt = `## Decisions\n${"\u0001\u0002\u0003\u0004🚀".repeat(130)}`;
    expect(excerpt.length).toBeLessThanOrEqual(800);
    expect(Buffer.byteLength(JSON.stringify(excerpt), "utf8")).toBeGreaterThan(3600);
    await service.callTool("save_document", {
      slug: "sync-board",
      title: "Sync Board",
      kind: "other",
      content: excerpt,
    });

    const { context_pack: pack } = await service.callTool("claim_task", {
      task_id: task.task_id,
      include_context: true,
    });
    if (!pack?.sync_board_excerpt) throw new Error("Missing excerpt preview");
    expect(pack.truncated).toBe(true);
    expect(pack.epic_summary).toContain("Delivery: 界");
    const preview = pack.sync_board_excerpt;
    expect(preview.endsWith("…")).toBe(true);
    const prefix = preview.slice(0, -1);
    expect(excerpt.startsWith(prefix)).toBe(true);
    expect(Buffer.from(prefix, "utf8").toString("utf8")).toBe(prefix);
    expect(Buffer.byteLength(JSON.stringify(pack), "utf8")).toBeLessThanOrEqual(4096);
    const next = Array.from(excerpt.slice(prefix.length))[0];
    expect(next).toBeDefined();
    expect(
      Buffer.byteLength(
        JSON.stringify({ ...pack, sync_board_excerpt: `${prefix}${next}…` }),
        "utf8",
      ),
    ).toBeGreaterThan(4096);
  });
});
