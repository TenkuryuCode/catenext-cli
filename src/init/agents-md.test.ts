import { describe, expect, it } from "vitest";
import { BLOCK_START, removeAgentsBlock, upsertAgentsBlock } from "./agents-md.js";

describe("blok AGENTS.md", () => {
  it("membuat file baru dan idempoten", () => {
    const once = upsertAgentsBlock(null);
    expect(once).toContain(BLOCK_START);
    expect(upsertAgentsBlock(once)).toBe(once);
  });

  it("mengganti blok lama di tempatnya tanpa menyentuh teks lain", () => {
    const src = `# Tim\n\nA\n\n${BLOCK_START}\nlama\n<!-- catenext:end -->\n\n## Lain\nB\n`;
    const out = upsertAgentsBlock(src);
    expect(out).not.toContain("lama");
    expect(out.startsWith("# Tim\n\nA\n\n")).toBe(true);
    expect(out.endsWith("## Lain\nB\n")).toBe(true);
  });

  it("remove mengembalikan isi semula atau null bila hanya berisi blok", () => {
    expect(removeAgentsBlock(upsertAgentsBlock(null))).toBeNull();
    expect(removeAgentsBlock(upsertAgentsBlock("# Tim\n\nA\n"))).toBe("# Tim\n\nA\n");
  });
});
