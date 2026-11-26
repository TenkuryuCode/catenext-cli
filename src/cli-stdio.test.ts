import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaimTaskInput,
  MCP_CRUD_TOOLS,
  MCP_TOOLS,
  type McpToolName,
  type McpToolOutput,
} from "@catenext/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

let scratch: string;
let fixtureDir: string;
let root: string;
let entry: string;
let env: Record<string, string>;

/** Monorepo: packages/shared; mirror publik: ./shared (sama seperti build.mjs). */
function resolveSharedEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../../packages/shared/src/index.ts"),
    resolve(here, "../shared/src/index.ts"),
  ];
  const shared = candidates.find((p) => existsSync(p));
  if (!shared) throw new Error("Source @catenext/shared tidak ditemukan.");
  return shared;
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "catenext-cli-stdio-")));
  // Simulate an npx cache to catch regressions that launch npx from generated MCP entries.
  const bundleDir = join(scratch, "_npx", "launcher");
  await mkdir(bundleDir, { recursive: true });
  await symlink(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
    join(bundleDir, "node_modules"),
    "junction",
  );
  entry = join(bundleDir, "catenext.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    outfile: entry,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    alias: {
      "@catenext/shared": resolveSharedEntry(),
    },
    packages: "external",
  });
});

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(scratch, "test-"));
  root = join(fixtureDir, "project");
  const home = join(fixtureDir, "home");
  await Promise.all([mkdir(root), mkdir(home)]);
  env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    npm_config_offline: "true",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
});

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function runCli(
  args: string[],
  input?: string,
  { cwd = root, command = process.execPath, timeout = 15_000 } = {},
) {
  const result = spawnSync(command, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    input,
    timeout,
  });
  if (result.error) throw result.error;
  return result;
}

