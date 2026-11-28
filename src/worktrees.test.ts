import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema } from "@catenext/shared";
import { afterEach, expect, it, vi } from "vitest";
import { findProjectRoot } from "./config.js";
import { LocalStore } from "./db/store.js";
import { taskClaim } from "./fallback.js";
import { LocalService } from "./local-service.js";
import { pruneWorktrees, readManagedWorktree } from "./worktrees.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "catenext-worktrees-")));
  tempDirs.push(dir);
  const root = join(dir, "primary");
  await mkdir(root);
  git(root, "init", "-b", "main");
  await writeFile(join(root, ".gitignore"), ".catenext/\n");
  git(root, "add", ".gitignore");
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
    "fixture",
  );
  const config = CatenextConfigSchema.parse({
    schema_version: 1,
    project_id: randomUUID(),
    repo_name: "fixture",
    layout: "monorepo",
  });
  await mkdir(join(root, ".catenext"));
  await writeFile(join(root, ".catenext/config.yaml"), JSON.stringify(config));
  const service = new LocalService(root, config);
  const { epic } = await service.callTool("create_epic", { title: "Worktrees" });
  async function newTask(ref: string) {
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [{ ref, title: ref, prompt_instruction: "Synthetic task" }],
    });
    const id = created[0]?.task_id;
    if (!id) throw new Error("Missing fixture task");
    await service.callTool("manage_task", { task_id: id, action: "approve_plan" });
    return id;
  }
  const options = { root, cwd: root, config };
  function opts(name: string) {
    return {
      cwd: root,
      project: options,
      createWorktree: true,
      branch: `feat/${name}`,
      path: join(dir, name),
      json: true,
    };
  }
  return { dir, root, service, newTask, opts, options };
}

it.each(["change", "remove"])(
  "rejects claim if checkout changes before the lease-lock validation: %s",
  async (action) => {
    const { root, service, newTask, opts } = await fixture();
    const id = await newTask("claim");
    const flags = opts("claim");
    const original = service.callTool.bind(service);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(service, "callTool").mockImplementation(async (name, input, local) => {
      const beforeClaim = local?.beforeClaim;
      if (name !== "claim_task" || !beforeClaim) return original(name, input, local);
      const validate = async () => {
        expect((await lstat(`${service.stateFile}.lock`)).isFile()).toBe(true);
        if (action === "change") git(flags.path, "switch", "-c", "feat/replacement");
        else git(root, "worktree", "remove", "--", flags.path);
        await beforeClaim();
      };
      return original(name, input, { beforeClaim: validate });
    });
    await expect(taskClaim(service, id, flags)).rejects.toThrow(/telah berubah atau hilang/);
    spy.mockRestore();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Checkout tetap tersedia");
    expect(await service.callTool("get_ready_tasks", {})).toMatchObject({ tasks: [{ id }] });
    expect(
      (await service.readTaskEvents({ taskId: id })).some((row) => row.event === "claim"),
    ).toBe(false);
    expect(git(root, "branch", "--show-current")).toBe("main");
    expect(git(root, "show-ref", "--verify", `refs/heads/${flags.branch}`)).toContain(flags.branch);
  },
  20_000,
);

it("prune protects an active worktree and previews an orphan before applying", async () => {
  const { root, service, newTask, opts, options } = await fixture();
  const id = await newTask("active");
  const active = opts("active");
  const dirty = opts("dirty");
  const orphan = opts("orphan");
  const manual = opts("manual");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await taskClaim(service, id, active);
  const claimed = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? "{}")) as {
    worktree?: { worktree_path?: string };
  };
  expect(claimed.worktree?.worktree_path).toBe(active.path);
  expect(await findProjectRoot(active.path, { managedWorktree: true })).toBe(root);
  // A rejected claim leaves its checkout for explicit recovery; it never takes a second lease.
  await expect(taskClaim(service, id, orphan)).rejects.toMatchObject({ code: "already_claimed" });
  await expect(taskClaim(service, id, dirty)).rejects.toMatchObject({ code: "already_claimed" });
  await writeFile(join(dirty.path, "untracked.txt"), "preserve");
  git(root, "worktree", "add", "-b", manual.branch, "--", manual.path, "main");

  // Release only an independently claimed task: rejected checkouts for an active task stay protected.
  const orphanId = await newTask("released");
  const removable = opts("released");
  await taskClaim(service, orphanId, removable);
  const output = log.mock.calls.at(-1)?.[0];
  if (typeof output !== "string") throw new Error("Missing claim JSON");
  const lease = JSON.parse(output) as { lease_id: string };
  await service.callTool("release_task", { task_id: orphanId, lease_id: lease.lease_id });

  const preview = await pruneWorktrees(options);
  expect(preview).toMatchObject({ apply: false, removed: [], skipped: [] });
  expect(preview.worktrees).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: root, status: "primary", eligible: false }),
      expect.objectContaining({ path: active.path, status: "active", eligible: false }),
      expect.objectContaining({ path: dirty.path, dirty: true, eligible: false }),
      expect.objectContaining({ path: manual.path, status: "unmanaged", eligible: false }),
      expect.objectContaining({ path: removable.path, status: "orphaned", eligible: true }),
    ]),
  );
  expect((await lstat(removable.path)).isDirectory()).toBe(true);
  const applied = await pruneWorktrees(options, true);
  expect(applied).toMatchObject({ removed: [removable.path], skipped: [] });
  await expect(lstat(removable.path)).rejects.toMatchObject({ code: "ENOENT" });
  for (const path of [root, active.path, orphan.path, dirty.path, manual.path]) {
    expect((await lstat(path)).isDirectory()).toBe(true);
  }
  expect(git(root, "show-ref", "--verify", `refs/heads/${removable.branch}`)).toContain(
    removable.branch,
  );
}, 30_000);

