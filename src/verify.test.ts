import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema, type PlatformId } from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateFilePath } from "./config.js";
import { applyInit, planInit } from "./init/index.js";
import { entryMatchesRoot, selectedAdapters, WINDSURF_UNSUPPORTED } from "./init/mcp-config.js";
import { formatChecks, verifySetup } from "./verify.js";

const CLAUDE_ROOT_TOKEN = "$" + "{CLAUDE_PROJECT_DIR}";
const CMD = { command: "catenext", args: [] as string[] };
let root: string;

function makeConfig(platforms?: PlatformId[], stateFile?: string) {
  return CatenextConfigSchema.parse({
    schema_version: 1,
    project_id: randomUUID(),
    project_name: "VerifyTest",
    repo_name: "catenext-app",
    ...(platforms !== undefined ? { platforms } : {}),
    ...(stateFile !== undefined ? { state_file: stateFile } : {}),
  });
}

async function writeRepo(rel: string, content: string) {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-verify-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("verifySetup", () => {
  it("passes for valid init setup even before state sqlite file exists", async () => {
    await applyInit(
      root,
      await planInit({
        root,
        platforms: ["claude-code", "cursor", "vscode", "codex", "antigravity", "opencode"],
        mcpCommand: CMD,
      }),
    );
    const config = makeConfig([
      "claude-code",
      "cursor",
      "vscode",
      "codex",
      "antigravity",
      "opencode",
    ]);
    const lines = await verifySetup(root, config);

    expect(lines[0]).toEqual({ ok: true, label: "Config lokal valid: catenext-app" });
    expect(lines[1]).toEqual({
      ok: true,
      label: `State belum dibuat: ${stateFilePath(root, config)}`,
    });
    expect(lines.every((l) => l.ok)).toBe(true);
    expect(lines.map((l) => l.label)).toEqual(
      expect.arrayContaining([
        "Claude Code: .mcp.json",
        "VS Code: .vscode/mcp.json",
        "Cursor: .cursor/mcp.json",
        "Codex: .codex/config.toml",
        "Antigravity: .agents/mcp_config.json",
        "OpenCode: opencode.jsonc",
      ]),
    );
  });

  it("checks state file permissions (0600 ok vs 0644 fail) on POSIX", async () => {
    const config = makeConfig([]);
    const state = stateFilePath(root, config);
    await mkdir(join(state, ".."), { recursive: true });
    await writeFile(state, "sqlite");
    await chmod(state, 0o644);

    const bad = await verifySetup(root, config, []);
    const badState = bad.find((l) => l.label === `File state lokal: ${state}`);
    if (process.platform !== "win32") {
      expect(badState?.ok).toBe(false);
      expect(badState?.hint).toContain(`chmod 600 ${state}`);
    }

    await chmod(state, 0o600);
    const ok = await verifySetup(root, config, []);
    const okState = ok.find((l) => l.label === `File state lokal: ${state}`);
    expect(okState).toEqual({ ok: true, label: `File state lokal: ${state}`, hint: undefined });
  });

  it("flags symlink and hardlink state files as non-regular", async () => {
    const config = makeConfig([]);
    const state = stateFilePath(root, config);
    const target = join(root, "real.sqlite");
    await mkdir(join(state, ".."), { recursive: true });
    await writeFile(target, "data");
    await chmod(target, 0o600);

    await symlink(target, state);
    const symLines = await verifySetup(root, config, []);
    const symCheck = symLines.find((l) => l.label === `File state lokal: ${state}`);
    expect(symCheck).toEqual({
      ok: false,
      label: `File state lokal: ${state}`,
      hint: "State harus file biasa, bukan symlink atau hardlink.",
    });

    await rm(state);
    await link(target, state);
    const hardLines = await verifySetup(root, config, []);
    const hardCheck = hardLines.find((l) => l.label === `File state lokal: ${state}`);
    expect(hardCheck).toEqual({
      ok: false,
      label: `File state lokal: ${state}`,
      hint: "State harus file biasa, bukan symlink atau hardlink.",
    });
  });

  it("rethrows non-ENOENT lstat errors on state file", async () => {
    await writeRepo("not-a-dir", "plain file");
    const config = makeConfig([], "not-a-dir/state.sqlite");
    await expect(verifySetup(root, config, [])).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("reports windsurf unsupported and empty platform selection", async () => {
    const config = makeConfig(["windsurf"]);
    const windsurfLines = await verifySetup(root, config);
    expect(windsurfLines).toContainEqual({
      ok: false,
      label: "Windsurf",
      hint: WINDSURF_UNSUPPORTED,
    });

    const emptyLines = await verifySetup(root, makeConfig([]), []);
    expect(emptyLines).toContainEqual({
      ok: true,
      label: "Tidak ada platform MCP yang dipilih.",
    });
  });

  it("falls back to default claude-code + cursor when config.platforms is omitted", async () => {
    const config = makeConfig(undefined);
    const lines = await verifySetup(root, config);
    expect(lines.map((l) => l.label)).toEqual(
      expect.arrayContaining(["Claude Code: .mcp.json", "Cursor: .cursor/mcp.json"]),
    );
    expect(lines.find((l) => l.label === "Claude Code: .mcp.json")?.ok).toBe(false);
  });

  it("diagnoses missing MCP config, missing entry, foreign entry, duplicate/stale/wrong-root entries, and malformed config", async () => {
    const config = makeConfig(["claude-code"]);

    // 1. Missing file
    let lines = await verifySetup(root, config, ["claude-code"]);
    expect(lines.find((l) => l.label === "Claude Code: .mcp.json")).toEqual({
      ok: false,
      label: "Claude Code: .mcp.json",
      hint: "Entri catenext belum ada. Jalankan `catenext init` atau `catenext sync`.",
    });

    // 2. File exists without catenext entry
    await writeRepo(".mcp.json", JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    lines = await verifySetup(root, config, ["claude-code"]);
    expect(lines.find((l) => l.label === "Claude Code: .mcp.json")?.hint).toContain(
      "Entri catenext belum ada",
    );

    // 3. Foreign/unmanaged entry
    await writeRepo(
      ".mcp.json",
      JSON.stringify({ mcpServers: { catenext: { url: "https://other.example" } } }),
    );
    lines = await verifySetup(root, config, ["claude-code"]);
    expect(lines.find((l) => l.label === "Claude Code: .mcp.json")?.hint).toBe(
      "Nama catenext dipakai oleh entri yang tidak dikelola. Periksa secara manual.",
    );

    // 4. Duplicate catenext entries
    await writeRepo(
      ".mcp.json",
      `{"mcpServers":{"catenext":{"command":"catenext","args":["mcp","--root","${CLAUDE_ROOT_TOKEN}"]},"catenext":{"command":"catenext","args":["mcp","--root","${CLAUDE_ROOT_TOKEN}"]}}}`,
    );
    lines = await verifySetup(root, config, ["claude-code"]);
    expect(lines.find((l) => l.label === "Claude Code: .mcp.json")?.hint).toBe(
      "Entri ganda, basi, atau tidak sesuai repo. Jalankan `catenext sync --fix`.",
    );

    // 5. Wrong --root path (using antigravity which takes an absolute path)
    await writeRepo(
      ".agents/mcp_config.json",
      JSON.stringify({
        mcpServers: { catenext: { command: "catenext", args: ["mcp", "--root", "/other/repo"] } },
      }),
    );
    lines = await verifySetup(root, config, ["antigravity"]);
    expect(lines.find((l) => l.label === "Antigravity: .agents/mcp_config.json")?.hint).toBe(
      "Entri ganda, basi, atau tidak sesuai repo. Jalankan `catenext sync --fix`.",
    );

    // 6. Stale absolute script path
    await writeRepo(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          catenext: {
            command: "node",
            args: [join(root, "missing-dist.js"), "mcp", "--root", CLAUDE_ROOT_TOKEN],
          },
        },
      }),
    );
    lines = await verifySetup(root, config, ["claude-code"]);
    expect(lines.find((l) => l.label === "Claude Code: .mcp.json")?.hint).toBe(
      "Entri ganda, basi, atau tidak sesuai repo. Jalankan `catenext sync --fix`.",
    );

    // 7. Malformed JSON -> McpConfigError message surfaced
    await writeRepo(".mcp.json", "{broken");
    lines = await verifySetup(root, config, ["claude-code"]);
    const broken = lines.find((l) => l.label === "Claude Code: .mcp.json");
    expect(broken?.ok).toBe(false);
    expect(broken?.hint).toBeTruthy();
  });

  it("selectedAdapters inspects opencode existing file vs default opencode.jsonc", async () => {
    const adaptersDefault = await selectedAdapters(root, ["opencode"]);
    expect(adaptersDefault[0]?.path).toBe("opencode.jsonc");

    await writeRepo(".opencode/opencode.json", '{"mcp":{}}');
    const adaptersExisting = await selectedAdapters(root, ["opencode"]);
    const adapter = adaptersExisting[0];
    expect(adapter?.path).toBe(".opencode/opencode.json");
    if (!adapter) throw new Error("Expected opencode adapter");
    expect(
      entryMatchesRoot({ command: "catenext", args: ["mcp", "--root", root] }, root, adapter),
    ).toBe(true);
  });
});

describe("formatChecks", () => {
  it("formats passing, failing with hint, and failing without hint lines", () => {
    const out = formatChecks([
      { ok: true, label: "Config valid", hint: "ignored when ok" },
      { ok: false, label: "State bad", hint: "Run chmod 600" },
      { ok: false, label: "No hint fail" },
    ]);
    expect(out).toBe(
      ["✓ Config valid", "✗ State bad\n    → Run chmod 600", "✗ No hint fail"].join("\n"),
    );
  });
});