function cli(args: string[], input?: string, options?: Parameters<typeof runCli>[2]): string {
  const result = runCli(args, input, options);
  if (result.status !== 0) {
    throw new Error(
      `catenext ${args.join(" ")} exited ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function cliJson<N extends McpToolName>(
  name: N,
  args: string[],
  input?: string,
  options?: Parameters<typeof runCli>[2],
): McpToolOutput<N> {
  return MCP_TOOLS[name].output.parse(
    JSON.parse(cli([...args, "--json"], input, options)),
  ) as McpToolOutput<N>;
}

async function readClaudeLaunch() {
  const schema = z.object({
    mcpServers: z.object({
      catenext: z.object({ command: z.string(), args: z.array(z.string()) }),
    }),
  });
  return schema.parse(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))).mcpServers
    .catenext;
}

async function mcp<N extends McpToolName>(
  client: Client,
  name: N,
  args: Record<string, unknown> = {},
): Promise<McpToolOutput<N>> {
  const result = await client.callTool({ name, arguments: args });
  const first = z
    .object({ type: z.literal("text"), text: z.string() })
    .safeParse(Array.isArray(result.content) ? result.content[0] : undefined);
  if (!first.success) throw new Error(`MCP ${name} did not return text`);
  if (result.isError) throw new Error(first.data.text);
  return MCP_TOOLS[name].output.parse(JSON.parse(first.data.text)) as McpToolOutput<N>;
}

async function withMcp(
  flags: string[],
  run: (client: Client) => Promise<void>,
  launch?: Awaited<ReturnType<typeof readClaudeLaunch>>,
) {
  const client = new Client({ name: "catenext-integration-fixture", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: launch?.command ?? process.execPath,
    args: launch
      ? launch.args.map((arg) => arg.replace("$" + "{CLAUDE_PROJECT_DIR}", root))
      : [entry, "mcp", "--root", root, ...flags],
    cwd: env.HOME,
    env,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function initWorktreeProject() {
  git("init", "-b", "main");
  git(
    "-c",
    "user.name=Catenext Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Worktree fixture",
  );
  cli(["init", "--platform", "claude-code"]);
  const { epic } = cliJson("create_epic", ["epic", "create", "Worktree fixture"]);
  return (title: string) => {
    const { created } = cliJson("create_tasks", [
      "task",
      "create",
      "--epic",
      epic.id,
      "--title",
      title,
      "--prompt",
      "Synthetic task",
    ]);
    const task = created[0];
    if (!task) throw new Error("Missing worktree fixture task");
    cliJson("manage_task", ["task", "approve", task.task_id]);
    return task.task_id;
  };
}

function claimNew(id: string, name: string) {
  const worktree = ClaimTaskInput.shape.worktree.unwrap().required();
  const schema = MCP_TOOLS.claim_task.output.extend({ worktree });
  return schema.parse(
    JSON.parse(
      cli([
        "claim",
        id,
        "--create-worktree",
        "--branch",
        `feat/${name}`,
        "--path",
        `../${name}`,
        "--json",
      ]),
    ),
  );
}

const worktreeList = z.object({
  worktrees: z.array(
    z.object({
      path: z.string(),
      branch: z.string().nullable(),
      status: z.string(),
      eligible: z.boolean(),
      managed: z.boolean(),
      current: z.boolean(),
      prunable: z.boolean(),
    }),
  ),
});
const pruneReport = worktreeList.extend({
  apply: z.boolean(),
  removed: z.array(z.string()),
  skipped: z.array(z.string()),
});
const doctorReport = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ id: z.string(), status: z.string(), message: z.string() })),
});

function doctor(...flags: string[]) {
  const result = runCli(["doctor", "--json", ...flags]);
  const report = doctorReport.parse(JSON.parse(result.stdout));
  expect(result.status).toBe(report.ok ? 0 : 1);
  return { report, stdout: result.stdout };
}

describe("CLI dan MCP stdio lokal", () => {
  it("berbagi state antar proses tanpa kredensial, remote Git, atau PR", async () => {
    git("init", "-b", "work");
    cli(["init", "--platform", "claude-code"]);
    const launch = await readClaudeLaunch();
    expect(launch.command).not.toMatch(/npx/);
    // macOS tmpdir is /var -> /private/var; the CLI records the resolved module path.
    expect(launch.args).toEqual([
      await realpath(entry),
      "mcp",
      "--root",
      "$" + "{CLAUDE_PROJECT_DIR}",
    ]);
    cli(["verify", "--platform", "claude-code"]);
    await writeFile(join(root, "feature.ts"), "export const localWorkflowMarker = true;\n");
    git("add", "feature.ts");
    git(
      "-c",
      "user.name=Catenext Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Local work",
    );
    expect(git("remote")).toBe("");

    // Same launch IDE would use (resolving Claude Code workspace token), from a different cwd.
    const client = new Client({ name: "test-stdio", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args.map((arg) => arg.replace("$" + "{CLAUDE_PROJECT_DIR}", root)),
      cwd: env.HOME,
      env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await client.connect(transport);
      const { epic } = await mcp(client, "create_epic", { title: "Orkestrasi offline" });
      const plan = JSON.stringify([
        { ref: "first", title: "Kerja lokal", prompt_instruction: "Buat perubahan lokal" },
        {
          ref: "second",
          title: "Task dependen",
          prompt_instruction: "Baca handoff sebelumnya",
          depends_on: ["first"],
        },
      ]);
      const { created } = cliJson(
        "create_tasks",
        ["task", "create", "--epic", epic.id, "--file", "-"],
        plan,
      );
      const [first, second] = created;
      if (!first || !second) throw new Error("Expected two tasks");
      expect((await mcp(client, "get_ready_tasks")).tasks).toEqual([]);
      const planDenied = await client.callTool({
        name: "manage_task",
        arguments: { action: "approve_plan", task_id: first.task_id },
      });
      expect(planDenied.isError).toBe(true);
      expect(planDenied.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(`catenext task approve ${first.task_id}`),
      });
      expect(cliJson("manage_task", ["task", "approve", first.task_id]).status).toBe("TODO");
      expect(cliJson("manage_task", ["task", "approve", second.task_id]).status).toBe("TODO");
      const firstClaim = cliJson("claim_task", ["claim", first.task_id]);
      expect(firstClaim.task.status).toBe("IN_PROGRESS");
      expect(
        (
          await mcp(client, "report_blocker", {
            lease_id: firstClaim.lease_id,
            task_id: first.task_id,
            category: "other",
            reason: "Menunggu keputusan lokal",
          })
        ).status,
      ).toBe("BLOCKED");
      expect(cliJson("manage_task", ["unblock", first.task_id]).status).toBe("TODO");
      const secondClaim = await mcp(client, "claim_task", { task_id: first.task_id });
      const secret = "sk_live_abcdefghijklmnop";
      expect(
        cliJson("complete_handoff", [
          "done",
          first.task_id,
          "--lease",
          secondClaim.lease_id,
          "--notes",
          `STRIPE_SECRET=${secret}`,
        ]).status,
      ).toBe("NEEDS_REVIEW");
      expect((await mcp(client, "get_ready_tasks")).tasks).toEqual([]);
      const reviewDenied = await client.callTool({
        name: "manage_task",
        arguments: { action: "approve", task_id: first.task_id },
      });
      expect(reviewDenied.isError).toBe(true);
      expect(reviewDenied.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(`catenext review approve ${first.task_id}`),
      });
      expect((await mcp(client, "get_ready_tasks")).tasks).toEqual([]);
      expect(cliJson("manage_task", ["review", "approve", first.task_id]).status).toBe("DONE");
      const next = await mcp(client, "claim_task", { task_id: second.task_id });
      expect(next.dependencies[0]?.handoff_summary).toMatchObject({
        notes_for_next_agent: expect.stringContaining("[REDACTED:"),
      });
      expect(next.dependencies[0]?.handoff_summary).not.toHaveProperty("pull_request");
      expect(await readFile(join(root, ".catenext/catenext.sqlite"))).not.toContain(secret);

      await mcp(client, "save_repo_skill", {
        name: "workflow",
        when_to_use: "Saat bekerja lokal",
        content: "Tinjau board sebelum mengambil task.",
      });
      expect(cli(["skill", "load", "workflow"])).toContain("Tinjau board");
      expect(cli(["search", "localWorkflowMarker", "--source", "code", "--json"])).toContain(
        "feature.ts",
      );
      const logOut = JSON.parse(cli(["log", first.task_id, "--limit", "10", "--json"])) as {
        events: Array<{ event: string }>;
      };
      expect(logOut.events.map((e) => e.event)).toEqual([
        "approve",
        "handoff",
        "claim",
        "unblock",
        "blocker",
        "claim",
        "approve_plan",
      ]);
      const logFilters = [
        "log",
        first.task_id,
        "--event",
        "approve",
        "--actor",
        "human",
        "--since",
        "24h",
      ];
      const filtered = JSON.parse(cli([...logFilters, "--format", "json"])) as typeof logOut;
      expect(filtered.events.map((e) => e.event)).toEqual(["approve"]);
      expect(JSON.parse(cli([...logFilters, "--json"]))).toEqual(filtered);
      const [header, row, end] = cli([...logFilters, "--format", "csv"]).split("\r\n");
      expect(header).toContain("event,actor");
      expect(row).toContain(",approve,human,");
      expect(end).toBe("");
      expect(stderr).toContain("[catenext]");
    } finally {
      await client.close();
      await transport.close();
    }
  }, 20_000);

  it("enables CRUD only on opted-in non-worker launches and keeps approvals human-only", async () => {
    git("init", "-b", "work");
    cli(["init", "--platform", "claude-code"]);

    const taskId = "11111111-2222-4333-8444-555555555555";
    for (const flags of [[], ["--role", "orchestrator"], ["--role", "worker", "--allow-crud"]]) {
      await withMcp(flags, async (client) => {
        const { tools } = await client.listTools();
        for (const name of MCP_CRUD_TOOLS) {
          expect(tools.some((tool) => tool.name === name)).toBe(false);
          await expect(
            client.callTool({
              name,
              arguments: {
                task_id: taskId,
                epic_id: taskId,
                title: "Denied edit",
                depends_on: [],
                allowCrud: true,
                caller: "human",
                role: "orchestrator",
              },
            }),
          ).rejects.toThrow(`Tool ${name} not found`);
        }
      });
    }

    await withMcp(["--allow-crud"], async (client) => {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining([...MCP_CRUD_TOOLS]),
      );
    });
    await withMcp(["--role", "orchestrator", "--allow-crud"], async (client) => {
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining([...MCP_CRUD_TOOLS]),
      );
      const { epic } = await mcp(client, "create_epic", { title: "Fixture epic" });
      const { created } = await mcp(client, "create_tasks", {
        epic_id: epic.id,
        tasks: [
          { ref: "a", title: "Fixture A", prompt_instruction: "Build fixture A" },
          { ref: "b", title: "Fixture B", prompt_instruction: "Build fixture B" },
        ],
      });
      const [a, b] = created;
      if (!a || !b) throw new Error("Fixture tasks missing");
      const updated = await mcp(client, "update_epic", { epic_id: epic.id, title: "Updated epic" });
      expect(updated.epic.title).toBe("Updated epic");
      expect(
        await mcp(client, "update_task", {
          task_id: a.task_id,
          title: "Updated task",
          requires_approval: false,
          status: "DONE",
        }),
      ).toMatchObject({ task_id: a.task_id, title: "Updated task", status: "DRAFT" });
      expect(
        await mcp(client, "set_dependencies", { task_id: b.task_id, depends_on: [a.task_id] }),
      ).toEqual({
        task_id: b.task_id,
        depends_on: [a.task_id],
      });
      await expect(
        mcp(client, "set_dependencies", { task_id: a.task_id, depends_on: [b.task_id] }),
      ).rejects.toThrow(/melingkar/);
      await expect(mcp(client, "cancel_task", { task_id: a.task_id })).rejects.toThrow(
        /dependensi/,
      );
      for (const action of ["approve_plan", "approve"]) {
        await expect(
          mcp(client, "manage_task", { task_id: a.task_id, action, caller: "human" }),
        ).rejects.toThrow(/catenext (task|review) approve/);
      }
      expect(await mcp(client, "cancel_task", { task_id: b.task_id })).toMatchObject({
        task_id: b.task_id,
        cancelled: true,
      });
    });

    const { events } = z
      .object({ events: z.array(z.object({ event: z.string(), actor: z.string() })) })
      .parse(JSON.parse(cli(["log", "--actor", "agent", "--json"])));
    expect(events).toEqual(
      expect.arrayContaining(
        ["update", "set_dependencies", "cancel"].map((event) => ({ event, actor: "agent" })),
      ),
    );
  }, 15_000);

  it("covers claim --create-worktree, worktree list|prune preview, and doctor read-only glue", async () => {
    const makeTask = initWorktreeProject();
    const activeId = makeTask("active lane");
    const orphanId = makeTask("orphan lane");

    const active = claimNew(activeId, "active-lane");
    expect(active.worktree.branch).toBe("feat/active-lane");
    expect((await lstat(active.worktree.worktree_path)).isDirectory()).toBe(true);

    const listed = worktreeList.parse(JSON.parse(cli(["worktree", "list", "--json"])));
    expect(listed.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: await realpath(root), status: "primary", eligible: false }),
        expect.objectContaining({
          path: active.worktree.worktree_path,
          branch: "feat/active-lane",
          status: "active",
          managed: true,
          eligible: false,
        }),
      ]),
    );

    const orphan = claimNew(orphanId, "orphan-lane");
    cli(["release", orphanId, "--lease", orphan.lease_id]);

    const preview = pruneReport.parse(JSON.parse(cli(["worktree", "prune", "--json"])));
    expect(preview).toMatchObject({ apply: false, removed: [], skipped: [] });
    expect(preview.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: active.worktree.worktree_path,
          status: "active",
          eligible: false,
        }),
        expect.objectContaining({
          path: orphan.worktree.worktree_path,
          status: "orphaned",
          eligible: true,
        }),
      ]),
    );
    expect((await lstat(orphan.worktree.worktree_path)).isDirectory()).toBe(true);

    const textPreview = cli(["worktree", "prune"]);
    expect(textPreview).toContain("Pratinjau saja");
    expect(textPreview).toContain("--apply");

    // Reclaim from the dedicated checkout with --worktree (no second create).
    const reclaimed = MCP_TOOLS.claim_task.output.parse(
      JSON.parse(
        cli(["claim", orphanId, "--worktree", "--json"], undefined, {
          cwd: orphan.worktree.worktree_path,
        }),
      ),
    );
    expect(reclaimed.lease_id).not.toBe(orphan.lease_id);
    cli(["release", orphanId, "--lease", reclaimed.lease_id]);

    const applied = pruneReport.parse(JSON.parse(cli(["worktree", "prune", "--apply", "--json"])));
    expect(applied).toMatchObject({
      apply: true,
      removed: [orphan.worktree.worktree_path],
      skipped: [],
    });
    await expect(lstat(orphan.worktree.worktree_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(active.worktree.worktree_path)).isDirectory()).toBe(true);
    expect((await lstat(root)).isDirectory()).toBe(true);

    const healthy = doctor();
    expect(healthy.report.checks).toContainEqual(
      expect.objectContaining({
        id: "git.worktrees",
        status: "ok",
        message: expect.stringContaining("no prunable"),
      }),
    );

    const ghost = join(fixtureDir, "ghost-checkout");
    git("worktree", "add", "-qb", "ghost-lane", ghost);
    await rm(ghost, { recursive: true, force: true });
    const warned = doctor("--fix");
    expect(warned.report.checks).toContainEqual(
      expect.objectContaining({
        id: "git.worktrees",
        status: "warning",
        message: expect.stringMatching(/1 prunable worktree registration/),
      }),
    );
    expect(warned.stdout).toContain("doctor never prunes");
    expect(git("worktree", "list", "--porcelain")).toContain("ghost-lane");
    expect((await lstat(active.worktree.worktree_path)).isDirectory()).toBe(true);
  }, 60_000);

  it("writes stable ServBay/nvm Node launchers into MCP config", async () => {
    async function installVersionedNode(versioned: string, current: string) {
      await mkdir(dirname(versioned), { recursive: true });
      await mkdir(dirname(current), { recursive: true });
      await copyFile(process.execPath, versioned);
      await chmod(versioned, 0o755);
      await symlink(versioned, current);
    }

    const runtime = join(fixtureDir, "runtime");
    const servbayVersioned = join(runtime, "ServBay/package/node/24/24.21.0/bin/node");
    const servbayCurrent = join(runtime, "ServBay/package/node/current/bin/node");
    const nvmVersioned = join(runtime, "home/.nvm/versions/node/v22.11.0/bin/node");
    const nvmCurrent = join(runtime, "home/.nvm/current/bin/node");
    await installVersionedNode(servbayVersioned, servbayCurrent);
    await installVersionedNode(nvmVersioned, nvmCurrent);

    // Hide PATH executables so init must prefer the unversioned ServBay current link.
    const emptyBin = join(runtime, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    env = { ...env, PATH: emptyBin };
    cli(["init", "--platform", "claude-code"], undefined, { command: servbayVersioned });
    const servbayLaunch = await readClaudeLaunch();
    expect(servbayLaunch.command).toBe(servbayCurrent);
    expect(servbayLaunch.command).not.toContain("24.21.0");
    expect(servbayLaunch.args[0]).toBe(await realpath(entry));

    await rm(join(root, ".mcp.json"));
    cli(["init", "--platform", "claude-code", "--yes"], undefined, { command: nvmVersioned });
    const nvmLaunch = await readClaudeLaunch();
    expect(nvmLaunch.command).toBe(nvmCurrent);
    expect(nvmLaunch.command).not.toMatch(/v22\.11\.0/);
  }, 30_000);

  it("memvalidasi platform dan membatasi penulisan serta penghapusan", async () => {
    for (const command of ["init", "sync", "verify", "remove"]) {
      const result = runCli([command, "--platform", "unknown-platform"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Platform tidak didukung");
    }
    cli(["init", "--platform", "claude-code,codex", "--platform", "cursor", "--dry-run"]);
    expect(await readdir(root)).toEqual([]);
    cli(["init", "--platform", "claude-code,codex", "--platform", "cursor"]);
    await expect(readFile(join(root, ".codex/config.toml"), "utf8")).resolves.toContain("catenext");
    const cursor = await readFile(join(root, ".cursor/mcp.json"), "utf8");
    const claude = await readFile(join(root, ".mcp.json"), "utf8");
    cli(["verify", "--platform", "claude-code,codex", "--platform", "cursor"]);
    expect(runCli(["verify", "--platform", "antigravity"]).status).toBe(1);
    cli(["sync", "--platform", "antigravity", "--fix", "--dry-run"]);
    await expect(readFile(join(root, ".agents/mcp_config.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const state = await readFile(join(root, ".catenext/catenext.sqlite")).catch(() => undefined);
    cli(["remove", "--platform", "cursor", "--dry-run"]);
    expect(await readFile(join(root, ".cursor/mcp.json"), "utf8")).toBe(cursor);
    cli(["remove", "--platform", "cursor", "--yes"]);
    const cursorAfter = await readFile(join(root, ".cursor/mcp.json"), "utf8").catch(() => "");
    expect(cursorAfter).not.toContain('"catenext"');
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(claude);
    expect(await readFile(join(root, ".catenext/catenext.sqlite")).catch(() => undefined)).toEqual(
      state,
    );
    cli(["verify", "--platform", "claude-code"]);
    const perms = JSON.parse(cli(["permission", "--json"])) as {
      permissions: Array<{ action: string; principal: string }>;
    };
    expect(perms.permissions).toContainEqual({
      action: "upsert_persona",
      principal: "orchestrator",
    });
    cli(["permission", "revoke", "upsert_persona", "orchestrator"]);
    const permsAfter = JSON.parse(cli(["permission", "list", "--json"])) as {
      permissions: Array<{ action: string; principal: string }>;
    };
    expect(permsAfter.permissions).not.toContainEqual({
      action: "upsert_persona",
      principal: "orchestrator",
    });
  }, 20_000);
});
