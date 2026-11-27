import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema } from "@catenext/shared";
import { afterEach, describe, expect, it } from "vitest";
import { taskClaim } from "./fallback.js";
import { LocalService } from "./local-service.js";
import {
  formatWorktreeStatus,
  parseGitStatusPorcelain,
  parseWorktreeListPorcelain,
  readWorktreeStatus,
} from "./worktree-status.js";
import { WorktreeError } from "./worktrees.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const path of tempDirs.splice(0)) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function initGitRepo(): Promise<{ dir: string; root: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "catenext-wt-status-")));
  tempDirs.push(dir);
  const root = join(dir, "primary");
  await mkdir(root);
  git(root, "init", "-b", "main");
  await writeFile(join(root, ".gitignore"), ".catenext/\n");
  await writeFile(join(root, "shared.ts"), "export const a = 1;\n");
  await writeFile(join(root, "other.ts"), "export const b = 2;\n");
  git(root, "add", ".gitignore", "shared.ts", "other.ts");
  git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "init",
  );
  return { dir, root };
}

describe("parseWorktreeListPorcelain", () => {
  it("parses normal, detached, bare, and prunable stanzas", () => {
    const parsed = parseWorktreeListPorcelain(
      [
        "worktree /repo/main",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /repo/detached",
        "HEAD 2222222222222222222222222222222222222222",
        "detached",
        "",
        "worktree /repo/missing",
        "HEAD 3333333333333333333333333333333333333333",
        "branch refs/heads/feat/gone",
        "prunable gitdir file points to non-existent location",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      {
        path: "/repo/main",
        head: "1111111111111111111111111111111111111111",
        branch: "main",
        bare: false,
        prunable: false,
      },
      {
        path: "/repo/detached",
        head: "2222222222222222222222222222222222222222",
        branch: null,
        bare: false,
        prunable: false,
      },
      {
        path: "/repo/missing",
        head: "3333333333333333333333333333333333333333",
        branch: "feat/gone",
        bare: false,
        prunable: true,
      },
    ]);
  });
});

describe("parseGitStatusPorcelain", () => {
  it("parses NUL-delimited porcelain entries including renames and untracked files", () => {
    const raw =
      " M apps/cli/src/index.ts\0R  apps/cli/src/new.ts\0apps/cli/src/old.ts\0?? untracked.txt\0";
    expect(parseGitStatusPorcelain(raw)).toEqual([
      "apps/cli/src/index.ts",
      "apps/cli/src/new.ts",
      "untracked.txt",
    ]);
  });

  it("parses newline-delimited porcelain entries fallback", () => {
    const raw = " M src/a.ts\nR  src/old.ts -> src/new.ts\n?? src/c.ts\n";
    expect(parseGitStatusPorcelain(raw)).toEqual(["src/a.ts", "src/new.ts", "src/c.ts"]);
  });
});

