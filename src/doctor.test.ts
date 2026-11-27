import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENTRY_MARKER,
  MASTER_MARKER,
  MASTER_PROMPT_FILE,
  renderMasterPrompt,
} from "./agents/entry-pointers.js";
import { openDatabaseAt } from "./db/open.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { BLOCK_START } from "./init/agents-md.js";
import { CURSOR_WORKSPACE_FOLDER } from "./init/mcp-config.js";
import { renderOrchestratorStub } from "./subagents.js";

let root: string;
let state: string;

async function config(platforms: string[] = []): Promise<void> {
  await writeFile(
    join(root, ".catenext/config.yaml"),
    JSON.stringify({
      project_id: randomUUID(),
      repo_name: "fixture",
      schema_version: 1,
      platforms,
    }),
  );
  await writeFile(join(root, MASTER_PROMPT_FILE), `${MASTER_MARKER}\nfixture master\n`);
  await writeFile(
    join(root, "AGENTS.md"),
    `# Fixture\n\n${BLOCK_START}\nfixture\n<!-- catenext:end -->\n`,
  );
}

function createState(): DatabaseSync {
  const db = new DatabaseSync(state);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE synthetic (id INTEGER PRIMARY KEY)");
  return db;
}

async function doctor(fix = false) {
  return runDoctor({ cwd: root, version: "0.10.0", fix });
}

