import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyInit, planInit } from "./init/index.js";
import {
  applyFileEdits,
  countEntries,
  entryIsStale,
  planRemove,
  planSync,
  removeMcpEntries,
} from "./maintenance.js";

const PROJECT = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const CMD = { command: "catenext", args: [] as string[] };
const NEW = () => ({ command: "/usr/bin/node", args: ["/new/cli/dist/index.js"] });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-maint-"));
  await writeFile(
    join(root, ".mcp.json"),
    '{\n  // punya saya\n  "mcpServers": { "gh": { "command": "gh", "args": [] } }\n}\n',
  );
  await applyInit(root, await planInit({ root, projectId: PROJECT, mcpCommand: CMD }));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("catenext sync", () => {
  it("tidak mengubah apa pun bila sudah selaras", async () => {
    const plan = await planSync({ root, fix: false, defaultCommand: NEW });
    expect(plan.edits).toEqual([]);
  });

  it("memperbaiki path basi hanya dengan --fix", async () => {
    const stale = { command: "/gone/node", args: ["/gone/dist/index.js", "mcp"] };
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { catenext: stale } }));
    const dry = await planSync({ root, fix: false, defaultCommand: NEW });
    expect(dry.edits.map((e) => e.path)).not.toContain(".mcp.json");
    expect(dry.findings.some((f) => f.level === "fixable")).toBe(true);
    const fixed = await planSync({ root, fix: true, defaultCommand: NEW });
    await applyFileEdits(root, fixed.edits);
    const doc = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(doc.mcpServers.catenext).toEqual({
      command: "/usr/bin/node",
      args: ["/new/cli/dist/index.js", "mcp"],
    });
  });

  it("menyatukan entri duplikat dan membuat ulang file rusak dengan .bak", async () => {
    const dup =
      '{"mcpServers":{"catenext":{"command":"a","args":[]},"x":{"command":"x","args":[]},"catenext":{"command":"b","args":[]}}}';
    expect(countEntries(dup)).toBe(2);
    expect(countEntries(removeMcpEntries(dup))).toBe(0);
    await writeFile(join(root, ".mcp.json"), dup);
    await writeFile(join(root, ".cursor/mcp.json"), "{ rusak");
    const plan = await planSync({ root, fix: true, defaultCommand: NEW });
    await applyFileEdits(root, plan.edits);
    const claude = await readFile(join(root, ".mcp.json"), "utf8");
    expect(countEntries(claude)).toBe(1);
    expect(JSON.parse(claude).mcpServers.x).toBeTruthy();
    expect(await readFile(join(root, ".cursor/mcp.json.bak"), "utf8")).toBe("{ rusak");
    expect(countEntries(await readFile(join(root, ".cursor/mcp.json"), "utf8"))).toBe(1);
  });
});

describe("catenext remove", () => {
  it("menghapus semua jejak Catenext tapi menjaga isi milik pengguna", async () => {
    const edits = await planRemove({ root, all: false });
    await applyFileEdits(root, edits);
    const claude = await readFile(join(root, ".mcp.json"), "utf8");
    expect(claude).toContain("// punya saya");
    expect(claude).toContain('"gh"');
    expect(countEntries(claude)).toBe(0);
    await expect(readFile(join(root, ".cursor/mcp.json"))).rejects.toThrow();
    await expect(readFile(join(root, ".catenext/config.yaml"))).rejects.toThrow();
    await expect(readFile(join(root, "AGENTS.md"))).rejects.toThrow();
    await expect(readFile(join(root, ".gitignore"))).rejects.toThrow();
    expect(await planRemove({ root, all: false })).toEqual([]);
  });
});

describe("entryIsStale", () => {
  it("menganggap skrip di cache npx basi meski filenya masih ada", () => {
    expect(
      entryIsStale({
        command: "node",
        args: ["/home/a/.npm/_npx/ab12/node_modules/catenext/dist/index.js", "mcp"],
      }),
    ).toBe(true);
    expect(entryIsStale({ command: "npx", args: ["-y", "catenext", "mcp"] })).toBe(false);
  });
});
