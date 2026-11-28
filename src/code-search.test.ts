import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema } from "@catenext/shared";
import { describe, expect, it, vi } from "vitest";
import { indexCodeEmbeddings, keywordFallback, searchLocalCode } from "./code-search.js";
import { openDatabaseAt } from "./db/open.js";
import { type EmbeddingClient, EmbeddingError } from "./embeddings.js";
import { LocalService } from "./local-service.js";
import { DEFAULT_MAX_FILE_BYTES } from "./workspace-walk.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });

async function tryFileSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return false;
    }
    throw error;
  }
}

describe("local code search", () => {
  it("indexes source but not orchestration files or symlink targets, and redacts secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-"));
    try {
      git(root, "init", "--quiet");
      await mkdir(join(root, ".catenext"));
      await writeFile(join(root, ".catenext", "state.json"), '{"note":"project private"}');
      await writeFile(
        join(root, "handler.ts"),
        "export const greeting = 'hello'; // token=synthetic-test-value-12345678\n",
      );
      const filesToStage = [".catenext/state.json", "handler.ts"];
      if (await tryFileSymlink(".catenext/state.json", join(root, "hidden.json"))) {
        filesToStage.push("hidden.json");
      }
      git(root, "add", "--force", ...filesToStage);

      const result = await searchLocalCode(root, "greeting");
      expect(result.degraded).toBe(false);
      expect(result.hits.map(({ ref }) => ref)).toEqual(["handler.ts"]);
      expect(result.hits[0]?.snippet).toContain("[REDACTED:assignment]");
      expect(result.hits[0]?.snippet).not.toContain("synthetic-test-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns contextual matched-line snippets via FTS5 even past 8000 chars and handles multi-line FTS5 snippets", async () => {
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
      await writeFile(
        join(root, "multi.ts"),
        "export const alphaAnchor = 1;\n// separator\nexport const omegaAnchor = 2;\n",
      );

      const result = await searchLocalCode(root, "deepNeedleAfter8k");
      expect(result.degraded).toBe(false);
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.ref).toBe("large.ts");
      expect(result.hits[0]?.snippet).toContain("L221:");
      expect(result.hits[0]?.snippet).toContain("deepNeedleAfter8k");
      expect(result.hits[0]?.snippet).not.toContain("fillerItem0");

      const multiResult = await searchLocalCode(root, "alphaAnchor omegaAnchor");
      expect(multiResult.degraded).toBe(false);
      expect(multiResult.hits.map((h) => h.ref)).toEqual(["multi.ts"]);
      expect(multiResult.hits[0]?.snippet).toContain("alphaAnchor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores index in SQLite FTS5, prunes deleted files, and cleans legacy .catenext/cache/*.json safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-prune-"));
    try {
      const keepPath = join(root, "keep.ts");
      const removePath = join(root, "remove.ts");
      await writeFile(keepPath, "export const alphaSymbol = 1;\n");
      await writeFile(removePath, "export const betaSymbol = 2;\n");

      const legacyDir = join(root, ".catenext/cache/code-embeddings");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(join(legacyDir, "stale-hash.json"), '{"version":3}');
      await writeFile(join(root, ".catenext/cache/stray-cache.json"), '{"legacy":true}');
      await writeFile(join(root, ".catenext/cache/cli-session-id"), "keep-me-intact\n");

      const initial = await searchLocalCode(root, "alphaSymbol");
      expect(initial.hits.map((h) => h.ref)).toEqual(["keep.ts"]);

      // Legacy per-file JSON caches are removed while cli-session-id stays untouched.
      expect(existsSync(legacyDir)).toBe(false);
      const cacheEntries = await readdir(join(root, ".catenext/cache"));
      expect(cacheEntries.filter((f) => f.endsWith(".json"))).toEqual([]);
      expect(await readFile(join(root, ".catenext/cache/cli-session-id"), "utf8")).toBe(
        "keep-me-intact\n",
      );

      await rm(removePath);
      const afterDelete = await searchLocalCode(root, "betaSymbol");
      expect(afterDelete.hits).toEqual([]);

      const db = openDatabaseAt(join(root, ".catenext/cache/code-search.sqlite"));
      try {
        const paths = (
          db.prepare("SELECT path FROM code_search_files ORDER BY path").all() as Array<{
            path: string;
          }>
        ).map((r) => r.path);
        expect(paths).toEqual(["keep.ts"]);
        const ftsRows = db
          .prepare("SELECT path FROM code_search_fts WHERE code_search_fts MATCH 'betaSymbol'")
          .all();
        expect(ftsRows).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back cleanly to SQLite LIKE search when FTS5 is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-nofts-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src/fallback.ts"),
        "export function fallbackSearchHandler() { return 'ok'; }\n",
      );

      const res = await searchLocalCode(root, "fallbackSearchHandler", 8, { disableFts5: true });
      expect(res.degraded).toBe(true);
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0]?.ref).toBe("src/fallback.ts");
      expect(res.hits[0]?.snippet).toContain("fallbackSearchHandler");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors root and nested .gitignore rules and skips extra build/env dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-ignore-"));
    try {
      await writeFile(
        join(root, ".gitignore"),
        [
          "# root ignore",
          "*.generated.ts",
          "ignored-dir/",
          "/root-only.ts",
          "!important.generated.ts",
          "",
        ].join("\n"),
      );
      await mkdir(join(root, "ignored-dir"), { recursive: true });
      await mkdir(join(root, "src/sub"), { recursive: true });
      for (const skip of [".next", "target", ".venv", ".nuxt", "out"]) {
        await mkdir(join(root, skip), { recursive: true });
        await writeFile(
          join(root, skip, "bundle.ts"),
          "export const ignoreNeedleMarker = 'bad';\n",
        );
      }
      await writeFile(
        join(root, "ignored-dir/skip.ts"),
        "export const ignoreNeedleMarker = 'bad';\n",
      );
      await writeFile(join(root, "root-only.ts"), "export const ignoreNeedleMarker = 'bad';\n");
      await writeFile(
        join(root, "src/root-only.ts"),
        "export const ignoreNeedleMarker = 'good-non-root';\n",
      );
      await writeFile(
        join(root, "src/foo.generated.ts"),
        "export const ignoreNeedleMarker = 'bad';\n",
      );
      await writeFile(
        join(root, "src/important.generated.ts"),
        "export const ignoreNeedleMarker = 'good-negated';\n",
      );

      // Nested .gitignore inside src/sub
      await writeFile(join(root, "src/sub/.gitignore"), "local-secret.ts\n");
      await writeFile(
        join(root, "src/sub/local-secret.ts"),
        "export const ignoreNeedleMarker = 'bad-nested';\n",
      );
      await writeFile(
        join(root, "src/sub/keep.ts"),
        "export const ignoreNeedleMarker = 'good-nested';\n",
      );

      const res = await searchLocalCode(root, "ignoreNeedleMarker", 20);
      expect(res.hits.map((h) => h.ref).sort()).toEqual([
        "src/important.generated.ts",
        "src/root-only.ts",
        "src/sub/keep.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips oversized files exceeding max file byte cap before readFile", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-size-"));
    try {
      await writeFile(join(root, "small.ts"), "export const sizeCapMarker = 'small';\n");
      const oversized = `export const sizeCapMarker = 'huge';\n// ${"x".repeat(DEFAULT_MAX_FILE_BYTES + 128)}\n`;
      await writeFile(join(root, "huge.ts"), oversized);

      const res = await searchLocalCode(root, "sizeCapMarker", 10);
      expect(res.hits.map((h) => h.ref)).toEqual(["small.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink loops and workspace root escapes in searchLocalCode and keywordFallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-sym-"));
    const outside = await mkdtemp(join(tmpdir(), "catenext-code-outside-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/safe.ts"), "export const boundaryNeedle = 'safe';\n");
      await writeFile(join(outside, "leak.ts"), "export const boundaryNeedle = 'escaped';\n");

      // Symlink file escape, symlink dir escape, and symlink loop
      await tryFileSymlink(join(outside, "leak.ts"), join(root, "src/escape-file.ts"));
      await symlink(outside, join(root, "src/escape-dir"), "junction");
      await symlink(join(root, "src"), join(root, "src/loop-dir"), "junction");

      const res = await searchLocalCode(root, "boundaryNeedle", 10);
      expect(res.hits.map((h) => h.ref)).toEqual(["src/safe.ts"]);

      const prevPath = process.env.PATH;
      try {
        process.env.PATH = "";
        const fallbackHits = await keywordFallback(root, "boundaryNeedle", 10);
        expect(fallbackHits.map((h) => h.ref)).toEqual(["src/safe.ts"]);
      } finally {
        process.env.PATH = prevPath;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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

  it("wires LocalService search_context into main SQLite FTS5 DB without creating JSON cache files", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-service-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src/engine.ts"),
        "export function runSearchPipeline() { return 'fts5-active'; }\n",
      );
      const config = CatenextConfigSchema.parse({
        schema_version: 1,
        project_id: randomUUID(),
        project_name: "SearchSvc",
        repo_name: "catenext",
        state_file: ".catenext/catenext.sqlite",
      });
      const service = new LocalService(root, config);
      const res = await service.callTool("search_context", {
        query: "runSearchPipeline",
        sources: ["code"],
        limit: 5,
      });
      expect(res.degraded).toBe(false);
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0]?.ref).toBe("src/engine.ts");
      expect(existsSync(join(root, ".catenext/cache/code-embeddings"))).toBe(false);
      expect(existsSync(join(root, ".catenext/cache/code-search.sqlite"))).toBe(false);

      const db = openDatabaseAt(service.stateFile, { readOnly: true });
      try {
        const indexed = db
          .prepare("SELECT path FROM code_search_files WHERE project_id = ?")
          .all(config.project_id) as Array<{ path: string }>;
        expect(indexed).toEqual([{ path: "src/engine.ts" }]);
      } finally {
        db.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
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

  it("indexes polyglot files (.php, .blade.php, .vue, .svelte, .astro, .graphql, .proto) via FTS5 and cleans standalone WAL", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-code-polyglot-"));
    try {
      await mkdir(join(root, "app/Services"), { recursive: true });
      await mkdir(join(root, "resources/views"), { recursive: true });
      await mkdir(join(root, "src/components"), { recursive: true });
      await mkdir(join(root, "schema"), { recursive: true });

      await writeFile(
        join(root, "app/Services/InvoiceMailer.php"),
        "<?php\nnamespace App\\Services;\nclass InvoiceMailer { public function sendInvoiceReceipt(): void {} }\n",
      );
      await writeFile(
        join(root, "resources/views/invoice.blade.php"),
        "<div>{{ $invoiceTotalBanner }}</div>\n",
      );
      await writeFile(
        join(root, "src/components/InvoiceCard.vue"),
        '<script setup lang="ts">\nconst renderVueInvoiceWidget = true;\n</script>\n',
      );
      await writeFile(
        join(root, "src/components/Badge.svelte"),
        '<script lang="ts">\nexport const svelteStatusBadge = "paid";\n</script>\n',
      );
      await writeFile(
        join(root, "src/components/Layout.astro"),
        "---\nconst astroPageShell = true;\n---\n<slot />\n",
      );
      await writeFile(
        join(root, "schema/billing.graphql"),
        "type BillingSummary { invoiceCount: Int! }\n",
      );
      await writeFile(
        join(root, "schema/billing.proto"),
        "message InvoiceCreatedEvent { string invoice_id = 1; }\n",
      );

      const phpRes = await searchLocalCode(root, "sendInvoiceReceipt");
      expect(phpRes.degraded).toBe(false);
      expect(phpRes.hits.map((h) => h.ref)).toEqual(["app/Services/InvoiceMailer.php"]);

      const bladeRes = await searchLocalCode(root, "invoiceTotalBanner");
      expect(bladeRes.degraded).toBe(false);
      expect(bladeRes.hits.map((h) => h.ref)).toEqual(["resources/views/invoice.blade.php"]);

      const vueRes = await searchLocalCode(root, "renderVueInvoiceWidget");
      expect(vueRes.degraded).toBe(false);
      expect(vueRes.hits.map((h) => h.ref)).toEqual(["src/components/InvoiceCard.vue"]);

      expect((await searchLocalCode(root, "svelteStatusBadge")).hits.map((h) => h.ref)).toEqual([
        "src/components/Badge.svelte",
      ]);
      expect((await searchLocalCode(root, "astroPageShell")).hits.map((h) => h.ref)).toEqual([
        "src/components/Layout.astro",
      ]);
      expect((await searchLocalCode(root, "BillingSummary")).hits.map((h) => h.ref)).toEqual([
        "schema/billing.graphql",
      ]);
      expect((await searchLocalCode(root, "InvoiceCreatedEvent")).hits.map((h) => h.ref)).toEqual([
        "schema/billing.proto",
      ]);

      // Standalone WAL sidecars are checkpointed and removed on close
      const dbPath = join(root, ".catenext/cache/code-search.sqlite");
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);

      // Verify data is durable in main sqlite file when opened read-only
      const roDb = openDatabaseAt(dbPath, { readOnly: true });
      try {
        const count = (
          roDb.prepare("SELECT COUNT(*) AS c FROM code_search_files").get() as { c: number }
        ).c;
        expect(count).toBe(7);
      } finally {
        roDb.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexes code chunks incrementally by sha256 and skips unchanged chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-embed-index-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/auth.ts"), "export function verifyJwt() { return true; }\n");
      await writeFile(join(root, "src/billing.ts"), "export function chargeCard() { return 1; }\n");

      const embedCalls: string[][] = [];
      const mockClient: EmbeddingClient = {
        provider: "ollama",
        model: "nomic-embed-text",
        endpoint: "http://127.0.0.1:11434",
        async embed(texts) {
          embedCalls.push([...texts]);
          return texts.map((t) =>
            t.includes("auth") ? new Float32Array([1, 0, 0]) : new Float32Array([0, 1, 0]),
          );
        },
      };

      const first = await indexCodeEmbeddings(root, { client: mockClient });
      expect(first).toMatchObject({
        indexed: 2,
        skipped: 0,
        deleted: 0,
        totalChunks: 2,
        model: "nomic-embed-text",
        provider: "ollama",
      });
      expect(embedCalls).toHaveLength(1);

      // Second run with unchanged files skips both chunks without calling embed()
      const second = await indexCodeEmbeddings(root, { client: mockClient });
      expect(second).toMatchObject({ indexed: 0, skipped: 2, deleted: 0, totalChunks: 2 });
      expect(embedCalls).toHaveLength(1);

      // Modify one file -> only modified chunk is re-embedded
      await writeFile(
        join(root, "src/auth.ts"),
        "export function verifyJwt() { return Boolean(Date.now()); }\n",
      );
      const third = await indexCodeEmbeddings(root, { client: mockClient });
      expect(third).toMatchObject({ indexed: 1, skipped: 1, deleted: 0, totalChunks: 2 });
      expect(embedCalls).toHaveLength(2);
      expect(embedCalls[1]).toHaveLength(1);
      expect(embedCalls[1]?.[0]).toContain("src/auth.ts");

      // Delete one file -> stale chunk is pruned
      await rm(join(root, "src/billing.ts"));
      const fourth = await indexCodeEmbeddings(root, { client: mockClient });
      expect(fourth).toMatchObject({ indexed: 0, skipped: 1, deleted: 1, totalChunks: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blends Vector Cosine + FTS5 BM25 via RRF and falls back gracefully on offline/timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "catenext-embed-rrf-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      // File A: semantic match for "authentication" (uses jwt/session), no literal "authentication" word
      await writeFile(
        join(root, "src/session.ts"),
        "export function validateBearerSession(token: string) { return token.length > 0; }\n",
      );
      // File B: keyword match for "authentication", plus vector match
      await writeFile(
        join(root, "src/auth.ts"),
        "export function authenticationGuard() { return true; }\n",
      );
      // File C: unrelated
      await writeFile(
        join(root, "src/math.ts"),
        "export function addNumbers(a: number, b: number) { return a + b; }\n",
      );

      const mockClient: EmbeddingClient = {
        provider: "ollama",
        model: "nomic-embed-text",
        endpoint: "http://127.0.0.1:11434",
        async embed(texts) {
          return texts.map((t) => {
            if (t.includes("src/auth.ts")) return new Float32Array([0.9, 0.1, 0]);
            if (t.includes("src/session.ts")) return new Float32Array([0.85, 0.2, 0]);
            if (t.includes("src/math.ts")) return new Float32Array([0, 0, 1]);
            // Query vector for "authentication"
            return new Float32Array([1, 0, 0]);
          });
        },
      };

      await indexCodeEmbeddings(root, { client: mockClient });

      // Hybrid RRF: returns both auth.ts (FTS5 + Vector) and session.ts (Vector semantic match), with auth.ts ranked #1
      const hybrid = await searchLocalCode(root, "authentication", 5, {
        embeddingClient: mockClient,
      });
      expect(hybrid.reranked).toBe(true);
      expect(hybrid.degraded).toBe(false);
      expect(hybrid.hits.map((h) => h.ref)).toEqual(["src/auth.ts", "src/session.ts"]);

      // Graceful fallback when embedding provider times out / is offline
      const failingClient: EmbeddingClient = {
        provider: "ollama",
        model: "nomic-embed-text",
        endpoint: "http://127.0.0.1:11434",
        embed: vi.fn(async () => {
          throw new EmbeddingError("timeout", "Request timed out");
        }),
      };

      const fallback = await searchLocalCode(root, "authentication", 5, {
        embeddingClient: failingClient,
      });
      expect(fallback.reranked).toBe(false);
      expect(fallback.degraded).toBe(false);
      expect(fallback.hits.map((h) => h.ref)).toEqual(["src/auth.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
