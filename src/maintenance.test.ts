import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as json } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_PATH, readConfig, stateFilePath } from "./config.js";
import { applyInit, planInit } from "./init/index.js";
import { applyFileEdits, entryIsStale, planRemove, planSync } from "./maintenance.js";
import { SUBAGENT_MARKER } from "./subagents.js";
import { verifySetup } from "./verify.js";

const CMD = { command: "catenext", args: [] as string[] };
const NEW = () => ({ command: "node", args: ["new.js"] });
let root: string;
const read = (path: string) => readFile(join(root, path), "utf8");
const write = async (path: string, contents: string) => {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), contents);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-maint-"));
  await write(
    ".mcp.json",
    '{\n  // user comment\n  "mcpServers": { "gh": { "command": "gh", "args": [] } }\n}\n',
  );
  await applyInit(root, await planInit({ root, mcpCommand: CMD }));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("local sync", () => {
  it("does not replace a working custom command", async () => {
    expect((await planSync({ root, fix: false, defaultCommand: NEW })).edits).toEqual([]);
  });

  it("repairs duplicates and stale commands only with --fix and keeps comments", async () => {
    const source =
      '{"mcpServers": {\n  "catenext":{"command":"catenext","args":["mcp"]},\n  // neighbor comment\n  "x"  : {"command":"x","args":[]},\n  "catenext":{"command":"/gone/node","args":["/gone/script.js","mcp"]},\n}}\n';
    await write(".mcp.json", source);
    const opts = { root, platforms: ["claude-code"] as const, defaultCommand: NEW };
    const plan = await planSync({ ...opts, fix: false });
    expect(plan.edits).toEqual([]);
    expect(plan.findings).toMatchObject([{ level: "fixable" }]);
    const fix = await planSync({ ...opts, fix: true });
    expect(await read(".mcp.json")).toBe(source);
    await applyFileEdits(root, fix.edits);
    const text = await read(".mcp.json");
    expect(text.match(/"catenext"/g)).toHaveLength(1);
    expect(text).toContain('// neighbor comment\n  "x"  : {"command":"x","args":[]},');
    expect(json(text)).toMatchObject({
      mcpServers: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal IDE placeholder, not interpolation
        catenext: { command: "node", args: ["new.js", "mcp", "--root", "${CLAUDE_PROJECT_DIR}"] },
      },
    });
  });

  it("does not replace malformed files even with fix", async () => {
    const source = "{broken";
    await write(".cursor/mcp.json", source);
    const { edits, findings } = await planSync({
      root,
      platforms: ["cursor"],
      fix: true,
      defaultCommand: NEW,
    });
    expect(edits).toEqual([]);
    expect(findings).toMatchObject([{ level: "warn" }]);
    expect(await read(".cursor/mcp.json")).toBe(source);
  });

  it("tracks explicitly added platforms and refuses stale plans", async () => {
    const { edits } = await planSync({
      root,
      platforms: ["vscode"],
      fix: false,
      defaultCommand: NEW,
    });
    expect(edits.map(({ path }) => path)).toEqual([".vscode/mcp.json", CONFIG_PATH]);
    await write(".vscode/mcp.json", '{"servers":{}}');
    await expect(applyFileEdits(root, edits)).rejects.toThrow(/berubah/);
    const updated = await planSync({
      root,
      platforms: ["vscode"],
      fix: false,
      defaultCommand: NEW,
    });
    await applyFileEdits(root, updated.edits);
    expect((await readConfig(root)).platforms).toContain("vscode");
  });
});

describe("local remove", () => {
  it("removes only selected adapter and preserves project, state, unrelated configs and skills", async () => {
    const config = await readConfig(root);
    const cursor = await read(".cursor/mcp.json");
    await write(".catenext/state.json", '{"private":true}');
    await write(".catenext/skills/dev.md", "keep skill");
    const edits = await planRemove({ root, platforms: ["claude-code"] });
    expect(json(await read(".mcp.json")).mcpServers.catenext).toBeTruthy();
    await applyFileEdits(root, edits);
    expect(await read(".mcp.json")).toContain("// user comment");
    expect(json(await read(".mcp.json"))).toEqual({
      mcpServers: { gh: { command: "gh", args: [] } },
    });
    expect(await read(".cursor/mcp.json")).toBe(cursor);
    expect(await readConfig(root)).toMatchObject({
      project_id: config.project_id,
      platforms: ["cursor", "codex", "antigravity"],
    });
    expect(await read(".catenext/state.json")).toBe('{"private":true}');
    expect(await read(".catenext/skills/dev.md")).toBe("keep skill");
  });

  it("keeps custom state linkage after full removal; sync does not reinstall", async () => {
    const project = await readConfig(root);
    await write(
      CONFIG_PATH,
      `${await read(CONFIG_PATH)}state_file: .catenext/skills/custom-state.md\n`,
    );
    await write(".catenext/skills/custom-state.md", '{"private":true}');
    await write(".claude/agents/local.md", "unmanaged\n");
    await write(".claude/agents/generated.md", `${SUBAGENT_MARKER}\n`);
    await applyFileEdits(root, await planRemove({ root, all: true }));
    expect(await readConfig(root)).toMatchObject({
      project_id: project.project_id,
      platforms: [],
      state_file: ".catenext/skills/custom-state.md",
    });
    expect(await read(".catenext/skills/custom-state.md")).toBe('{"private":true}');
    expect(await read(".gitignore")).toContain(".catenext/state.json");
    expect(await read(".claude/agents/local.md")).toBe("unmanaged\n");
    await expect(read(".claude/agents/generated.md")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await planRemove({ root })).toEqual([]);
    expect((await planSync({ root, fix: true, defaultCommand: NEW })).edits).toEqual([]);
  });

  it("does not delete a foreign MCP server using the same name", async () => {
    const foreign =
      '{"mcpServers":{"catenext":{"url":"https://other.example"},"other":{"command":"tool"}}}';
    await write(".agents/mcp_config.json", foreign);
    await applyFileEdits(root, await planRemove({ root, platforms: ["antigravity"] }));
    expect(await read(".agents/mcp_config.json")).toBe(foreign);
  });
});

it("flags only missing absolute launch paths and leaves PATH commands alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catenext-stale-"));
  try {
    const script = join(dir, "_npx", "catenext.mjs");
    await mkdir(join(dir, "_npx"), { recursive: true });
    await writeFile(script, "");
    expect(entryIsStale({ command: "node", args: [script, "mcp"] })).toBe(false);
    expect(entryIsStale({ command: "node", args: [join(dir, "gone.js"), "mcp"] })).toBe(true);
    expect(entryIsStale({ command: "npx", args: ["-y", "catenext", "mcp"] })).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("verifySetup", () => {
  it("memeriksa izin file state SQLite 0600 pada POSIX", async () => {
    const config = await readConfig(root);
    const state = stateFilePath(root, config);
    await writeFile(state, "");
    await chmod(state, 0o644);
    const failed = await verifySetup(root, config, ["claude-code"]);
    const stateCheckBad = failed.find((line) => line.label.includes(state));
    if (process.platform !== "win32") {
      expect(stateCheckBad?.ok).toBe(false);
      expect(stateCheckBad?.hint).toContain("chmod 600");
    }

    await chmod(state, 0o600);
    const passed = await verifySetup(root, config, ["claude-code"]);
    const stateCheckOk = passed.find((line) => line.label.includes(state));
    expect(stateCheckOk?.ok).toBe(true);
  });
});
