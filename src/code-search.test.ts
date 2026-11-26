import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { searchLocalCode } from "./code-search.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });

describe("local code search", () => {
  it("indexes tracked source but not orchestration files or symlink targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-"));
    try {
      git(root, "init", "--quiet");
      await mkdir(join(root, ".catenext"));
      await writeFile(join(root, ".catenext", "state.json"), '{"note":"project private"}');
      await writeFile(
        join(root, "handler.ts"),
        "export const greeting = 'hello'; // token=synthetic-test-value-12345678\n",
      );
      await symlink(".catenext/state.json", join(root, "hidden.json"));
      git(root, "add", "--force", ".catenext/state.json", "handler.ts", "hidden.json");

      const result = await searchLocalCode(root, "greeting");
      expect(result.degraded).toBe(false);
      expect(result.hits.map(({ ref }) => ref)).toEqual(["handler.ts"]);
      expect(result.hits[0]?.snippet).toContain("[REDACTED:assignment]");
      expect(result.hits[0]?.snippet).not.toContain("synthetic-test-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
