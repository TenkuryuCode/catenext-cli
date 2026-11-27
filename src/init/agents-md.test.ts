import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderMasterPrompt } from "../agents/entry-pointers.js";
import { BLOCK_START, removeAgentsBlock, upsertAgentsBlock } from "./agents-md.js";

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function findAgentsMdFiles(dir: string): string[] {
  const skip = new Set(["node_modules", "dist", ".turbo", ".git"]);
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findAgentsMdFiles(full));
    } else if (entry.name === "AGENTS.md") {
      found.push(full);
    }
  }
  return found;
}

describe("blok AGENTS.md", () => {
  it("membuat file baru dan idempoten", () => {
    const once = upsertAgentsBlock(null);
    expect(once).toContain(BLOCK_START);
    expect(upsertAgentsBlock(once)).toBe(once);
  });

  it("memuat aturan orchestrator: revisi lewat manage_task, bukan task baru", () => {
    const block = upsertAgentsBlock(null);
    expect(block).toContain("**orchestrator**");
    expect(block).toContain("CATENEXT.md");
    expect(block).toContain("pending_approvals");
    expect(block).toContain("session_brief");
    expect(block).toContain("catenext revise");
    expect(block).toContain("APPROVAL NEEDED");
    expect(block).toContain("ACCESS NEEDED");
  });

  it("tidak menduplikasi template panjang di CATENEXT.md", () => {
    const master = renderMasterPrompt();
    const agents = upsertAgentsBlock(null);
    expect(master.length).toBeLessThan(agents.length * 0.45);
    expect(agents).toContain("APPROVAL NEEDED");
    expect(master).not.toContain("APPROVAL NEEDED");
    expect(master).not.toContain("Then read **`AGENTS.md`**");
  });

  it("mengganti blok lama di tempatnya tanpa menyentuh teks lain", () => {
    const src = `# Tim\n\nA\n\n${BLOCK_START}\nISI-BLOK-USANG-XYZ\n<!-- catenext:end -->\n\n## Lain\nB\n`;
    const out = upsertAgentsBlock(src);
    expect(out).not.toContain("ISI-BLOK-USANG-XYZ");
    expect(out.startsWith("# Tim\n\nA\n\n")).toBe(true);
    expect(out.endsWith("## Lain\nB\n")).toBe(true);
  });

  it("remove mengembalikan isi semula atau null bila hanya berisi blok", () => {
    expect(removeAgentsBlock(upsertAgentsBlock(null))).toBeNull();
    expect(removeAgentsBlock(upsertAgentsBlock("# Tim\n\nA\n"))).toBe("# Tim\n\nA\n");
  });
});

describe("apps/cli hygiene", () => {
  it("tidak menyisakan AGENTS.md usang yang merujuk Cloud/dashboard di dalam apps/cli", () => {
    expect(existsSync(join(CLI_DIR, "AGENTS.md"))).toBe(false);
    const lingering = findAgentsMdFiles(CLI_DIR);
    expect(lingering).toEqual([]);
    for (const file of lingering) {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(
        /indeks dokumen Cloud|menyetujuinya di Web|project_repos|bambang/i,
      );
    }
  });
});
