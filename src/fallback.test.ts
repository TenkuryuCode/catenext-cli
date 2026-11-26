import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema } from "@catenext/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabaseAt } from "./db/open.js";
import { insertTaskEvents } from "./db/task-events.js";
import {
  buildHandoff,
  permissionGrant,
  permissionList,
  permissionRevoke,
  permissionSet,
  readGitState,
  readOrCreateCliSessionId,
  renderClaim,
  taskClaim,
  taskDone,
  taskLog,
} from "./fallback.js";
import { LocalService } from "./local-service.js";

const GIT = { branch: "feat/login", commit: "abcdef1234567", changedFiles: ["a.ts", "b.ts"] };
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempGitRepo() {
  const rawDir = await mkdtemp(join(tmpdir(), "catenext-fallback-"));
  const dir = await realpath(rawDir);
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  await writeFile(join(dir, ".gitignore"), ".catenext/\n");
  await writeFile(join(dir, "README.md"), "# test\n");
  git("add", ".gitignore", "README.md");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init");
  git("checkout", "-b", "feat/work");
  return { dir, git };
}

describe("fallback CLI", () => {
  const prOpts = {
    notes: "Siap",
    decision: ["Pakai Hono"] as string[],
    file: [] as string[],
    pr: "https://github.com/example/repo/pull/1",
    base: "main",
  };

  it("buildHandoff memakai git lokal bila --file tidak diisi", () => {
    expect(buildHandoff(prOpts, GIT)).toEqual({
      files_modified: ["a.ts", "b.ts"],
      key_decisions: ["Pakai Hono"],
      verification_command: null,
      notes_for_next_agent: "Siap",
      git_branch: "feat/login",
      last_commit_hash: "abcdef1234567",
      pull_request: {
        url: "https://github.com/example/repo/pull/1",
        base_branch: "main",
        head_sha: "abcdef1234567",
      },
    });
  });

  it("buildHandoff mendukung handoff tanpa PR", () => {
    const handoff = buildHandoff({ notes: "Siap", decision: [], file: [] }, GIT);
    expect(handoff).not.toHaveProperty("pull_request");
    expect(handoff.last_commit_hash).toBe(GIT.commit);
  });

  it("buildHandoff menolak tanpa --notes, pasangan --pr/--base yang tidak lengkap, atau di luar git", () => {
    expect(() => buildHandoff({ decision: [], file: [] }, GIT)).toThrow(/--notes/);
    expect(() =>
      buildHandoff({ notes: "x", decision: [], file: [], pr: "https://x/y/z/pull/1" }, GIT),
    ).toThrow(/--pr/);
    expect(() => buildHandoff({ notes: "x", decision: [], file: [], base: "main" }, GIT)).toThrow(
      /--base/,
    );
    expect(() =>
      buildHandoff({ notes: "x", decision: [], file: [] }, { ...GIT, commit: null }),
    ).toThrow(/git/);
  });

  it("renderClaim menampilkan instruksi, revisi, dan handoff dependensi", () => {
    const md = renderClaim({
      task: {
        id: "11111111-2222-4333-8444-555555555555",
        title: "Form login",
        prompt_instruction: "Buat form",
        status: "IN_PROGRESS",
        revision_count: 1,
      },
      lease_id: "99999999-2222-4333-8444-555555555555",
      lease_expires_at: "2026-11-25T06:00:00Z",
      dependencies: [
        {
          task_id: "11111111-2222-4333-8444-555555555556",
          title: "API login",
          handoff_summary: {
            files_modified: ["api.ts"],
            key_decisions: ["JWT"],
            verification_command: "pnpm test",
            notes_for_next_agent: "Endpoint /login siap",
            git_branch: "main",
            last_commit_hash: "abcdef1",
          },
        },
      ],
      revision: { review_feedback: "Tambah validasi email", previous_handoff: null },
      warnings: [],
    });
    expect(md).toContain("# Task: Form login");
    expect(md).toContain("Tambah validasi email");
    expect(md).toContain("Endpoint /login siap");
    expect(md).toContain("catenext done 11111111-2222-4333-8444-555555555555");
    expect(md).toContain("--pr <url> --base <branch>");
    expect(md).toContain("Jangan merge ke default branch");
  });

  it("readOrCreateCliSessionId menyimpan dan memakai ulang UUID di .catenext/cache/cli-session-id", async () => {
    const rawDir = await mkdtemp(join(tmpdir(), "catenext-session-"));
    tempDirs.push(rawDir);
    const first = await readOrCreateCliSessionId(rawDir);
    const second = await readOrCreateCliSessionId(rawDir);
    expect(second).toBe(first);
    const stored = (await readFile(join(rawDir, ".catenext/cache/cli-session-id"), "utf8")).trim();
    expect(stored).toBe(first);

    await writeFile(join(rawDir, ".catenext/cache/cli-session-id"), "not-a-uuid\n");
    const regenerated = await readOrCreateCliSessionId(rawDir);
    expect(regenerated).not.toBe(first);
    expect(await readOrCreateCliSessionId(rawDir)).toBe(regenerated);
  });

  it("taskClaim --worktree mengirim session_id persisten, worktree_path, dan base_branch", async () => {
    const { dir } = await makeTempGitRepo();
    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: "11111111-2222-4333-8444-555555555555",
      repo_name: "be",
      layout: "monorepo",
    });
    const service = new LocalService(dir, config);
    const { epic } = await service.callTool("create_epic", { title: "Worktree" });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [
        { ref: "t1", title: "Task 1", prompt_instruction: "Kerjakan" },
        { ref: "t2", title: "Task 2", prompt_instruction: "Kerjakan lagi" },
      ],
    });
    for (const t of created) {
      await service.callTool("manage_task", { action: "approve_plan", task_id: t.task_id });
    }
    const t1 = created[0]?.task_id;
    const t2 = created[1]?.task_id;
    if (!t1 || !t2) throw new Error("Expected two tasks");

    await expect(taskClaim(service, t1, { base: "main", cwd: dir })).rejects.toThrow(/--worktree/);

    vi.spyOn(console, "log").mockImplementation(() => {});
    await taskClaim(service, t1, { worktree: true, json: true, cwd: dir });
    const sessionId = await readOrCreateCliSessionId(dir);
    const brief = await service.callTool("session_brief", {});
    const wtLine = brief.lines.find((line) => line.kind === "worktree");
    expect(wtLine?.text).toContain("feat/work (base=main)");
    expect(wtLine?.text).toContain(`path=${dir}`);
    expect(wtLine?.text).toContain(`session=${sessionId.slice(0, 8)}`);

    // Klaim kedua dari worktree CLI yang sama memakai session_id yang sama -> session_busy
    await expect(
      taskClaim(service, t2, { worktree: true, base: "develop", cwd: dir }),
    ).rejects.toMatchObject({ code: "session_busy" });
  });

  it("taskDone memperingatkan perubahan yang belum di-commit dari git status --porcelain", async () => {
    const { dir, git } = await makeTempGitRepo();
    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: "11111111-2222-4333-8444-555555555555",
      repo_name: "be",
    });
    const service = new LocalService(dir, config);
    const { epic } = await service.callTool("create_epic", { title: "Done check" });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [{ ref: "t1", title: "Task 1", prompt_instruction: "Kerjakan" }],
    });
    const t1 = created[0]?.task_id;
    if (!t1) throw new Error("Expected task");
    await service.callTool("manage_task", { action: "approve_plan", task_id: t1 });
    const claim = await service.callTool("claim_task", { task_id: t1 });

    // Buat perubahan belum di-commit (untracked + modified)
    await writeFile(join(dir, "README.md"), "# dirty\n");
    await writeFile(join(dir, "extra.ts"), "export const x = 1;\n");
    const dirtyState = await readGitState(dir);
    expect(dirtyState.dirtyFiles).toEqual(expect.arrayContaining(["README.md", "extra.ts"]));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await taskDone(service, t1, {
      notes: "Selesai",
      decision: [],
      file: [],
      lease: claim.lease_id,
      json: true,
      cwd: dir,
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("belum di-commit"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("README.md"));
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({ status: "NEEDS_REVIEW" });

    // Commit semua perubahan -> tidak ada peringatan dirty
    errSpy.mockClear();
    git("add", "README.md", "extra.ts");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "clean");
    const cleanState = await readGitState(dir);
    expect(cleanState.dirtyFiles).toBeUndefined();
  });

  it("taskLog mencetak ringkasan event audit dan mendukung --limit serta --json", async () => {
    const { dir } = await makeTempGitRepo();
    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: "11111111-2222-4333-8444-555555555555",
      repo_name: "be",
    });
    const service = new LocalService(dir, config);
    const { epic } = await service.callTool("create_epic", { title: "Audit" });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [{ ref: "t1", title: "Audit target", prompt_instruction: "Kerjakan" }],
    });
    const t1 = created[0]?.task_id;
    if (!t1) throw new Error("Expected task");
    await service.callTool("manage_task", { action: "approve_plan", task_id: t1 });
    const claim = await service.callTool("claim_task", { task_id: t1 });
    await service.callTool("release_task", { task_id: t1, lease_id: claim.lease_id });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await taskLog(service, t1, { limit: 2, json: true });
    const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
      events: Array<{ event: string; task_id: string }>;
    };
    expect(parsed.events.map((e) => e.event)).toEqual(["release", "claim"]);
    expect(parsed.events.every((e) => e.task_id === t1)).toBe(true);

    logSpy.mockClear();
    await taskLog(service, undefined, { limit: 5 });
    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("release");
    expect(lines[0]).toContain("Audit target");

    logSpy.mockClear();
    await taskLog(service, "99999999-2222-4333-8444-555555555555", {});
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Belum ada event audit"));
  });

  it("filters audit exports and scrubs legacy CSV fields before escaping", async () => {
    const { dir } = await makeTempGitRepo();
    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: "11111111-2222-4333-8444-555555555555",
      repo_name: "be",
    });
    const service = new LocalService(dir, config);
    const { epic } = await service.callTool("create_epic", { title: "Export" });
    const {
      created: [task],
    } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [{ ref: "a", title: "=Audit", prompt_instruction: "Review export" }],
    });
    if (!task) throw new Error("Expected task");
    const taskId = task.task_id;
    const secret = `ghp_${"X".repeat(24)}`;
    const point = "2026-01-02T00:00:00.000Z";
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T00:30:00Z"));
    const event = {
      task_id: taskId,
      event: "handoff",
      actor: "be",
      created_at: point,
      note: `First, "quoted"\r\n${secret}`,
      detail: { nested: [{ password: "fixture", [secret]: "example" }] },
    };
    const db = openDatabaseAt(service.stateFile);
    try {
      insertTaskEvents(db, config.project_id, [
        event,
        { ...event, created_at: "2026-01-01T23:59:59.999Z", note: "too old" },
        { ...event, event: "claim", note: "wrong event" },
        { ...event, actor: "human", note: "wrong actor" },
      ]);
    } finally {
      db.close();
    }

    const query = { event: "handoff", actor: "be", limit: 1 };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await taskLog(service, taskId, { ...query, since: "2026-01-02T01:00:00+01:00", json: true });
    const expectedJson = log.mock.lastCall?.[0];
    expect(JSON.parse(String(expectedJson))).toMatchObject({
      events: [
        {
          event: "handoff",
          actor: "be",
          created_at: point,
          note: 'First, "quoted"\r\n[REDACTED:github_token]',
          detail: {
            nested: [{ password: "[REDACTED:field]", "[REDACTED:github_token]": "example" }],
          },
        },
      ],
    });
    await taskLog(service, taskId, { ...query, since: "30m", format: "json" });
    expect(log.mock.lastCall?.[0]).toBe(expectedJson);
    await taskLog(service, taskId, { event: "handoff", actor: "be", since: "29m", format: "json" });
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual({ events: [] });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await taskLog(service, taskId, { ...query, since: "30m", format: "csv" });
    const csv = String(stdout.mock.lastCall?.[0]);
    expect(csv).toBe(
      [
        "id,project_id,task_id,task_title,event,actor,note,detail,created_at",
        `1,${config.project_id},${taskId},'=Audit,handoff,be,"First, ""quoted""\r\n[REDACTED:github_token]","{""nested"":[{""password"":""[REDACTED:field]"",""[REDACTED:github_token]"":""example""}]}",${point}`,
        "",
      ].join("\r\n"),
    );
    await taskLog(service, taskId, { ...query, since: "29m", format: "csv" });
    expect(stdout.mock.lastCall?.[0]).toBe(`${csv.split("\r\n")[0]}\r\n`);
    stdout.mockRestore();
    await expect(taskLog(service, taskId, { since: "yesterday" })).rejects.toThrow(/--since/);
    await expect(taskLog(service, taskId, { format: "xml" })).rejects.toThrow(/format/);
    await expect(taskLog(service, taskId, { format: "csv", json: true })).rejects.toThrow(/--json/);
  });

  it("mengelola permission lewat permissionList, permissionSet, permissionGrant, dan permissionRevoke", async () => {
    const rawDir = await mkdtemp(join(tmpdir(), "catenext-perm-cli-"));
    tempDirs.push(rawDir);
    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: "11111111-2222-4333-8444-555555555555",
      repo_name: "be",
    });
    const service = new LocalService(rawDir, config);
    await service.ensureSeed({ personaSeed: "minimal" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await permissionList(service, true);
    const initial = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
      permissions: Array<{ action: string; principal: string }>;
    };
    expect(initial.permissions).toContainEqual({
      action: "upsert_persona",
      principal: "orchestrator",
    });

    logSpy.mockClear();
    await permissionRevoke(service, "upsert_persona", "orchestrator", false);
    expect(logSpy).toHaveBeenCalledWith("✓ Permission upsert_persona: human");

    logSpy.mockClear();
    await permissionGrant(service, "upsert_persona", "orchestrator", false);
    expect(logSpy).toHaveBeenCalledWith("✓ Permission upsert_persona: human, orchestrator");

    logSpy.mockClear();
    await permissionSet(service, "manage_roots", ["human"], true);
    const afterSet = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
      permissions: Array<{ action: string; principal: string }>;
    };
    expect(afterSet.permissions.filter((p) => p.action === "manage_roots")).toEqual([
      { action: "manage_roots", principal: "human" },
    ]);

    await expect(permissionSet(service, "approve_plan", ["orchestrator"], false)).rejects.toThrow(
      /human/,
    );
    await expect(permissionSet(service, "unknown_action", ["human"], false)).rejects.toThrow(
      /tidak valid/,
    );
  });
});
