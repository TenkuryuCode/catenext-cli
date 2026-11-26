import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_TOOLS, type McpToolName, type McpToolOutput } from "@catenext/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

let scratch: string;
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
  scratch = await mkdtemp(join(tmpdir(), "catenext-cli-stdio-"));
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
  root = await mkdtemp(join(scratch, "project-"));
  const home = join(root, "home");
  await mkdir(home);
  env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    npm_config_offline: "true",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function runCli(args: string[], input?: string) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    input,
    timeout: 5000,
  });
  if (result.error) throw result.error;
  return result;
}

function cli(args: string[], input?: string): string {
  const result = runCli(args, input);
  if (result.status !== 0) {
    throw new Error(
      `catenext ${args.join(" ")} exited ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function cliJson<N extends McpToolName>(name: N, args: string[], input?: string): McpToolOutput<N> {
  return MCP_TOOLS[name].output.parse(
    JSON.parse(cli([...args, "--json"], input)),
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

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

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
      expect(stderr).toContain("[catenext]");
    } finally {
      await client.close();
      await transport.close();
    }
  }, 20_000);

  it("memvalidasi platform dan membatasi penulisan serta penghapusan", async () => {
    for (const command of ["init", "sync", "verify", "remove"]) {
      const result = runCli([command, "--platform", "unknown-platform"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Platform tidak didukung");
    }
    cli(["init", "--platform", "claude-code,codex", "--platform", "cursor", "--dry-run"]);
    expect(await readdir(root)).toEqual(["home"]);
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