it("rechecks lease state after preview while waiting for the writer lock", async () => {
  const { root, service, newTask, opts, options } = await fixture();
  const draft = opts("race");
  const id = await newTask("race");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await taskClaim(service, id, draft);
  const output = log.mock.calls.at(-1)?.[0];
  if (typeof output !== "string") throw new Error("Missing claim JSON");
  const lease = JSON.parse(output) as { lease_id: string };
  await service.callTool("release_task", { task_id: id, lease_id: lease.lease_id });

  const inspect = LocalStore.prototype.inspect;
  let renewed = false;
  vi.spyOn(LocalStore.prototype, "inspect").mockImplementation(async function (
    this: LocalStore,
    run,
    flags,
  ) {
    if (flags?.lock && !renewed) {
      renewed = true;
      await taskClaim(service, id, { cwd: draft.path, worktree: true, json: true });
    }
    return inspect.call(this, run, flags);
  });
  const result = await pruneWorktrees(options, true);
  expect(renewed).toBe(true);
  expect(result.worktrees).toContainEqual(
    expect.objectContaining({ path: draft.path, eligible: true }),
  );
  expect(result).toMatchObject({ removed: [], skipped: [draft.path] });
  expect(git(root, "worktree", "list", "--porcelain").replaceAll("\\", "/")).toContain(
    draft.path.replaceAll("\\", "/"),
  );
}, 20_000);

it("rejects hardlinked and symlinked lock files during locked store and prune operations", async () => {
  const { dir, service, newTask, opts, options } = await fixture();
  const id = await newTask("lock-edge");
  const draft = opts("lock-edge");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await taskClaim(service, id, draft);
  const output = log.mock.calls.at(-1)?.[0];
  if (typeof output !== "string") throw new Error("Missing claim JSON");
  const lease = JSON.parse(output) as { lease_id: string };
  await service.callTool("release_task", { task_id: id, lease_id: lease.lease_id });

  const lockPath = `${service.stateFile}.lock`;
  const decoy = join(dir, "decoy-lock");
  await writeFile(
    decoy,
    JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() }),
  );

  // Hardlinked lock file must be rejected even when its content looks stale.
  await link(decoy, lockPath);
  const store = new LocalStore(service.stateFile);
  await expect(store.inspect(() => null, { lock: true })).rejects.toThrow(
    /not a symlink or hardlink/i,
  );
  await expect(pruneWorktrees(options, true)).rejects.toThrow(/not a symlink or hardlink/i);

  // Symlinked lock file must also be rejected.
  await rm(lockPath, { force: true });
  await symlink(decoy, lockPath);
  await expect(store.inspect(() => null, { lock: true })).rejects.toThrow(/not a symlink/i);
}, 20_000);

it("enforces symlink boundary checks on worktree creation and managed marker discovery", async () => {
  const { dir, root, service, newTask, opts } = await fixture();

  // 1. Symlinked parent pointing inside primary root must be rejected.
  const aliasToRoot = join(dir, "alias-to-primary");
  await symlink(root, aliasToRoot);
  const id1 = await newTask("sym-parent");
  await expect(
    taskClaim(service, id1, {
      ...opts("sym-parent"),
      path: join(aliasToRoot, "nested-wt"),
    }),
  ).rejects.toThrow(/di luar worktree yang sudah terdaftar/i);

  // 2. Dangling symlink at target --path must be rejected by lstat-based requireMissing.
  const dangling = join(dir, "dangling-wt");
  await symlink(join(dir, "does-not-exist"), dangling);
  const id2 = await newTask("dangling");
  await expect(
    taskClaim(service, id2, {
      ...opts("dangling"),
      path: dangling,
    }),
  ).rejects.toThrow(/harus belum ada/i);

  // 3. Hardlinked catenext-worktree.json marker inside git admin dir must be ignored.
  const id3 = await newTask("hardlink-marker");
  const validOpts = opts("valid-wt");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await taskClaim(service, id3, validOpts);
  expect(await readManagedWorktree(validOpts.path)).not.toBeNull();

  const adminDir = git(validOpts.path, "rev-parse", "--path-format=absolute", "--git-dir");
  const markerPath = join(adminDir, "catenext-worktree.json");
  const markerCopy = join(dir, "marker-hardlink.json");
  await link(markerPath, markerCopy);
  expect(await readManagedWorktree(validOpts.path)).toBeNull();
}, 20_000);
