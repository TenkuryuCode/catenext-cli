import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as json } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENTRY_MARKER,
  MASTER_MARKER,
  MASTER_PROMPT_FILE,
  PLATFORM_ENTRY_FILES,
} from "./agents/entry-pointers.js";
import { CONFIG_PATH, readConfig, stateFilePath } from "./config.js";
import { AGENTS_MD, BLOCK_START } from "./init/agents-md.js";
import { applyInit, planInit } from "./init/index.js";
import { applyFileEdits, entryIsStale, planRemove, planSync } from "./maintenance.js";
import { planSubagents, SUBAGENT_MARKER } from "./subagents.js";
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

  it("refreshes managed approval instructions without touching config or user text", async () => {
    await write("CATENEXT.md", "<!-- catenext:master -->\nOld master prompt\n");
    await write(
      AGENTS_MD,
      `Team instructions\n\n${BLOCK_START}\nOld gate\n<!-- catenext:end -->\n`,
    );
    const opts = { root, fix: false, defaultCommand: NEW };
    const { edits } = await planSync(opts);
    expect(edits.map(({ path }) => path)).toEqual([AGENTS_MD, "CATENEXT.md"]);
    expect(await read("CATENEXT.md")).toContain("Old master prompt");
    await applyFileEdits(root, edits);
    expect(await read(AGENTS_MD)).toContain("Team instructions");
    expect(await read(AGENTS_MD)).toContain("--if-snapshot");
    expect(await read("CATENEXT.md")).toContain("explicit human reply");
    expect((await planSync(opts)).edits).toEqual([]);
    await write("CATENEXT.md", "Custom master prompt\n");
    expect((await planSync(opts)).edits).toEqual([]);
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
        catenext: {
          command: "node",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal IDE placeholder, not interpolation
          args: ["new.js", "mcp", "--role", "orchestrator", "--root", "${CLAUDE_PROJECT_DIR}"],
        },
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

  it("forces MCP command and AGENTS.md block rewrite when force is true", async () => {
    await rm(join(root, AGENTS_MD), { force: true });
    const plan = await planSync({
      root,
      platforms: ["claude-code"],
      fix: false,
      force: true,
      defaultCommand: NEW,
    });
    expect(plan.edits.map((e) => e.path)).toEqual([".mcp.json", AGENTS_MD]);
    await applyFileEdits(root, plan.edits);
    expect(json(await read(".mcp.json"))).toMatchObject({
      mcpServers: {
        catenext: {
          command: "node",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal IDE placeholder, not interpolation
          args: ["new.js", "mcp", "--role", "orchestrator", "--root", "${CLAUDE_PROJECT_DIR}"],
        },
      },
    });
    expect(await read(AGENTS_MD)).toContain(BLOCK_START);
  });

  it("preserves explicit --role override on --fix while defaulting to --role orchestrator on --force", async () => {
    await write(
      ".agents/mcp_config.json",
      JSON.stringify({
        mcpServers: {
          catenext: {
            command: "catenext",
            args: ["mcp", "--role", "worker", "--root", "/wrong/repo"],
          },
        },
      }),
    );
    const fix = await planSync({
      root,
      platforms: ["antigravity"],
      fix: true,
      defaultCommand: NEW,
    });
    await applyFileEdits(root, fix.edits);
    expect(json(await read(".agents/mcp_config.json"))).toEqual({
      mcpServers: {
        catenext: {
          command: "catenext",
          args: ["mcp", "--role", "worker", "--root", root],
        },
      },
    });

    const force = await planSync({
      root,
      platforms: ["antigravity"],
      fix: false,
      force: true,
      defaultCommand: NEW,
    });
    await applyFileEdits(root, force.edits);
    expect(json(await read(".agents/mcp_config.json"))).toEqual({
      mcpServers: {
        catenext: {
          command: "node",
          args: ["new.js", "mcp", "--role", "orchestrator", "--root", root],
        },
      },
    });
  });

  it("checks platform set membership without rewriting config when same set is reordered", async () => {
    const plan = await planSync({
      root,
      platforms: ["antigravity", "codex", "cursor", "claude-code"],
      fix: false,
      defaultCommand: NEW,
    });
    expect(plan.edits.map((e) => e.path)).not.toContain(CONFIG_PATH);

    const added = await planSync({
      root,
      platforms: ["opencode"],
      fix: false,
      defaultCommand: NEW,
    });
    expect(added.edits.map((e) => e.path)).toContain(CONFIG_PATH);
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

  it("cleans subagent stubs across all selected platforms, CATENEXT.md, and PLATFORM_ENTRY_FILES", async () => {
    const allPlatforms = ["claude-code", "cursor", "codex", "antigravity", "opencode"] as const;
    const syncExtra = await planSync({
      root,
      platforms: ["opencode"],
      fix: false,
      defaultCommand: NEW,
    });
    await applyFileEdits(root, syncExtra.edits);
    const sub = await planSubagents(
      root,
      [{ alias: "be", role: "backend", rules: [], repos: [], scope: "project" }],
      allPlatforms,
    );
    await applyFileEdits(root, sub.edits);
    await write(
      PLATFORM_ENTRY_FILES.opencode ?? ".opencode/CATENEXT.md",
      `${ENTRY_MARKER}\n# opencode\n`,
    );

    expect(await read(MASTER_PROMPT_FILE)).toContain(MASTER_MARKER);
    const partial = await planRemove({ root, platforms: ["cursor"] });
    const partialPaths = partial.map((e) => e.path);
    expect(partialPaths).toContain(PLATFORM_ENTRY_FILES.cursor);
    expect(partialPaths).toContain(join(".cursor", "agents", "be.md"));
    expect(partialPaths).not.toContain(MASTER_PROMPT_FILE);
    expect(partialPaths).not.toContain(PLATFORM_ENTRY_FILES["claude-code"]);

    const full = await planRemove({ root });
    const fullPaths = full.map((e) => e.path);
    expect(fullPaths).toContain(MASTER_PROMPT_FILE);
    for (const p of allPlatforms) {
      const entry = PLATFORM_ENTRY_FILES[p];
      if (entry) expect(fullPaths).toContain(entry);
    }
    expect(fullPaths).toContain(join(".claude", "agents", "be.md"));
    expect(fullPaths).toContain(join(".cursor", "agents", "be.md"));
    expect(fullPaths).toContain(join(".agents", "agents", "be.md"));
    expect(fullPaths).toContain(join(".codex", "agents", "be.toml"));
    expect(fullPaths).toContain(join(".opencode", "agents", "be.md"));
    await applyFileEdits(root, full);
    await expect(read(MASTER_PROMPT_FILE)).rejects.toMatchObject({ code: "ENOENT" });
    for (const p of allPlatforms) {
      const entry = PLATFORM_ENTRY_FILES[p];
      if (entry) await expect(read(entry)).rejects.toMatchObject({ code: "ENOENT" });
    }
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
