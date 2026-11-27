import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PLATFORMS, type PlatformId } from "@catenext/shared";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CONFIG_PATH, readConfig } from "../config.js";
import { ensureGitignore } from "./gitignore.js";
import { applyInit, planInit, renderDiff } from "./index.js";
import { CURSOR_WORKSPACE_FOLDER, inspectMcp, selectedAdapters } from "./mcp-config.js";

const CMD = { command: "node", args: ["cli.js"] };
const PROJECT = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const PLATFORMS: PlatformId[] = [...DEFAULT_PLATFORMS, "opencode", "vscode"];
const REPO_DIR = process.platform === "win32" ? "Repo (spaces)" : 'Repo "spaces"';
let workspace: string;
let root: string;
let home: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "catenext-init-"));
  root = join(workspace, REPO_DIR);
  home = join(workspace, "fake-home");
  await mkdir(root);
  await mkdir(join(home, ".gemini", "config"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"dependencies":{"hono":"4"}}');
});
afterEach(() => rm(workspace, { recursive: true, force: true }));

async function write(path: string, contents: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), contents);
}

it("plans default adapters without writing, then applies repo-scoped launches", async () => {
  const global = join(home, ".gemini/config/mcp_config.json");
  await writeFile(global, '{"mcpServers":{"other":{}}}');
  const changes = await planInit({ root, mcpCommand: CMD });
  expect(changes.map(({ path }) => path)).toEqual([
    CONFIG_PATH,
    ".mcp.json",
    ".cursor/mcp.json",
    ".codex/config.toml",
    ".agents/mcp_config.json",
    ".gitignore",
    "AGENTS.md",
    "CATENEXT.md",
    "CLAUDE.md",
    ".cursor/CATENEXT.md",
    ".codex/CATENEXT.md",
    ".agents/CATENEXT.md",
  ]);
  expect(await readdir(root)).toEqual(["package.json"]);
  expect(renderDiff(changes)).toContain("+repo_name: repo-spaces");
  await applyInit(root, changes);
  const config = await readConfig(root);
  expect(config).toMatchObject({
    repo_name: "repo-spaces",
    project_name: REPO_DIR,
    stack: ["node", "hono"],
    platforms: DEFAULT_PLATFORMS,
  });
  expect(config.project_id).toMatch(/^[\da-f-]{36}$/);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal IDE placeholder, not interpolation
  const expectedRoots = ["${CLAUDE_PROJECT_DIR}", CURSOR_WORKSPACE_FOLDER, root, root];
  for (const [i, adapter] of (await selectedAdapters(root, DEFAULT_PLATFORMS)).entries()) {
    const source = await readFile(join(root, adapter.path), "utf8");
    expect(inspectMcp(source, adapter)).toEqual({
      count: 1,
      entry: { command: "node", args: ["cli.js", "mcp", "--root", expectedRoots[i]] },
      managed: true,
      compatible: true,
    });
    if (adapter.kind !== "toml") expect(() => JSON.parse(source)).not.toThrow();
  }
  expect(await readFile(global, "utf8")).toBe('{"mcpServers":{"other":{}}}');
  const master = await readFile(join(root, "CATENEXT.md"), "utf8");
  expect(master).toContain("## Bootstrap (install if missing)");
  expect(master).toContain("npm install -g catenext");
  expect(await planInit({ root, mcpCommand: CMD })).toEqual([]);
});