function git(...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

describe("doctor", () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "catenext-doctor-fixture-")));
    await mkdir(join(root, ".catenext"));
    state = join(root, ".catenext/catenext.sqlite");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("checks journal-free WAL state without modifying project files", async () => {
    await config();
    createState().close();
    await chmod(state, 0o600);
    const original = await readFile(state);
    const entries = await readdir(join(root, ".catenext"));
    const { mtimeMs } = await lstat(state);
    const report = await doctor();
    expect(report.ok).toBe(true);
    const supportsSnapshot = "deserialize" in DatabaseSync.prototype;
    const status = supportsSnapshot ? "ok" : "skipped";
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sqlite.wal", status: "ok" }),
        expect.objectContaining({ id: "sqlite.integrity", status }),
        expect.objectContaining({ id: "cli.version", status: "skipped" }),
      ]),
    );
    expect(formatDoctorReport(report)).toContain(`[${status}] sqlite.integrity`);
    expect(await readdir(join(root, ".catenext"))).toEqual(entries);
    expect(await readFile(state)).toEqual(original);
    expect((await lstat(state)).mtimeMs).toBe(mtimeMs);
  });

  it.skipIf(!("deserialize" in DatabaseSync.prototype))(
    "reports corruption beyond the SQLite header without altering state",
    async () => {
      await config();
      createState().close();
      const corrupt = await readFile(state);
      const rawPageSize = corrupt.readUInt16BE(16);
      const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
      corrupt[pageSize] = 0xff; // Invalid B-tree page type on the second page.
      await writeFile(state, corrupt);
      await chmod(state, 0o600);
      expect((await doctor()).checks).toContainEqual(
        expect.objectContaining({ id: "sqlite.integrity", status: "error" }),
      );
      expect(await readFile(state)).toEqual(corrupt);
    },
  );

  it("skips integrity while an SQLite writer has live WAL sidecars", async () => {
    await config();
    const db = createState();
    try {
      db.exec("INSERT INTO synthetic VALUES (1)");
      const suffixes = ["", "-wal", "-shm"];
      if (process.platform !== "win32")
        await Promise.all(suffixes.map((suffix) => chmod(state + suffix, 0o600)));
      const before = await Promise.all(suffixes.map((suffix) => readFile(state + suffix)));
      const findings = (await doctor()).checks;
      expect(findings).toContainEqual(
        expect.objectContaining({
          id: "sqlite.integrity",
          status: "skipped",
          message: expect.stringContaining("checkpointed"),
        }),
      );
      expect(await Promise.all(suffixes.map((suffix) => readFile(state + suffix)))).toEqual(before);
    } finally {
      db.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "only changes the owned SQLite mode with --fix",
    async () => {
      await config();
      createState().close();
      await chmod(state, 0o644);
      const original = await readFile(state);
      expect((await doctor()).checks).toContainEqual(
        expect.objectContaining({ id: "sqlite.permissions", status: "error" }),
      );
      expect((await lstat(state)).mode & 0o777).toBe(0o644);
      expect((await doctor(true)).checks).toContainEqual(
        expect.objectContaining({ id: "sqlite.permissions", status: "fixed" }),
      );
      expect((await lstat(state)).mode & 0o777).toBe(0o600);
      expect(await readFile(state)).toEqual(original);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses linked state and does not change its target",
    async () => {
      await config();
      createState().close();
      await chmod(state, 0o644);
      const target = join(root, "target.sqlite");
      await writeFile(target, await readFile(state), { mode: 0o644 });
      await rm(state);
      await symlink(target, state);
      expect((await doctor(true)).checks).toContainEqual(
        expect.objectContaining({ id: "sqlite.file", status: "error" }),
      );
      expect((await lstat(state)).isSymbolicLink()).toBe(true);
      expect((await lstat(target)).mode & 0o777).toBe(0o644);
    },
  );

  it("reports malformed state and keeps live and stale lock files", async () => {
    await config();
    const lock = `${state}.lock`;
    await writeFile(state, "not SQLite");
    const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    await writeFile(lock, payload);
    expect((await doctor(true)).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sqlite.file", status: "error" }),
        expect.objectContaining({ id: "sqlite.lock", status: "ok" }),
      ]),
    );
    expect(await readFile(lock, "utf8")).toBe(payload);
    // Node accepts this positive PID, which is outside OS-assigned ranges.
    const stale = JSON.stringify({ pid: 0x7fffffff, startedAt: new Date(0).toISOString() });
    await writeFile(lock, stale);
    expect((await doctor(true)).checks).toContainEqual(
      expect.objectContaining({ id: "sqlite.lock", status: "warning" }),
    );
    expect(await readFile(lock, "utf8")).toBe(stale);
    expect(await readFile(state, "utf8")).toBe("not SQLite");
  });

  it("reports unmanaged and malformed MCP files without leaking or updating contents", async () => {
    await config(["claude-code", "cursor", "codex"]);
    await mkdir(join(root, ".cursor"));
    const unmanaged =
      '{"mcpServers":{"catenext":{"command":"fixture","args":["synthetic-secret"]}}}';
    const malformed = '{"env":"synthetic-secret"';
    await writeFile(join(root, ".mcp.json"), unmanaged);
    await writeFile(join(root, ".cursor/mcp.json"), malformed);
    const report = await doctor(true);
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mcp.claude-code",
          status: "warning",
          message: expect.stringContaining("Unmanaged"),
        }),
        expect.objectContaining({ id: "mcp.cursor", status: "error" }),
        expect.objectContaining({
          id: "mcp.codex",
          status: "warning",
          message: expect.stringContaining("missing"),
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("synthetic-secret");
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(unmanaged);
    expect(await readFile(join(root, ".cursor/mcp.json"), "utf8")).toBe(malformed);
  });

  it("reports a prunable synthetic worktree without pruning it", async () => {
    await config();
    git("init", "-q");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    git("worktree", "add", "-qb", "fixture-lane", "fixture-checkout");
    await rm(join(root, "fixture-checkout"), { recursive: true });
    const entries = await readdir(join(root, ".git/worktrees"));
    expect((await doctor(true)).checks).toContainEqual(
      expect.objectContaining({
        id: "git.worktrees",
        status: "warning",
        message: expect.stringContaining("1 prunable worktree registration"),
      }),
    );
    expect(await readdir(join(root, ".git/worktrees"))).toEqual(entries);
  });

  it("warns on missing onboarding artifacts and prints numbered next-fix tips", async () => {
    await writeFile(
      join(root, ".catenext/config.yaml"),
      JSON.stringify({
        project_id: randomUUID(),
        repo_name: "fixture",
        schema_version: 1,
        platforms: ["cursor"],
      }),
    );
    const report = await doctor();
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "artifacts.master", status: "warning" }),
        expect.objectContaining({ id: "artifacts.agents", status: "warning" }),
        expect.objectContaining({ id: "artifacts.entry.cursor", status: "warning" }),
        expect.objectContaining({
          id: "artifacts.stub.orchestrator.cursor",
          status: "warning",
        }),
      ]),
    );
    const text = formatDoctorReport(report);
    expect(text).toContain("Next steps:");
    expect(text).toMatch(/^1\. /m);
    expect(text).toContain("catenext sync --force");
    expect(text).toContain("catenext verify");
  });

  it("accepts managed CATENEXT.md, AGENTS block, entry pointer, and orchestrator stub", async () => {
    await config(["cursor"]);
    await mkdir(join(root, ".cursor", "agents"), { recursive: true });
    await writeFile(join(root, MASTER_PROMPT_FILE), renderMasterPrompt());
    await writeFile(
      join(root, "AGENTS.md"),
      `# Team\n\n${BLOCK_START}\nblock\n<!-- catenext:end -->\n`,
    );
    await writeFile(join(root, ".cursor/CATENEXT.md"), `${ENTRY_MARKER}\n# pointer\n`);
    await writeFile(
      join(root, ".cursor/agents/orchestrator.md"),
      renderOrchestratorStub({ stack: [], personas: [] }, "cursor"),
    );
    await writeFile(
      join(root, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          catenext: { command: "catenext", args: ["mcp", "--root", CURSOR_WORKSPACE_FOLDER] },
        },
      }),
    );
    const report = await doctor();
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "artifacts.master", status: "ok" }),
        expect.objectContaining({ id: "artifacts.agents", status: "ok" }),
        expect.objectContaining({ id: "artifacts.entry.cursor", status: "ok" }),
        expect.objectContaining({ id: "artifacts.stub.orchestrator.cursor", status: "ok" }),
      ]),
    );
    expect(formatDoctorReport(report)).not.toContain("Next steps:");
  });

  it("warns on invalid local skills with numbered next-fix tips", async () => {
    await config();
    await mkdir(join(root, ".catenext", "skills"), { recursive: true });
    await writeFile(join(root, ".catenext/skills/raw.md"), "No frontmatter");
    const entries = await readdir(join(root, ".catenext"));
    const report = await doctor();
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "skills.invalid.raw",
        status: "warning",
        message: expect.stringContaining("tidak punya frontmatter"),
        path: ".catenext/skills/raw.md",
      }),
    );
    const text = formatDoctorReport(report);
    expect(text).toContain("Next steps:");
    expect(text).toContain("catenext skill list");
    expect(text).toContain("catenext verify");
    expect(await readdir(join(root, ".catenext"))).toEqual(entries);
  });

  it.skipIf(!("deserialize" in DatabaseSync.prototype))(
    "warns on missing persona stubs via snapshot without creating SQLite sidecars",
    async () => {
      const projectId = randomUUID();
      await writeFile(
        join(root, ".catenext/config.yaml"),
        JSON.stringify({
          project_id: projectId,
          repo_name: "fixture",
          schema_version: 1,
          platforms: ["cursor"],
        }),
      );
      await writeFile(join(root, MASTER_PROMPT_FILE), `${MASTER_MARKER}\nfixture master\n`);
      await writeFile(
        join(root, "AGENTS.md"),
        `# Fixture\n\n${BLOCK_START}\nfixture\n<!-- catenext:end -->\n`,
      );
      await mkdir(join(root, ".cursor", "agents"), { recursive: true });
      await writeFile(join(root, ".cursor/CATENEXT.md"), `${ENTRY_MARKER}\n# pointer\n`);
      await writeFile(
        join(root, ".cursor/agents/orchestrator.md"),
        renderOrchestratorStub({ stack: [], personas: [] }, "cursor"),
      );
      await writeFile(
        join(root, ".cursor/mcp.json"),
        JSON.stringify({
          mcpServers: {
            catenext: { command: "catenext", args: ["mcp", "--root", CURSOR_WORKSPACE_FOLDER] },
          },
        }),
      );
      const db = openDatabaseAt(state);
      try {
        db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
          projectId,
          "2026-01-02T00:00:00.000Z",
        );
        db.prepare(
          "INSERT INTO personas (project_id, alias, role, rules_json) VALUES (?, ?, ?, ?)",
        ).run(projectId, "be", "backend", "[]");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
      await chmod(state, 0o600);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        await rm(state + suffix, { force: true });
      }
      const entries = await readdir(join(root, ".catenext"));
      const report = await doctor();
      expect(report.ok).toBe(false);
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          id: "artifacts.stub.persona.be.cursor",
          status: "warning",
          message: expect.stringContaining("Persona stub is missing"),
        }),
      );
      const text = formatDoctorReport(report);
      expect(text).toContain("Next steps:");
      expect(text).toContain("catenext sync --force");
      expect(text).toContain("catenext verify");
      expect(await readdir(join(root, ".catenext"))).toEqual(entries);
    },
  );

  it("compares the running CLI only with Catenext project release metadata", async () => {
    await config();
    const manifest = join(root, "package.json");
    await writeFile(manifest, JSON.stringify({ name: "unrelated-package", version: "1.2.3" }));
    expect((await doctor()).checks).toContainEqual(
      expect.objectContaining({ id: "cli.version", status: "skipped" }),
    );
    await writeFile(manifest, JSON.stringify({ name: "catenext", version: "0.9.0" }));
    expect((await doctor()).checks).toContainEqual(
      expect.objectContaining({ id: "cli.version", status: "warning" }),
    );
    await writeFile(manifest, JSON.stringify({ name: "catenext", version: "0.10.0" }));
    expect((await doctor()).checks).toContainEqual(
      expect.objectContaining({ id: "cli.version", status: "ok" }),
    );
  });
});
