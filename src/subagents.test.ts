import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFileEdits, planRemove } from "./maintenance.js";
import { planSubagents, renderSubagent, SUBAGENT_MARKER } from "./subagents.js";

const adel = {
  alias: "adel",
  role: "backend",
  rules: ["Hanya apps/api"],
  repos: ["be"],
  scope: "project" as const,
};

describe("subagent persona", () => {
  it("berisi alias, role, alur dengan agent_alias, dan aturan", () => {
    const md = renderSubagent(adel);
    expect(md.startsWith("---\nname: adel\n")).toBe(true);
    expect(md).toContain(SUBAGENT_MARKER);
    expect(md).toContain('`agent_alias: "adel"`');
    expect(md).toContain("- Hanya apps/api");
    expect(md).toContain("Owned repos: `be`");
    expect(md).toContain("Stack:");
  });

  it("membuat, memperbarui, menghapus file Catenext saja, dan tidak menimpa file manusia", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-sub-"));
    await mkdir(join(root, ".claude", "agents"), { recursive: true });
    await writeFile(join(root, ".claude", "agents", "citra.md"), "subagent buatan sendiri\n");

    const first = await planSubagents(root, [
      adel,
      { alias: "citra", role: "architect", rules: [], repos: [], scope: "project" },
    ]);
    expect(first.skipped).toEqual([join(".claude", "agents", "citra.md")]);
    await applyFileEdits(root, first.edits);
    expect(await readFile(join(root, ".claude", "agents", "adel.md"), "utf8")).toContain("adel");
    expect(await readFile(join(root, ".claude", "agents", "citra.md"), "utf8")).toBe(
      "subagent buatan sendiri\n",
    );

    // Refresh orchestrator for adel-only, then idempotent.
    const mid = await planSubagents(root, [adel]);
    expect(mid.edits.map((e) => e.path)).toContain(join(".claude", "agents", "orchestrator.md"));
    await applyFileEdits(root, mid.edits);
    expect((await planSubagents(root, [adel])).edits).toEqual([]);
    const gone = await planSubagents(root, []);
    expect(gone.edits.map((e) => e.path).sort()).toEqual([
      join(".claude", "agents", "adel.md"),
      join(".claude", "agents", "orchestrator.md"),
    ]);
    expect(gone.edits.find((e) => e.path.endsWith("adel.md"))?.after).toBeNull();

    // remove ikut membersihkan subagent buatan Catenext.
    const removed = await planRemove({ root, all: false });
    expect(removed.map((e) => e.path)).toContain(join(".claude", "agents", "adel.md"));
    expect(removed.map((e) => e.path)).not.toContain(join(".claude", "agents", "citra.md"));
  });
});
