import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keywordFallback, searchLocalCode } from "./code-search.js";

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

  it("returns contextual matched-line snippets and chunks files larger than 8000 chars", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-chunk-"));
    try {
      const paddingLines = Array.from(
        { length: 220 },
        (_, i) => `export const fillerItem${i} = "padding-block-content-${i}";`,
      );
      const targetLine = "export function deepNeedleAfter8k() { return 'found-past-8k'; }";
      const content = [...paddingLines, targetLine, "export const tailMarker = true;"].join("\n");
      expect(content.length).toBeGreaterThan(10_000);
      await writeFile(join(root, "large.ts"), content);

      const result = await searchLocalCode(root, "deepNeedleAfter8k");
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.ref).toBe("large.ts");
      expect(result.hits[0]?.snippet).toContain("L221:");
      expect(result.hits[0]?.snippet).toContain("deepNeedleAfter8k");
      expect(result.hits[0]?.snippet).not.toContain("fillerItem0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes stale cache files when source files are deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-prune-"));
    try {
      const keepPath = join(root, "keep.ts");
      const removePath = join(root, "remove.ts");
      await writeFile(keepPath, "export const alphaSymbol = 1;\n");
      await writeFile(removePath, "export const betaSymbol = 2;\n");

      await searchLocalCode(root, "alphaSymbol");
      const cacheDir = join(root, ".catenext/cache/code-embeddings");
      expect((await readdir(cacheDir)).filter((f) => f.endsWith(".json"))).toHaveLength(2);

      await rm(removePath);
      const after = await searchLocalCode(root, "alphaSymbol");
      expect(after.hits.map((h) => h.ref)).toEqual(["keep.ts"]);
      expect((await readdir(cacheDir)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexes registered workspace_roots and skips missing roots gracefully", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-primary-"));
    const ext = await mkdtemp(join(tmpdir(), "catenext-code-ext-"));
    const missing = join(tmpdir(), "catenext-code-missing-never-exists");
    try {
      await writeFile(join(root, "local.ts"), "export const localOnly = true;\n");
      await mkdir(join(ext, "src"), { recursive: true });
      await writeFile(
        join(ext, "src/remote.ts"),
        "export function externalSyncEndpoint() { return 42; }\n",
      );

      const res = await searchLocalCode(root, "externalSyncEndpoint", 8, {
        roots: [
          { id: "11111111-1111-4111-8111-111111111111", path: ext, label: "mobile" },
          { id: "22222222-2222-4222-8222-222222222222", path: missing, label: "gone" },
        ],
      });
      expect(res.degraded).toBe(false);
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0]?.ref).toBe("@mobile/src/remote.ts");
      expect(res.hits[0]?.snippet).toContain("externalSyncEndpoint");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(ext, { recursive: true, force: true });
    }
  });

  it("keywordFallback falls back to Node scan when rg is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-norg-"));
    const prevPath = process.env.PATH;
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src/billing.ts"),
        "export function calculateQuotaTier() { return 'pro'; }\n",
      );
      process.env.PATH = "";
      const hits = await keywordFallback(root, "QuotaTier", 5);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.ref).toBe("src/billing.ts");
      expect(hits[0]?.snippet).toContain("calculateQuotaTier");
    } finally {
      process.env.PATH = prevPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