it("supports OpenCode workspace JSONC and VS Code editor-managed workspace config", async () => {
  const openCode =
    '{\n  "mcp": {\n    // retain formatting\n    "other"  :  {"type":"local","command":["tool"]},\n  },\n}\n';
  await write("opencode.jsonc", openCode);
  await applyInit(root, await planInit({ root, platforms: PLATFORMS, mcpCommand: CMD }));
  const text = await readFile(join(root, "opencode.jsonc"), "utf8");
  expect(text).toContain(
    '// retain formatting\n    "other"  :  {"type":"local","command":["tool"]},',
  );
  expect(parse(text)).toMatchObject({
    mcp: {
      catenext: {
        type: "local",
        command: ["node", "cli.js", "mcp", "--root", root],
        enabled: true,
      },
    },
  });
  const vscode = JSON.parse(await readFile(join(root, ".vscode/mcp.json"), "utf8"));
  expect(vscode).toEqual({
    servers: {
      catenext: { type: "stdio", command: "node", args: ["cli.js", "mcp", "--root", root] },
    },
  });
  const pointers = [
    "CLAUDE.md",
    ".cursor/CATENEXT.md",
    ".codex/CATENEXT.md",
    ".agents/CATENEXT.md",
    ".opencode/CATENEXT.md",
    ".vscode/CATENEXT.md",
  ];
  for (const path of pointers) {
    const pointer = await readFile(join(root, path), "utf8");
    expect(pointer).toMatch(/\]\(\.{1,2}\/CATENEXT\.md\)/);
    expect(pointer).toMatch(/\]\(\.{1,2}\/AGENTS\.md\)/);
    expect(pointer).not.toContain("--if-snapshot");
  }
  const master = await readFile(join(root, "CATENEXT.md"), "utf8");
  expect(master).toContain("wait for its explicit human reply");
  const rules = await readFile(join(root, "AGENTS.md"), "utf8");
  expect(rules).toContain("fresh, explicit approval in a direct human reply");
  expect(rules).toContain("Never fall back to an unguarded command yourself");
  expect(rules).toContain("Use the exact snapshot captured before asking");
  expect(rules).toContain("board --task <id> --json");
  expect(rules).toContain("never authorizes any PR, push, merge, tag, or publication");
  const vscodeEntry = await readFile(join(root, ".vscode/CATENEXT.md"), "utf8");
  expect(vscodeEntry).toContain("VS Code · Catenext entry");
  expect(vscodeEntry).toContain(".github/agents/");
  expect(await planInit({ root, mcpCommand: CMD })).toEqual([]);
});

it("adds a selection without replacing project identity or previous launcher", async () => {
  await applyInit(
    root,
    await planInit({ root, projectId: PROJECT, platforms: ["cursor"], mcpCommand: CMD }),
  );
  const config = await readFile(join(root, CONFIG_PATH), "utf8");
  const cursor = await readFile(join(root, ".cursor/mcp.json"), "utf8");
  await write(CONFIG_PATH, `${config}state_file: ../project-state.json # managed by team\n`);
  await applyInit(
    root,
    await planInit({
      root,
      platforms: ["codex", "cursor"],
      mcpCommand: { command: "new", args: [] },
    }),
  );
  expect(await readConfig(root)).toMatchObject({
    project_id: PROJECT,
    platforms: ["cursor", "codex"],
    state_file: "../project-state.json",
  });
  expect(await readFile(join(root, CONFIG_PATH), "utf8")).toContain("# managed by team");
  expect(await readFile(join(root, ".cursor/mcp.json"), "utf8")).toBe(cursor);
  await expect(
    planInit({ root, projectId: "25c8b7a2-fc5a-4407-bae7-4294a5b604f2", mcpCommand: CMD }),
  ).rejects.toThrow(/identitas/);
});

it("refuses broken configs, foreign entires, symlink paths and global-only Windsurf", async () => {
  await write(".mcp.json", '{"mcpServers":{"catenext":{"url":"https://other.example"}}}');
  await expect(planInit({ root, platforms: ["claude-code"], mcpCommand: CMD })).rejects.toThrow(
    /tidak disentuh/,
  );
  await write(".mcp.json", "{broken");
  await expect(planInit({ root, platforms: ["claude-code"], mcpCommand: CMD })).rejects.toThrow(
    /JSON/,
  );
  await symlink(join(home, ".gemini/config"), join(root, ".agents"), "junction");
  await expect(planInit({ root, platforms: ["antigravity"], mcpCommand: CMD })).rejects.toThrow(
    /symlink/,
  );
  await expect(planInit({ root, platforms: ["windsurf"], mcpCommand: CMD })).rejects.toThrow(
    /global/,
  );
});

it("preserves existing AGENTS.md and allows opting out on init", async () => {
  await write("AGENTS.md", "# Team\n\nUse pnpm.\n");
  const opts = { root, mcpCommand: CMD, platforms: [] };
  expect((await planInit({ ...opts, agentsMd: false })).map(({ path }) => path)).not.toContain(
    "AGENTS.md",
  );
  await applyInit(root, await planInit(opts));
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toMatch(/^# Team\n\nUse pnpm\.\n/);
});

it("adds local state ignores once without rewriting existing rules", () => {
  const once = ensureGitignore("node_modules/\r\n");
  expect(once).toContain(".catenext/catenext.sqlite\r\n");
  expect(once).toContain(".catenext/state.json\r\n");
  expect(ensureGitignore(once)).toBe(once);
  expect(ensureGitignore("/.catenext/\n")).toBe("/.catenext/\n");
});