describe("readWorktreeStatus", () => {
  it("works in plain git repo without .catenext and detects cross-worktree overlaps", async () => {
    const { dir, root } = await initGitRepo();
    const wt1 = join(dir, "wt1");
    const wt2 = join(dir, "wt2");
    git(root, "worktree", "add", "-b", "feat/one", "--", wt1, "main");
    git(root, "worktree", "add", "-b", "feat/two", "--", wt2, "main");

    await writeFile(join(wt1, "shared.ts"), "export const a = 10;\n");
    await writeFile(join(wt1, "wt1-only.ts"), "export const x = 1;\n");
    await writeFile(join(wt2, "shared.ts"), "export const a = 20;\n");
    git(wt2, "add", "shared.ts");
    await writeFile(join(wt2, "wt2-only.ts"), "export const y = 2;\n");

    const result = await readWorktreeStatus(root);
    expect(existsSync(join(root, ".catenext"))).toBe(false);
    expect(result.worktrees).toHaveLength(3);
    expect(result.worktrees[0]).toMatchObject({
      path: root,
      branch: "main",
      prunable: false,
      dirty_count: 0,
      modified_files: [],
    });
    expect(result.worktrees[1]).toMatchObject({
      path: wt1,
      branch: "feat/one",
      prunable: false,
      dirty_count: 2,
      modified_files: ["shared.ts", "wt1-only.ts"],
    });
    expect(result.worktrees[2]).toMatchObject({
      path: wt2,
      branch: "feat/two",
      prunable: false,
      dirty_count: 2,
      modified_files: ["shared.ts", "wt2-only.ts"],
    });
    expect(result.overlaps).toEqual([{ file: "shared.ts", worktrees: [wt1, wt2] }]);

    const formatted = formatWorktreeStatus(result);
    expect(formatted).toContain("feat/one");
    expect(formatted).toContain("2 dirty");
    expect(formatted).toContain(`OVERLAP: shared.ts`);
  });

  it("handles detached HEAD and missing/prunable worktrees gracefully", async () => {
    const { dir, root } = await initGitRepo();
    const detachedWt = join(dir, "detached");
    const missingWt = join(dir, "missing");
    git(root, "worktree", "add", "--detach", "--", detachedWt, "main");
    git(root, "worktree", "add", "-b", "feat/missing", "--", missingWt, "main");

    await writeFile(join(detachedWt, "other.ts"), "export const b = 99;\n");
    await rm(missingWt, { recursive: true, force: true });

    const result = await readWorktreeStatus(root);
    const detachedEntry = result.worktrees.find((wt) => wt.path === detachedWt);
    const missingEntry = result.worktrees.find((wt) => wt.path === missingWt);

    expect(detachedEntry).toMatchObject({
      path: detachedWt,
      branch: null,
      prunable: false,
      dirty_count: 1,
      modified_files: ["other.ts"],
    });
    expect(detachedEntry?.head).toMatch(/^[0-9a-f]{40,}$/);
    expect(missingEntry).toMatchObject({
      path: missingWt,
      branch: "feat/missing",
      prunable: true,
      dirty_count: 0,
      modified_files: [],
    });
    expect(result.overlaps).toEqual([]);
  });

  it("caps modified_files at 50 while preserving full dirty_count and overlap detection", async () => {
    const { dir, root } = await initGitRepo();
    const wt1 = join(dir, "wt-many-1");
    const wt2 = join(dir, "wt-many-2");
    git(root, "worktree", "add", "-b", "feat/many-1", "--", wt1, "main");
    git(root, "worktree", "add", "-b", "feat/many-2", "--", wt2, "main");

    for (let i = 0; i < 55; i++) {
      const name = `file-${String(i).padStart(2, "0")}.ts`;
      await writeFile(join(wt1, name), `export const n = ${i};\n`);
    }
    await writeFile(join(wt2, "file-54.ts"), "export const conflict = true;\n");

    const result = await readWorktreeStatus(root);
    const entry1 = result.worktrees.find((wt) => wt.path === wt1);
    expect(entry1?.dirty_count).toBe(55);
    expect(entry1?.modified_files).toHaveLength(50);
    expect(result.overlaps).toEqual([{ file: "file-54.ts", worktrees: [wt1, wt2] }]);
  });

  it("enriches worktrees with active SQLite leases read-only when initialized", async () => {
    const { dir, root } = await initGitRepo();
    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: randomUUID(),
      repo_name: "fixture",
      layout: "monorepo",
    });
    await mkdir(join(root, ".catenext"));
    await writeFile(join(root, ".catenext/config.yaml"), JSON.stringify(config));

    // Before SQLite exists, readWorktreeStatus must not create catenext.sqlite.
    const preDb = await readWorktreeStatus(root);
    expect(preDb.worktrees).toHaveLength(1);
    expect(preDb.worktrees[0]?.lease).toBeUndefined();
    expect(existsSync(join(root, ".catenext/catenext.sqlite"))).toBe(false);

    const service = new LocalService(root, config);
    await service.callTool("upsert_persona", {
      alias: "be",
      role: "backend",
      rules: ["Own backend"],
    });
    const { epic } = await service.callTool("create_epic", { title: "Status" });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [{ ref: "t1", title: "Task 1", prompt_instruction: "Do work", persona: "be" }],
    });
    const taskId = created[0]?.task_id;
    if (!taskId) throw new Error("Missing task");
    await service.callTool("manage_task", { task_id: taskId, action: "approve_plan" });

    const wtPath = join(dir, "wt-be");
    const logSpy = await import("vitest").then(({ vi }) =>
      vi.spyOn(console, "log").mockImplementation(() => {}),
    );
    await taskClaim(service, taskId, {
      as: "be",
      cwd: root,
      project: { root, config },
      createWorktree: true,
      branch: "feat/be-task",
      path: wtPath,
      json: true,
    });
    logSpy.mockRestore();

    // Inspect from inside the linked worktree; must find primary config/SQLite read-only.
    const result = await readWorktreeStatus(wtPath);
    const beEntry = result.worktrees.find((wt) => wt.path === wtPath);
    expect(beEntry?.lease).toEqual({ task_id: taskId, persona: "be" });
    expect(existsSync(join(root, ".catenext/catenext.sqlite.lock"))).toBe(false);
    expect(formatWorktreeStatus(result)).toContain(`lease=be:${taskId}`);
  });

  it("throws WorktreeError outside a git repository", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "catenext-nongit-")));
    tempDirs.push(dir);
    await expect(readWorktreeStatus(dir)).rejects.toBeInstanceOf(WorktreeError);
  });
});
