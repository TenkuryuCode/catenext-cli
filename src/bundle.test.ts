import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("zero-runtime-dep CLI bundle", () => {
  it("tidak memiliki runtime dependencies di package.json", () => {
    const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.devDependencies).toMatchObject({
      "@modelcontextprotocol/sdk": expect.any(String),
      commander: expect.any(String),
      diff: expect.any(String),
      "jsonc-parser": expect.any(String),
      "toml-eslint-parser": expect.any(String),
      yaml: expect.any(String),
      zod: expect.any(String),
    });
  });

  it("membangun dist/index.js tanpa .map dan berjalan terisolasi tanpa node_modules", () => {
    execFileSync(process.execPath, [join(CLI_DIR, "build.mjs")], {
      cwd: CLI_DIR,
      encoding: "utf8",
    });

    const distFiles = readdirSync(join(CLI_DIR, "dist"));
    expect(distFiles).toEqual(["index.js"]);
    expect(distFiles.some((f) => f.endsWith(".map"))).toBe(false);

    const sizeBytes = statSync(join(CLI_DIR, "dist/index.js")).size;
    expect(sizeBytes).toBeLessThan(1_500_000);

    const isolated = mkdtempSync(join(tmpdir(), "catenext-bundle-isolated-"));
    try {
      const bin = join(isolated, "catenext.js");
      cpSync(join(CLI_DIR, "dist/index.js"), bin);

      const version = execFileSync(process.execPath, [bin, "--version"], {
        cwd: isolated,
        encoding: "utf8",
      }).trim();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);

      const repo = join(isolated, "repo");
      execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
      execFileSync(process.execPath, [bin, "init", "--platform", "claude-code,codex,cursor"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(existsSync(join(repo, ".mcp.json"))).toBe(true);
      expect(existsSync(join(repo, ".codex/config.toml"))).toBe(true);
      expect(existsSync(join(repo, ".cursor/mcp.json"))).toBe(true);

      const mcp = spawnSync(process.execPath, [bin, "mcp", "--root", repo], {
        cwd: isolated,
        encoding: "utf8",
        input: [
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "isolated", version: "1.0" },
            },
          }),
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
          JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "session_brief", arguments: {} },
          }),
        ]
          .map((l) => `${l}\n`)
          .join(""),
        timeout: 5000,
      });

      expect(mcp.status).toBe(0);
      const responses = mcp.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> });
      expect(responses).toHaveLength(4);
      expect(responses[0]?.result).toMatchObject({ serverInfo: { name: "catenext" } });
      expect(responses[1]?.result).toEqual({});
      expect((responses[2]?.result as { tools?: unknown[] })?.tools?.length).toBeGreaterThan(0);
      expect(responses[3]?.result).toMatchObject({
        content: [{ type: "text", text: expect.any(String) }],
      });
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  }, 20_000);
});
