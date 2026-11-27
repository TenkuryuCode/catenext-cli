import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    expect(sizeBytes).toBeLessThan(1_000_000);

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
      expect(existsSync(join(repo, ".codex", "config.toml"))).toBe(true);
      expect(existsSync(join(repo, ".cursor", "mcp.json"))).toBe(true);

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
          JSON.stringify({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "get_project_board", arguments: { limit: "not-a-number" } },
          }),
        ]
          .map((l) => `${l}\n`)
          .join(""),
        timeout: 5000,
      });

      expect(mcp.status).toBe(0);
      const responses = mcp.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> });
      expect(responses).toHaveLength(5);
      const byId = new Map(responses.map((r) => [r.id, r.result]));
      expect(byId.get(1)).toMatchObject({ serverInfo: { name: "catenext" } });
      expect(byId.get(2)).toEqual({});
      expect((byId.get(3) as { tools?: unknown[] })?.tools?.length).toBeGreaterThan(0);
      expect(byId.get(4)).toMatchObject({
        content: [{ type: "text", text: expect.any(String) }],
      });
      expect(byId.get(5)).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringMatching(/number/i) }],
      });
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  }, 20_000);

  it("menjalankan init, doctor, backup, restore, dan worktree list pada dist/index.js secara lintas platform", () => {
    const distBin = join(CLI_DIR, "dist", "index.js");
    if (!existsSync(distBin)) {
      execFileSync(process.execPath, [join(CLI_DIR, "build.mjs")], {
        cwd: CLI_DIR,
        encoding: "utf8",
      });
    }

    const isolated = realpathSync(mkdtempSync(join(tmpdir(), "catenext-bundle-smoke-")));
    try {
      const repo = join(isolated, "repo");
      execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Catenext Smoke",
          "-c",
          "user.email=smoke@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "smoke fixture",
        ],
        { cwd: repo, encoding: "utf8" },
      );

      execFileSync(process.execPath, [distBin, "init", "--yes", "--platform", "cursor"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(existsSync(join(repo, ".catenext", "config.yaml"))).toBe(true);
      expect(existsSync(join(repo, ".catenext", "catenext.sqlite"))).toBe(true);
      expect(existsSync(join(repo, ".cursor", "mcp.json"))).toBe(true);

      const doctorReport = JSON.parse(
        execFileSync(process.execPath, [distBin, "doctor", "--json"], {
          cwd: repo,
          encoding: "utf8",
        }),
      ) as { ok: boolean; checks: Array<{ id: string; status: string }> };
      expect(doctorReport.ok).toBe(true);
      const expectedIntegrityStatus = "deserialize" in DatabaseSync.prototype ? "ok" : "skipped";
      expect(doctorReport.checks).toContainEqual(
        expect.objectContaining({ id: "sqlite.integrity", status: expectedIntegrityStatus }),
      );
      expect(existsSync(join(repo, ".catenext", "catenext.sqlite-wal"))).toBe(false);
      expect(existsSync(join(repo, ".catenext", "catenext.sqlite-shm"))).toBe(false);

      const backupPath = join(isolated, "snapshot.sqlite");
      const backupResult = JSON.parse(
        execFileSync(process.execPath, [distBin, "backup", backupPath, "--json"], {
          cwd: repo,
          encoding: "utf8",
        }),
      ) as { ok: boolean; out: string; bytes: number; mode: string | null };
      expect(backupResult.ok).toBe(true);
      expect(backupResult.out).toBe(backupPath);
      expect(backupResult.bytes).toBeGreaterThan(0);
      expect(existsSync(backupPath)).toBe(true);
      if (process.platform !== "win32") {
        expect(backupResult.mode).toBe("0600");
        expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      } else {
        expect(backupResult.mode).toBeNull();
      }

      const restoreResult = JSON.parse(
        execFileSync(process.execPath, [distBin, "restore", backupPath, "--force", "--json"], {
          cwd: repo,
          encoding: "utf8",
        }),
      ) as { ok: boolean; stateFile: string; safetyBackup?: string };
      expect(restoreResult.ok).toBe(true);
      expect(restoreResult.stateFile).toBe(join(repo, ".catenext", "catenext.sqlite"));
      expect(restoreResult.safetyBackup).toBeTruthy();
      expect(existsSync(restoreResult.safetyBackup as string)).toBe(true);

      const worktreeResult = JSON.parse(
        execFileSync(process.execPath, [distBin, "worktree", "list", "--json"], {
          cwd: repo,
          encoding: "utf8",
        }),
      ) as { worktrees: Array<{ primary: boolean; status: string; branch: string | null }> };
      expect(worktreeResult.worktrees).toHaveLength(1);
      expect(worktreeResult.worktrees[0]).toMatchObject({
        primary: true,
        status: "primary",
        branch: "main",
      });
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  }, 30_000);
});
