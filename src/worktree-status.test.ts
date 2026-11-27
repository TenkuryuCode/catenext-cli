import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema } from "@catenext/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProjectState } from "./db/project-codec.js";
import { LocalStore } from "./db/store.js";
import { taskClaim } from "./fallback.js";
import { LocalService } from "./local-service.js";
import {
  formatWorktreeStatus,
  parseGitDiffNameOnly,
  parseGitStatusPorcelain,
  parseWorktreeListPorcelain,
  readWorktreeOverlapHint,
  readWorktreeStatus,
  snapshotWorktreeLeases,
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

describe("parseGitDiffNameOnly", () => {
  it("parses NUL-delimited and newline-delimited diff paths with deduplication", () => {
    expect(parseGitDiffNameOnly("src/a.ts\0src/b.ts\0src/a.ts\0")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(parseGitDiffNameOnly("src/a.ts\nsrc/c.ts\n")).toEqual(["src/a.ts", "src/c.ts"]);
    expect(parseGitDiffNameOnly("")).toEqual([]);
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

  it("detects committed-ahead file overlaps across clean parallel worktree branches", async () => {
    const { dir, root } = await initGitRepo();
    const wt1 = join(dir, "wt-clean-1");
    const wt2 = join(dir, "wt-clean-2");
    git(root, "worktree", "add", "-b", "feat/clean-1", "--", wt1, "main");
    git(root, "worktree", "add", "-b", "feat/clean-2", "--", wt2, "main");

    const commitFile = async (wt: string, name: string, content: string, msg: string) => {
      await writeFile(join(wt, name), content);
      git(wt, "add", name);
      git(
        wt,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        msg,
      );
    };

    await commitFile(wt1, "shared.ts", "export const a = 11;\n", "wt1 shared");
    await commitFile(wt1, "wt1-committed.ts", "export const w1 = 1;\n", "wt1 only");
    await commitFile(wt2, "shared.ts", "export const a = 22;\n", "wt2 shared");
    await commitFile(wt2, "wt2-committed.ts", "export const w2 = 2;\n", "wt2 only");

    const result = await readWorktreeStatus(root);
    const mainEntry = result.worktrees.find((wt) => wt.path === root);
    const entry1 = result.worktrees.find((wt) => wt.path === wt1);
    const entry2 = result.worktrees.find((wt) => wt.path === wt2);

    expect(mainEntry).toMatchObject({ dirty_count: 0, ahead_count: 0, ahead_files: [] });
    expect(entry1).toMatchObject({
      branch: "feat/clean-1",
      dirty_count: 0,
      modified_files: [],
      ahead_count: 2,
      ahead_files: ["shared.ts", "wt1-committed.ts"],
    });
    expect(entry2).toMatchObject({
      branch: "feat/clean-2",
      dirty_count: 0,
      modified_files: [],
      ahead_count: 2,
      ahead_files: ["shared.ts", "wt2-committed.ts"],
    });
    expect(result.overlaps).toEqual([{ file: "shared.ts", worktrees: [wt1, wt2] }]);

    const formatted = formatWorktreeStatus(result);
    expect(formatted).toContain("clean, 2 ahead");
    expect(formatted).toContain("OVERLAP: shared.ts");
  });

  it("detects mixed dirty + committed-ahead overlaps and avoids self-overlap on same worktree", async () => {
    const { dir, root } = await initGitRepo();
    const wt1 = join(dir, "wt-mix-1");
    const wt2 = join(dir, "wt-mix-2");
    git(root, "worktree", "add", "-b", "feat/mix-1", "--", wt1, "main");
    git(root, "worktree", "add", "-b", "feat/mix-2", "--", wt2, "main");

    await writeFile(join(wt1, "shared.ts"), "export const a = 11;\n");
    await writeFile(join(wt1, "wt1-both.ts"), "export const z = 1;\n");
    git(wt1, "add", "shared.ts", "wt1-both.ts");
    git(
      wt1,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "wt1 commit",
    );
    // Same file also dirty in wt1 must not self-overlap.
    await writeFile(join(wt1, "wt1-both.ts"), "export const z = 2;\n");

    // wt2 only has dirty change on shared.ts
    await writeFile(join(wt2, "shared.ts"), "export const a = 99;\n");

    const result = await readWorktreeStatus(root);
    expect(result.overlaps).toEqual([{ file: "shared.ts", worktrees: [wt1, wt2] }]);
  });

  it("caps ahead_files at 50 while preserving ahead_count and overlap detection", async () => {
    const { dir, root } = await initGitRepo();
    const wt1 = join(dir, "wt-ahead-many-1");
    const wt2 = join(dir, "wt-ahead-many-2");
    git(root, "worktree", "add", "-b", "feat/ahead-many-1", "--", wt1, "main");
    git(root, "worktree", "add", "-b", "feat/ahead-many-2", "--", wt2, "main");

    for (let i = 0; i < 55; i++) {
      await writeFile(
        join(wt1, `ahead-${String(i).padStart(2, "0")}.ts`),
        `export const n = ${i};\n`,
      );
    }
    git(wt1, "add", ".");
    git(
      wt1,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "55 files",
    );

    await writeFile(join(wt2, "ahead-54.ts"), "export const clash = true;\n");
    git(wt2, "add", "ahead-54.ts");
    git(
      wt2,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "clash",
    );

    const result = await readWorktreeStatus(root);
    const entry1 = result.worktrees.find((wt) => wt.path === wt1);
    expect(entry1?.ahead_count).toBe(55);
    expect(entry1?.ahead_files).toHaveLength(50);
    expect(result.overlaps).toEqual([{ file: "ahead-54.ts", worktrees: [wt1, wt2] }]);
  });

  it("diffs against marker base_branch when worktrees branch off a non-main base", async () => {
    const { dir, root } = await initGitRepo();
    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: randomUUID(),
      repo_name: "fixture",
      layout: "monorepo",
    });
    await mkdir(join(root, ".catenext"));
    await writeFile(join(root, ".catenext/config.yaml"), JSON.stringify(config));

    // Create feat/base ahead of main with base-only.ts
    git(root, "checkout", "-b", "feat/base");
    await writeFile(join(root, "base-only.ts"), "export const base = true;\n");
    git(root, "add", "base-only.ts");
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
      "base commit",
    );
    git(root, "checkout", "main");

    const service = new LocalService(root, config);
    await service.callTool("upsert_persona", {
      alias: "be",
      role: "backend",
      rules: ["Own backend"],
    });
    await service.callTool("upsert_persona", {
      alias: "fe",
      role: "frontend",
      rules: ["Own frontend"],
    });
    const { epic } = await service.callTool("create_epic", { title: "BaseBranch" });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [
        { ref: "t1", title: "Task 1", prompt_instruction: "Do work", persona: "be" },
        { ref: "t2", title: "Task 2", prompt_instruction: "Do work", persona: "fe" },
      ],
    });
    const t1 = created[0]?.task_id;
    const t2 = created[1]?.task_id;
    if (!t1 || !t2) throw new Error("Missing tasks");
    await service.callTool("manage_task", { task_id: t1, action: "approve_plan" });
    await service.callTool("manage_task", { task_id: t2, action: "approve_plan" });

    const wt1 = join(dir, "wt-base-1");
    const wt2 = join(dir, "wt-base-2");
    const logSpy = await import("vitest").then(({ vi }) =>
      vi.spyOn(console, "log").mockImplementation(() => {}),
    );
    await taskClaim(service, t1, {
      as: "be",
      cwd: root,
      project: { root, config },
      createWorktree: true,
      branch: "feat/t1-on-base",
      base: "feat/base",
      path: wt1,
      json: true,
    });
    await taskClaim(service, t2, {
      as: "fe",
      cwd: root,
      project: { root, config },
      createWorktree: true,
      branch: "feat/t2-on-base",
      base: "feat/base",
      path: wt2,
      json: true,
    });
    logSpy.mockRestore();

    const leases = await new LocalStore(service.stateFile).inspect((db) => {
      const { project } = loadProjectState(db, config.project_id);
      return snapshotWorktreeLeases(project.tasks, config.repo_name);
    });
    expect(leases).toHaveLength(2);

    await writeFile(join(wt1, "t1.ts"), "export const t1 = 1;\n");
    git(wt1, "add", "t1.ts");
    git(
      wt1,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "t1 commit",
    );

    await writeFile(join(wt2, "t2.ts"), "export const t2 = 2;\n");
    git(wt2, "add", "t2.ts");
    git(
      wt2,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "t2 commit",
    );

    const result = await readWorktreeStatus(root);
    const e1 = result.worktrees.find((wt) => wt.path === wt1);
    const e2 = result.worktrees.find((wt) => wt.path === wt2);
    expect(e1).toMatchObject({ ahead_count: 1, ahead_files: ["t1.ts"] });
    expect(e2).toMatchObject({ ahead_count: 1, ahead_files: ["t2.ts"] });
    expect(result.overlaps).toEqual([]);

    if (!leases) throw new Error("Missing lease snapshot");
    // Without config or markers, only supplied leases resolve feat/base instead of main.
    await rm(join(root, ".catenext/config.yaml"));
    for (const path of [wt1, wt2]) {
      await rm(join(git(path, "rev-parse", "--absolute-git-dir"), "catenext-worktree.json"));
    }
    await writeFile(join(wt1, "shared.ts"), "export const a = 101;\n");
    await writeFile(join(wt2, "shared.ts"), "export const a = 102;\n");
    await expect(readWorktreeOverlapHint(root, leases, AbortSignal.timeout(2000))).resolves.toEqual(
      [{ file: "shared.ts", worktrees: [wt1, wt2] }],
    );
  });

  it("returns no hint when Git fails or deadline has already passed", async () => {
    const { root } = await initGitRepo();
    await expect(readWorktreeOverlapHint(join(root, "missing"), [])).resolves.toEqual([]);
    await expect(readWorktreeOverlapHint(root, [], AbortSignal.abort())).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "cancels a later Git command on the shared deadline without spawning more commands",
    async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "catenext-wt-deadline-")));
      tempDirs.push(dir);
      const bin = join(dir, "bin");
      const linked = join(dir, "linked");
      const trace = join(dir, "git-trace");
      await mkdir(bin);
      await mkdir(linked);
      await writeFile(trace, "");
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh
printf '%s\\n' "$2" >> "$CATENEXT_TEST_GIT_TRACE"
case "$2" in
  worktree)
    printf 'worktree %s\\nHEAD ${"a".repeat(40)}\\nbranch refs/heads/main\\n\\n' "$PWD"
    printf 'worktree %s/linked\\nHEAD ${"b".repeat(40)}\\nbranch refs/heads/linked\\n\\n' "$PWD"
    ;;
  symbolic-ref) exit 1 ;;
  rev-parse) printf '%s\\n' '${"a".repeat(40)}' ;;
  status)
    printf '%s\\n' "$$" >> "$CATENEXT_TEST_GIT_TRACE"
    exec /bin/sleep 10
    ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o755 },
      );
      vi.stubEnv("CATENEXT_TEST_GIT_TRACE", trace);
      vi.stubEnv("PATH", bin);
      const deadline = new AbortController();
      const scan = readWorktreeOverlapHint(dir, [], deadline.signal);
      try {
        // Trigger cancellation only after the later Git command has signaled readiness.
        const ready = vi.waitFor(
          async () => {
            const commands = (await readFile(trace, "utf8")).trim().split("\n");
            expect(commands).toEqual([
              "worktree",
              "symbolic-ref",
              "rev-parse",
              "status",
              expect.stringMatching(/^\d+$/),
            ]);
            return Number(commands[4]);
          },
          { timeout: 4000 },
        );
        const gitPid = await Promise.race([
          ready,
          scan.then(() => {
            throw new Error("Hint scan returned before fake Git status was ready");
          }),
        ]);
        deadline.abort();
        await expect(scan).resolves.toEqual([]);
        await vi.waitFor(() => expect(() => process.kill(gitPid, 0)).toThrow(/ESRCH/));
        expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(5);
      } finally {
        deadline.abort();
        await scan;
        vi.unstubAllEnvs();
      }
    },
  );

  it("throws WorktreeError outside a git repository", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "catenext-nongit-")));
    tempDirs.push(dir);
    await expect(readWorktreeStatus(dir)).rejects.toBeInstanceOf(WorktreeError);
  });
});
