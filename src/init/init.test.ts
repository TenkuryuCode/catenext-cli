import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureGitignore } from "./gitignore.js";
import { applyInit, planInit, renderDiff } from "./index.js";
import { CURSOR_WORKSPACE_FOLDER, upsertMcpEntry } from "./mcp-config.js";

const PROJECT = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const CMD = { command: "/usr/bin/node", args: ["/opt/catenext/dist/index.js"] };
const ENTRY = { command: "node", args: ["cli.js", "mcp"] };

describe("upsertMcpEntry", () => {
  it("membuat file baru bila belum ada", () => {
    const out = upsertMcpEntry(null, ENTRY, ".mcp.json");
    expect(JSON.parse(out)).toEqual({ mcpServers: { catenext: ENTRY } });
  });

  it("mempertahankan komentar JSONC dan server lain", () => {
    const src = `{
  // server milik pengguna
  "mcpServers": {
    /* jangan disentuh */
    "github": { "command": "gh-mcp", "args": [] },
  },
}
`;
    const out = upsertMcpEntry(src, ENTRY, ".cursor/mcp.json");
    expect(out).toContain("// server milik pengguna");
    expect(out).toContain("/* jangan disentuh */");
    const doc = parse(out) as { mcpServers: Record<string, unknown> };
    expect(doc.mcpServers.github).toEqual({ command: "gh-mcp", args: [] });
    expect(doc.mcpServers.catenext).toEqual(ENTRY);
  });

  it("idempoten: menjalankan dua kali tidak menduplikasi entri", () => {
    const once = upsertMcpEntry("{}", ENTRY, ".mcp.json");
    const twice = upsertMcpEntry(once, ENTRY, ".mcp.json");
    expect(twice).toBe(once);
    expect(once.match(/"catenext"/g)).toHaveLength(1);
  });

  it("memperbarui entri catenext lama di tempat", () => {
    const old = upsertMcpEntry("{}", { command: "old", args: [] }, ".mcp.json");
    const out = upsertMcpEntry(old, ENTRY, ".mcp.json");
    expect(out.match(/"catenext"/g)).toHaveLength(1);
    expect((parse(out) as { mcpServers: { catenext: unknown } }).mcpServers.catenext).toEqual(
      ENTRY,
    );
  });

  it("menolak menyentuh file yang rusak", () => {
    expect(() => upsertMcpEntry("{ nope", ENTRY, ".mcp.json")).toThrow(/tidak disentuh/);
  });
});

describe("ensureGitignore", () => {
  it("menambahkan sekali dan mempertahankan isi lama", () => {
    const once = ensureGitignore("node_modules/\n");
    expect(once).toMatch(/^node_modules\/\n\n# Catenext.*\n\.catenext\/cache\.json\n$/);
    expect(ensureGitignore(once)).toBe(once);
  });

  it("membuat isi baru bila .gitignore belum ada", () => {
    expect(ensureGitignore(null)).toContain(".catenext/cache.json");
  });
});

describe("planInit + applyInit", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-init-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { hono: "4" } }));
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", "ci.yml"), "name: CI\n");
  });

  it("dry-run (plan) tidak menulis apa pun", async () => {
    const before = await readdir(root);
    const changes = await planInit({
      root,
      projectId: PROJECT,
      repoName: "backend",
      mcpCommand: CMD,
    });
    expect(changes.map((c) => c.path).sort()).toEqual(
      [".cursor/mcp.json", ".gitignore", ".mcp.json", ".catenext/config.yaml", "AGENTS.md"].sort(),
    );
    expect(renderDiff(changes)).toContain("+repo_name: backend");
    expect(await readdir(root)).toEqual(before);
  });

  it("menulis file, idempoten, dan tidak menyentuh .github", async () => {
    await applyInit(
      root,
      await planInit({ root, projectId: PROJECT, repoName: "backend", mcpCommand: CMD }),
    );

    const config = await readFile(join(root, ".catenext/config.yaml"), "utf8");
    expect(config).toContain(`project_id: ${PROJECT}`);
    expect(config).toContain("stack: [node, hono]");
    const claude = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(claude.mcpServers.catenext).toEqual({
      command: CMD.command,
      args: [...CMD.args, "mcp"],
    });
    const cursor = JSON.parse(await readFile(join(root, ".cursor/mcp.json"), "utf8"));
    expect(cursor.mcpServers.catenext.args).toEqual([
      ...CMD.args,
      "mcp",
      "--root",
      CURSOR_WORKSPACE_FOLDER,
    ]);

    expect(await planInit({ root, mcpCommand: CMD })).toEqual([]);
    expect(await readFile(join(root, ".github/workflows/ci.yml"), "utf8")).toBe("name: CI\n");
  });

  it("mengubah repo_name di config yang ada tanpa membuang komentar", async () => {
    await applyInit(root, await planInit({ root, projectId: PROJECT, mcpCommand: CMD }));
    const changes = await planInit({ root, repoName: "frontend", mcpCommand: CMD });
    expect(changes.map((c) => c.path)).toEqual([".catenext/config.yaml"]);
    expect(changes[0]?.after).toContain("repo_name: frontend");
    expect(changes[0]?.after).toContain("# Identitas repo ini");
  });

  it("menjaga isi AGENTS.md yang ada dan bisa dimatikan", async () => {
    await writeFile(join(root, "AGENTS.md"), "# Aturan tim\n\nPakai pnpm.\n");
    await applyInit(root, await planInit({ root, projectId: PROJECT, mcpCommand: CMD }));
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Aturan tim\n\nPakai pnpm.\n")).toBe(true);
    expect(agents).toContain("catenext claim <task_id>");
    const skipped = await planInit({
      root: await mkdtemp(join(tmpdir(), "catenext-init-")),
      projectId: PROJECT,
      mcpCommand: CMD,
      agentsMd: false,
    });
    expect(skipped.map((c) => c.path)).not.toContain("AGENTS.md");
  });

  it("meminta --project saat config belum ada", async () => {
    await expect(planInit({ root, mcpCommand: CMD })).rejects.toThrow(/--project/);
  });
});
