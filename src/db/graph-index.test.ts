import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CatenextConfigSchema } from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalService } from "../local-service.js";
import { DEFAULT_MAX_FILE_BYTES } from "../workspace-walk.js";
import {
  graphNeighbors,
  indexProjectGraph,
  loadGoModule,
  parseImports,
  parseSymbols,
  resolveImport,
  symbolSearch,
} from "./graph-index.js";
import { openDatabaseAt } from "./open.js";
import { LocalStore } from "./store.js";

let root: string;
let dbPath: string;
let projectId: string;

function ensureProject(db: DatabaseSync, id: string): void {
  db.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)").run(
    id,
    "2026-01-01T00:00:00.000Z",
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-graph-"));
  dbPath = join(root, "state.sqlite");
  projectId = randomUUID();
  const db = openDatabaseAt(dbPath);
  try {
    ensureProject(db, projectId);
  } finally {
    db.close();
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveImport & parseImports", () => {
  it("resolves extensionless, index.*, and ESM .js -> .ts imports to real files", async () => {
    await mkdir(join(root, "src/dir"), { recursive: true });
    await mkdir(join(root, "src/ui"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "");
    await writeFile(join(root, "src/b.tsx"), "");
    await writeFile(join(root, "src/c.mts"), "");
    await writeFile(join(root, "src/d.js"), "");
    await writeFile(join(root, "src/dir/index.ts"), "");
    await writeFile(join(root, "src/ui/index.tsx"), "");

    const from = join(root, "src/entry.ts");
    expect(resolveImport(from, "./a", root)).toBe("src/a.ts");
    expect(resolveImport(from, "./b", root)).toBe("src/b.tsx");
    expect(resolveImport(from, "./c", root)).toBe("src/c.mts");
    expect(resolveImport(from, "./d", root)).toBe("src/d.js");
    expect(resolveImport(from, "./a.js", root)).toBe("src/a.ts");
    expect(resolveImport(from, "./dir", root)).toBe("src/dir/index.ts");
    expect(resolveImport(from, "./ui", root)).toBe("src/ui/index.tsx");
    expect(resolveImport(from, "./missing", root)).toBe("src/missing");
    expect(resolveImport(from, "../../outside", root)).toBeNull();
  });

  it("extracts static, re-export, type, require, and dynamic relative imports", () => {
    const code = `
      import { a } from "./a";
      import type { T } from "./types";
      import "./side";
      export { b } from "./b.js";
      export * from "./dir";
      const c = require("./cjs");
      const d = await import("./dyn");
      import { fs } from "node:fs";
    `;
    expect(parseImports(code)).toEqual([
      "./a",
      "./types",
      "./side",
      "./b.js",
      "./dir",
      "./cjs",
      "./dyn",
    ]);
  });

  it("populates to_file_id for extensionless and index imports when indexing", async () => {
    await mkdir(join(root, "src/utils"), { recursive: true });
    await writeFile(
      join(root, "src/main.ts"),
      `import { helper } from "./helper";\nimport { util } from "./utils";\nimport { nope } from "./nope";\n`,
    );
    await writeFile(join(root, "src/helper.tsx"), "export function helper() { return 1; }\n");
    await writeFile(join(root, "src/utils/index.ts"), "export const util = 2;\n");

    const res = await indexProjectGraph(dbPath, projectId, root);
    expect(res.files).toBe(3);
    expect(res.edges).toBe(3);

    const db = openDatabaseAt(dbPath);
    try {
      const edges = db
        .prepare(
          `SELECT e.to_file_id, e.label, f2.path AS target_path
           FROM edges e
           LEFT JOIN files f2 ON f2.id = e.to_file_id
           WHERE e.project_id = ?
           ORDER BY e.id`,
        )
        .all(projectId) as Array<{
        to_file_id: number | null;
        label: string;
        target_path: string | null;
      }>;
      expect(edges).toEqual([
        { to_file_id: expect.any(Number), label: "src/helper.tsx", target_path: "src/helper.tsx" },
        {
          to_file_id: expect.any(Number),
          label: "src/utils/index.ts",
          target_path: "src/utils/index.ts",
        },
        { to_file_id: null, label: "src/nope", target_path: null },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("walk dot-dir skip, gitignore, size cap & symlink boundary", () => {
  it("skips .next, .venv, .nuxt, target, out, .git, .catenext, node_modules, and dist directories", async () => {
    for (const dir of [
      ".next/server",
      ".venv/lib",
      ".nuxt/dist",
      "target/debug",
      "out/static",
      ".git/hooks",
      ".catenext",
      "node_modules/pkg",
      "dist",
      "src",
    ]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, ".next/server/app.js"), "export function bad1() {}\n");
    await writeFile(join(root, ".venv/lib/site.py"), "def bad2():\n  pass\n");
    await writeFile(join(root, ".nuxt/dist/entry.js"), "export function badNuxt() {}\n");
    await writeFile(join(root, "target/debug/main.rs"), "pub fn bad_rust() {}\n");
    await writeFile(join(root, "out/static/chunk.js"), "export function badOut() {}\n");
    await writeFile(join(root, ".git/hooks/pre.js"), "export function bad3() {}\n");
    await writeFile(join(root, ".catenext/gen.ts"), "export function bad4() {}\n");
    await writeFile(join(root, "node_modules/pkg/index.js"), "export function bad5() {}\n");
    await writeFile(join(root, "dist/index.js"), "export function bad6() {}\n");
    await writeFile(join(root, "src/good.ts"), "export function goodFn() {}\n");

    const res = await indexProjectGraph(dbPath, projectId, root);
    expect(res.files).toBe(1);
    expect(symbolSearch(dbPath, projectId, "bad", 20)).toEqual([]);
    expect(symbolSearch(dbPath, projectId, "goodFn", 20)).toEqual([
      { name: "goodFn", kind: "function", path: "src/good.ts", line: 1 },
    ]);
  });

  it("honors root and nested .gitignore rules including negation", async () => {
    await mkdir(join(root, "src/gen"), { recursive: true });
    await writeFile(
      join(root, ".gitignore"),
      ["*.gen.ts", "src/gen/*", "!src/gen/keep.ts", ""].join("\n"),
    );
    await writeFile(join(root, "src/ignored.gen.ts"), "export function ignoredGen() {}\n");
    await writeFile(join(root, "src/gen/drop.ts"), "export function droppedGen() {}\n");
    await writeFile(join(root, "src/gen/keep.ts"), "export function keptGen() {}\n");

    await mkdir(join(root, "src/nested"), { recursive: true });
    await writeFile(join(root, "src/nested/.gitignore"), "skip.ts\n");
    await writeFile(join(root, "src/nested/skip.ts"), "export function nestedSkip() {}\n");
    await writeFile(join(root, "src/nested/ok.ts"), "export function nestedOk() {}\n");

    const res = await indexProjectGraph(dbPath, projectId, root);
    expect(res.files).toBe(2);
    expect(symbolSearch(dbPath, projectId, "ignoredGen", 10)).toEqual([]);
    expect(symbolSearch(dbPath, projectId, "droppedGen", 10)).toEqual([]);
    expect(symbolSearch(dbPath, projectId, "nestedSkip", 10)).toEqual([]);
    expect(symbolSearch(dbPath, projectId, "keptGen", 10).map((h) => h.name)).toEqual(["keptGen"]);
    expect(symbolSearch(dbPath, projectId, "nestedOk", 10).map((h) => h.name)).toEqual([
      "nestedOk",
    ]);
  });

  it("skips oversized files exceeding max file byte cap before readFile", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/normal.ts"), "export function normalSizedFn() {}\n");
    await writeFile(
      join(root, "src/oversized.ts"),
      `export function oversizedFn() {}\n// ${"a".repeat(DEFAULT_MAX_FILE_BYTES + 64)}\n`,
    );

    const res = await indexProjectGraph(dbPath, projectId, root);
    expect(res.files).toBe(1);
    expect(symbolSearch(dbPath, projectId, "oversizedFn", 10)).toEqual([]);
    expect(symbolSearch(dbPath, projectId, "normalSizedFn", 10)).toHaveLength(1);
  });

  it("rejects symlink loops and symlink escapes outside workspace root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "catenext-graph-outside-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/safe.ts"), "export function safeGraphFn() {}\n");
      await writeFile(join(outside, "leak.ts"), "export function escapedGraphFn() {}\n");

      let hasFileSymlink = false;
      try {
        await symlink(join(outside, "leak.ts"), join(root, "src/escape.ts"));
        hasFileSymlink = true;
      } catch (error) {
        if (
          !(
            process.platform === "win32" &&
            error instanceof Error &&
            "code" in error &&
            error.code === "EPERM"
          )
        ) {
          throw error;
        }
      }
      await symlink(outside, join(root, "src/escape-dir"), "junction");
      await symlink(join(root, "src"), join(root, "src/loop"), "junction");

      const res = await indexProjectGraph(dbPath, projectId, root);
      expect(res.files).toBe(1);
      expect(symbolSearch(dbPath, projectId, "escapedGraphFn", 10)).toEqual([]);
      expect(symbolSearch(dbPath, projectId, "safeGraphFn", 10)).toHaveLength(1);
      if (hasFileSymlink) {
        expect(resolveImport(join(root, "src/safe.ts"), "./escape", root)).not.toBe(
          "src/escape.ts",
        );
      }
      expect(resolveImport(join(root, "src/safe.ts"), "./escape-dir/leak", root)).not.toBe(
        "src/escape-dir/leak.ts",
      );
      expect(resolveImport(join(root, "src/safe.ts"), "../../outside/leak", root)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("parseSymbols multi-language", () => {
  it("extracts TS interface, type, enum, function, class, and variable symbols", () => {
    const ts = [
      "export interface UserRecord {",
      "  id: string;",
      "}",
      "export type UserMap<K, V = Map<string, number>> = Record<string, V>;",
      "export enum Role {",
      "  Admin = 'admin',",
      "}",
      "export const enum Flags { None = 0 }",
      "export async function loadUser() {}",
      "export abstract class BaseRepo {}",
      "export const DEFAULT_PORT: number = 3000;",
    ].join("\n");

    expect(parseSymbols(ts, ".ts")).toEqual([
      { name: "UserRecord", kind: "interface", line: 1 },
      { name: "UserMap", kind: "type", line: 4 },
      { name: "Role", kind: "enum", line: 5 },
      { name: "Flags", kind: "enum", line: 8 },
      { name: "loadUser", kind: "function", line: 9 },
      { name: "BaseRepo", kind: "class", line: 10 },
      { name: "DEFAULT_PORT", kind: "variable", line: 11 },
    ]);
  });

  it("extracts Go func and type symbols", () => {
    const go = [
      "package server",
      "",
      "type Config struct {",
      "  Port int",
      "}",
      "type Handler interface {",
      "  Serve()",
      "}",
      "func NewServer(cfg Config) *Server { return nil }",
      "func (s *Server) Start() error { return nil }",
      "func MapSlice[T any](items []T) []T { return items }",
    ].join("\n");

    expect(parseSymbols(go, ".go")).toEqual([
      { name: "Config", kind: "type", line: 3 },
      { name: "Handler", kind: "type", line: 6 },
      { name: "NewServer", kind: "function", line: 9 },
      { name: "Start", kind: "function", line: 10 },
      { name: "MapSlice", kind: "function", line: 11 },
    ]);
  });

  it("extracts Rust fn, struct, enum, and trait symbols", () => {
    const rs = [
      "pub struct Store {",
      "  id: u64,",
      "}",
      "pub(crate) enum State {",
      "  Ready,",
      "}",
      "pub trait Runner {",
      "  fn step(&self);",
      "}",
      "pub async fn run_server() {}",
      "impl Store {",
      "  pub fn open() -> Self { todo!() }",
      "}",
    ].join("\n");

    expect(parseSymbols(rs, ".rs")).toEqual([
      { name: "Store", kind: "struct", line: 1 },
      { name: "State", kind: "enum", line: 4 },
      { name: "Runner", kind: "trait", line: 7 },
      { name: "step", kind: "function", line: 8 },
      { name: "run_server", kind: "function", line: 10 },
      { name: "open", kind: "function", line: 12 },
    ]);
  });

  it("extracts PHP namespace, class, interface, trait, enum, and function/method symbols", () => {
    const php = [
      "<?php",
      "namespace App\\Http\\Controllers;",
      "interface Authenticatable {",
      "  public function getAuthId(): int;",
      "}",
      "trait HasTimestamps {",
      "  public function touchTimestamp(): void {}",
      "}",
      "enum Status: string {",
      "  case Active = 'active';",
      "}",
      "final class UserController {",
      "  public function __construct() {}",
      "  protected static function buildKey(): string { return 'k'; }",
      "}",
      "function helperFn(string $v): string { return $v; }",
    ].join("\n");

    expect(parseSymbols(php, ".php")).toEqual([
      { name: "App\\Http\\Controllers", kind: "namespace", line: 2 },
      { name: "Authenticatable", kind: "interface", line: 3 },
      { name: "getAuthId", kind: "function", line: 4 },
      { name: "HasTimestamps", kind: "trait", line: 6 },
      { name: "touchTimestamp", kind: "function", line: 7 },
      { name: "Status", kind: "enum", line: 9 },
      { name: "UserController", kind: "class", line: 12 },
      { name: "__construct", kind: "function", line: 13 },
      { name: "buildKey", kind: "function", line: 14 },
      { name: "helperFn", kind: "function", line: 16 },
    ]);
  });

  it("extracts Java class, record, interface, enum, and method symbols without control-flow noise", () => {
    const java = [
      "package com.example.orders;",
      "public interface OrderRepo {",
      "  Order findById(String id);",
      "}",
      "public enum OrderState { NEW, PAID }",
      "public record OrderId(String value) {}",
      "public final class OrderService {",
      "  private static final String PREFIX = makePrefix();",
      "  public OrderService(OrderRepo repo) {}",
      "  public <T> List<T> loadItems(String id) {",
      "    if (id == null) { return List.of(); }",
      "    return fetchItems();",
      "  }",
      "  void internalSync() {}",
      "}",
    ].join("\n");

    expect(parseSymbols(java, ".java")).toEqual([
      { name: "OrderRepo", kind: "interface", line: 2 },
      { name: "findById", kind: "function", line: 3 },
      { name: "OrderState", kind: "enum", line: 5 },
      { name: "OrderId", kind: "class", line: 6 },
      { name: "OrderService", kind: "class", line: 7 },
      { name: "OrderService", kind: "function", line: 9 },
      { name: "loadItems", kind: "function", line: 10 },
      { name: "internalSync", kind: "function", line: 14 },
    ]);
  });

  it("extracts Kotlin class, interface, enum, object, and fun symbols", () => {
    const kt = [
      "package com.example.users",
      "enum class Role { ADMIN, USER }",
      "interface UserStore {",
      "  suspend fun find(id: String): UserDto?",
      "}",
      "data class UserDto(val id: String)",
      "object Defaults {",
      "  fun defaultRole() = Role.USER",
      "}",
      "class Helper {",
      "  companion object {",
      "    fun create() = Helper()",
      "  }",
      "}",
      "private fun String.slugify(): String = lowercase()",
    ].join("\n");

    expect(parseSymbols(kt, ".kt")).toEqual([
      { name: "Role", kind: "enum", line: 2 },
      { name: "UserStore", kind: "interface", line: 3 },
      { name: "find", kind: "function", line: 4 },
      { name: "UserDto", kind: "class", line: 6 },
      { name: "Defaults", kind: "class", line: 7 },
      { name: "defaultRole", kind: "function", line: 8 },
      { name: "Helper", kind: "class", line: 10 },
      { name: "create", kind: "function", line: 12 },
      { name: "slugify", kind: "function", line: 15 },
    ]);
  });

  it("extracts Vue and Svelte <script> symbols with accurate line offsets and relative imports", () => {
    const vue = [
      "<template>",
      "  <div>{{ title }}</div>",
      "</template>",
      '<script setup lang="ts">',
      'import { ref } from "vue";',
      'import Badge from "./Badge.vue";',
      "export interface CardProps {",
      "  title: string;",
      "}",
      "function formatTitle(v: string) { return v; }",
      "const activeCount = ref(0);",
      "</script>",
    ].join("\n");

    expect(parseSymbols(vue, ".vue")).toEqual([
      { name: "CardProps", kind: "interface", line: 7 },
      { name: "formatTitle", kind: "function", line: 10 },
      { name: "activeCount", kind: "variable", line: 11 },
    ]);
    expect(parseImports(vue, ".vue")).toEqual(["./Badge.vue"]);

    const svelte = [
      '<script context="module" lang="ts">',
      "export type ItemKind = 'a' | 'b';",
      "</script>",
      '<script lang="ts">',
      'import { loadItem } from "./loader";',
      "export function selectItem() {}",
      "</script>",
      "<main>hi</main>",
    ].join("\n");

    expect(parseSymbols(svelte, ".svelte")).toEqual([
      { name: "ItemKind", kind: "type", line: 2 },
      { name: "selectItem", kind: "function", line: 6 },
    ]);
    expect(parseImports(svelte, ".svelte")).toEqual(["./loader"]);
  });
});

describe("PHP PSR-4, Python relative imports, SFC graph & standalone WAL cleanup", () => {
  it("parses PHP use statements and resolves composer.json PSR-4 within realRoot boundaries", async () => {
    const outside = await mkdtemp(join(tmpdir(), "catenext-php-outside-"));
    try {
      await mkdir(join(root, "app/Http/Controllers"), { recursive: true });
      await mkdir(join(root, "app/Models"), { recursive: true });
      await mkdir(join(root, "app/Services"), { recursive: true });
      await mkdir(join(root, "tests/Unit"), { recursive: true });
      await writeFile(join(outside, "Secret.php"), "<?php\nnamespace Outside;\nclass Secret {}\n");

      await writeFile(
        join(root, "composer.json"),
        JSON.stringify({
          autoload: {
            "psr-4": {
              "App\\": "app/",
              "Escape\\": "../outside/",
            },
          },
          "autoload-dev": {
            "psr-4": {
              "Tests\\": ["tests/"],
            },
          },
        }),
      );

      const controllerPhp = [
        "<?php",
        "namespace App\\Http\\Controllers;",
        "use App\\Models\\User;",
        "use App\\Services\\{BillingService, AuditLogger as Logger};",
        "use function App\\Helpers\\formatCurrency;",
        "use Symfony\\Component\\HttpFoundation\\Request;",
        "use Escape\\Secret;",
        "class UserController {",
        "  public function index() {",
        "    $fn = function () use ($a) { return $a; };",
        "  }",
        "}",
      ].join("\n");

      expect(parseImports(controllerPhp, ".php")).toEqual([
        "App\\Services\\BillingService",
        "App\\Services\\AuditLogger",
        "App\\Models\\User",
        "Symfony\\Component\\HttpFoundation\\Request",
        "Escape\\Secret",
      ]);

      await writeFile(join(root, "app/Http/Controllers/UserController.php"), controllerPhp);
      await writeFile(
        join(root, "app/Models/User.php"),
        "<?php\nnamespace App\\Models;\nclass User {}\n",
      );
      await writeFile(
        join(root, "app/Services/BillingService.php"),
        "<?php\nnamespace App\\Services;\nclass BillingService {}\n",
      );
      await writeFile(
        join(root, "app/Services/AuditLogger.php"),
        "<?php\nnamespace App\\Services;\nclass AuditLogger {}\n",
      );
      await writeFile(
        join(root, "tests/Unit/UserTest.php"),
        "<?php\nnamespace Tests\\Unit;\nuse App\\Models\\User;\nclass UserTest {}\n",
      );

      // Symlinked PHP class inside app/Models pointing outside root must be rejected
      try {
        await symlink(join(outside, "Secret.php"), join(root, "app/Models/Leaked.php"));
      } catch (error) {
        if (
          !(
            process.platform === "win32" &&
            error instanceof Error &&
            "code" in error &&
            error.code === "EPERM"
          )
        ) {
          throw error;
        }
      }
      expect(
        resolveImport(
          join(root, "app/Http/Controllers/UserController.php"),
          "App\\Models\\Leaked",
          root,
        ),
      ).toBeNull();
      expect(
        resolveImport(
          join(root, "app/Http/Controllers/UserController.php"),
          "Escape\\Secret",
          root,
        ),
      ).toBeNull();

      const res = await indexProjectGraph(dbPath, projectId, root);
      expect(res.files).toBe(5);
      expect(res.edges).toBe(4);

      expect(
        graphNeighbors(dbPath, projectId, "app/Http/Controllers/UserController.php", 10, 1),
      ).toEqual([
        {
          kind: "imports",
          from: "app/Http/Controllers/UserController.php",
          to: "app/Services/BillingService.php",
          label: "app/Services/BillingService.php",
        },
        {
          kind: "imports",
          from: "app/Http/Controllers/UserController.php",
          to: "app/Services/AuditLogger.php",
          label: "app/Services/AuditLogger.php",
        },
        {
          kind: "imports",
          from: "app/Http/Controllers/UserController.php",
          to: "app/Models/User.php",
          label: "app/Models/User.php",
        },
      ]);

      expect(graphNeighbors(dbPath, projectId, "tests/Unit/UserTest.php", 10, 1)).toEqual([
        {
          kind: "imports",
          from: "tests/Unit/UserTest.php",
          to: "app/Models/User.php",
          label: "app/Models/User.php",
        },
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("indexes Vue, Svelte, Python relative imports, Java, and Kotlin files and checkpoints standalone WAL", async () => {
    await mkdir(join(root, "web"), { recursive: true });
    await mkdir(join(root, "py/pkg"), { recursive: true });
    await mkdir(join(root, "jvm"), { recursive: true });

    await writeFile(
      join(root, "web/App.vue"),
      '<script setup lang="ts">\nimport Card from "./Card.svelte";\nexport function mountApp() {}\n</script>\n',
    );
    await writeFile(
      join(root, "web/Card.svelte"),
      '<script lang="ts">\nexport interface CardState { open: boolean; }\n</script>\n',
    );
    await writeFile(
      join(root, "py/pkg/runner.py"),
      "from .helper import run_step\ndef start_runner():\n  return run_step()\n",
    );
    await writeFile(join(root, "py/pkg/helper.py"), "def run_step():\n  return 1\n");
    await writeFile(
      join(root, "jvm/Main.java"),
      "public class Main {\n  public static void runJava() {}\n}\n",
    );
    await writeFile(join(root, "jvm/App.kt"), "class KotlinApp {\n  fun bootKotlin() {}\n}\n");

    const res = await indexProjectGraph(dbPath, projectId, root);
    expect(res.files).toBe(6);

    // Standalone WAL sidecars are checkpointed & cleaned up
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    expect(graphNeighbors(dbPath, projectId, "web/App.vue", 10, 1)).toEqual([
      {
        kind: "imports",
        from: "web/App.vue",
        to: "web/Card.svelte",
        label: "web/Card.svelte",
      },
    ]);
    expect(graphNeighbors(dbPath, projectId, "py/pkg/runner.py", 10, 1)).toEqual([
      {
        kind: "imports",
        from: "py/pkg/runner.py",
        to: "py/pkg/helper.py",
        label: "py/pkg/helper.py",
      },
    ]);

    expect(symbolSearch(dbPath, projectId, "mountApp", 10)).toHaveLength(1);
    expect(symbolSearch(dbPath, projectId, "CardState", 10)).toHaveLength(1);
    expect(symbolSearch(dbPath, projectId, "runJava", 10)).toHaveLength(1);
    expect(symbolSearch(dbPath, projectId, "bootKotlin", 10)).toHaveLength(1);

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe("graphNeighbors depth & LocalService connection reuse", () => {
  it("supports depth=1 and depth=2 with deduplication and limit", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), `import "./b";\n`);
    await writeFile(join(root, "src/b.ts"), `import "./c";\n`);
    await writeFile(join(root, "src/c.ts"), `import "./d";\n`);
    await writeFile(join(root, "src/d.ts"), `export const d = 1;\n`);
    await writeFile(join(root, "src/caller.ts"), `import "./a";\n`);

    await indexProjectGraph(dbPath, projectId, root);

    const depth1 = graphNeighbors(dbPath, projectId, "src/a.ts", 20, 1);
    expect(depth1).toEqual([
      { kind: "imports", from: "src/a.ts", to: "src/b.ts", label: "src/b.ts" },
      { kind: "imports", from: "src/caller.ts", to: "src/a.ts", label: "src/a.ts" },
    ]);

    const depth2 = graphNeighbors(dbPath, projectId, "src/a.ts", 20, 2);
    expect(depth2).toEqual([
      { kind: "imports", from: "src/a.ts", to: "src/b.ts", label: "src/b.ts" },
      { kind: "imports", from: "src/caller.ts", to: "src/a.ts", label: "src/a.ts" },
      { kind: "imports", from: "src/b.ts", to: "src/c.ts", label: "src/c.ts" },
    ]);

    const limited = graphNeighbors(dbPath, projectId, "src/a.ts", 2, 2);
    expect(limited).toHaveLength(2);
  });

  it("passes depth through LocalService and reuses active SQLite connection inside LocalStore transactions", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), `import "./b";\nexport interface Alpha {}\n`);
    await writeFile(join(root, "src/b.ts"), `import "./c";\n`);
    await writeFile(join(root, "src/c.ts"), `export const c = 3;\n`);

    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: projectId,
      project_name: "GraphTest",
      repo_name: "catenext",
      state_file: "state.sqlite",
    });
    const service = new LocalService(root, config);
    await service.callTool("session_brief", {});
    await indexProjectGraph(service.stateFile, projectId, root);

    const d1 = await service.callTool("graph_neighbors", { path: "src/a.ts", depth: 1 });
    expect(d1.edges).toHaveLength(1);

    const d2 = await service.callTool("graph_neighbors", { path: "src/a.ts", depth: 2 });
    expect(d2.edges).toEqual([
      { kind: "imports", from: "src/a.ts", to: "src/b.ts", label: "src/b.ts" },
      { kind: "imports", from: "src/b.ts", to: "src/c.ts", label: "src/c.ts" },
    ]);

    const hits = await service.callTool("symbol_search", { query: "Alpha" });
    expect(hits.hits).toEqual([{ name: "Alpha", kind: "interface", path: "src/a.ts", line: 2 }]);

    // Verify reusing an active DatabaseSync inside a LocalStore transaction avoids lock contention
    const store = new LocalStore(service.stateFile);
    await store.transaction(projectId, "catenext", async (_project, _dirty, db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        await indexProjectGraph(db, projectId, root);
        const insideEdges = graphNeighbors(db, projectId, "src/a.ts", 10, 2);
        const insideSymbols = symbolSearch(db, projectId, "Alpha", 10);
        expect(insideEdges).toHaveLength(2);
        expect(insideSymbols).toHaveLength(1);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    });
  });
});

describe("incremental indexing", () => {
  function readFileRow(path: string) {
    const db = openDatabaseAt(dbPath);
    try {
      return db
        .prepare("SELECT id, hash, mtime_ms FROM files WHERE project_id = ? AND path = ?")
        .get(projectId, path) as { id: number; hash: string; mtime_ms: number } | undefined;
    } finally {
      db.close();
    }
  }

  function readSymbolIds(fileId: number) {
    const db = openDatabaseAt(dbPath);
    try {
      return (
        db
          .prepare("SELECT id, name FROM symbols WHERE project_id = ? AND file_id = ? ORDER BY id")
          .all(projectId, fileId) as Array<{ id: number; name: string }>
      ).map((r) => r.id);
    } finally {
      db.close();
    }
  }

  it("skips unchanged files, updates mtime-only touches without re-inserting symbols, and refreshes added/deleted edges", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    const aPath = join(root, "src/a.ts");
    const bPath = join(root, "src/b.ts");
    await writeFile(aPath, `import "./b";\nimport "./c";\nexport function fnA() {}\n`);
    await writeFile(bPath, `export function fnB() {}\n`);

    const first = await indexProjectGraph(dbPath, projectId, root);
    expect(first).toEqual({ files: 2, symbols: 2, edges: 2 });

    const aRow1 = readFileRow("src/a.ts");
    const bRow1 = readFileRow("src/b.ts");
    if (!aRow1 || !bRow1) throw new Error("Expected initial rows");
    const aSyms1 = readSymbolIds(aRow1.id);
    const bSyms1 = readSymbolIds(bRow1.id);

    // Re-index with no changes: IDs remain identical
    const second = await indexProjectGraph(dbPath, projectId, root);
    expect(second).toEqual({ files: 2, symbols: 2, edges: 2 });
    expect(readFileRow("src/a.ts")).toEqual(aRow1);
    expect(readSymbolIds(aRow1.id)).toEqual(aSyms1);

    // Touch b.ts mtime without changing content: hash stays same, symbol IDs preserved
    const baseSec = Math.floor((bRow1.mtime_ms ?? Date.now()) / 1000) * 1000;
    const bumped = new Date(baseSec + 5000);
    await utimes(bPath, bumped, bumped);
    await indexProjectGraph(dbPath, projectId, root);
    const bRow2 = readFileRow("src/b.ts");
    expect(bRow2?.id).toBe(bRow1.id);
    expect(bRow2?.hash).toBe(bRow1.hash);
    expect(bRow2?.mtime_ms).toBe(bumped.getTime());
    expect(readSymbolIds(bRow1.id)).toEqual(bSyms1);

    // Modify b.ts content & add c.ts (previously unresolved import from untouched a.ts)
    const cPath = join(root, "src/c.ts");
    await writeFile(bPath, `export interface NewB {}\nexport function fnB2() {}\n`);
    await utimes(bPath, new Date(bumped.getTime() + 5000), new Date(bumped.getTime() + 5000));
    await writeFile(cPath, `export const valC = 1;\n`);

    const third = await indexProjectGraph(dbPath, projectId, root);
    expect(third).toEqual({ files: 3, symbols: 4, edges: 2 });
    expect(readSymbolIds(aRow1.id)).toEqual(aSyms1);
    expect(symbolSearch(dbPath, projectId, "NewB", 10)).toHaveLength(1);
    expect(symbolSearch(dbPath, projectId, "fnB", 10).map((h) => h.name)).toEqual(["fnB2"]);

    // Untouched a.ts -> newly added c.ts should now resolve to_file_id
    const edgesAfterAdd = graphNeighbors(dbPath, projectId, "src/c.ts", 10, 1);
    expect(edgesAfterAdd).toEqual([
      { kind: "imports", from: "src/a.ts", to: "src/c.ts", label: "src/c.ts" },
    ]);

    // Delete c.ts: a.ts edge to c.ts should revert to unresolved (to_file_id = NULL) rather than vanish
    await rm(cPath);
    const fourth = await indexProjectGraph(dbPath, projectId, root);
    expect(fourth).toEqual({ files: 2, symbols: 3, edges: 2 });
    const aEdges = graphNeighbors(dbPath, projectId, "src/a.ts", 10, 1);
    expect(aEdges).toEqual([
      { kind: "imports", from: "src/a.ts", to: "src/b.ts", label: "src/b.ts" },
      { kind: "imports", from: "src/a.ts", to: "src/c", label: "src/c" },
    ]);
  });

  it("indexes registered workspace_roots with root_id and skips missing roots gracefully", async () => {
    const extRoot = await mkdtemp(join(tmpdir(), "catenext-graph-ext-"));
    const missingRoot = join(tmpdir(), "catenext-graph-missing-root");
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/app.ts"), "export function primaryApp() {}\n");

      await mkdir(join(extRoot, "lib"), { recursive: true });
      await writeFile(
        join(extRoot, "lib/client.ts"),
        `import { parsePayload } from "./parser";\nexport function remoteClient() { return parsePayload(); }\n`,
      );
      await writeFile(
        join(extRoot, "lib/parser.ts"),
        "export function parsePayload() { return 1; }\n",
      );

      const extId = randomUUID();
      const missingId = randomUUID();
      const db = openDatabaseAt(dbPath);
      try {
        db.prepare(
          "INSERT INTO workspace_roots (id, project_id, path, owner_persona, label) VALUES (?, ?, ?, ?, ?)",
        ).run(extId, projectId, extRoot, "fe", "mobile");
        db.prepare(
          "INSERT INTO workspace_roots (id, project_id, path, owner_persona, label) VALUES (?, ?, ?, ?, ?)",
        ).run(missingId, projectId, missingRoot, "be", "missing");
      } finally {
        db.close();
      }

      const res = await indexProjectGraph(dbPath, projectId, root);
      expect(res.files).toBe(3);

      const dbCheck = openDatabaseAt(dbPath);
      try {
        const rows = dbCheck
          .prepare("SELECT path, root_id FROM files WHERE project_id = ? ORDER BY path")
          .all(projectId) as Array<{ path: string; root_id: string | null }>;
        expect(rows).toEqual([
          { path: "@mobile/lib/client.ts", root_id: extId },
          { path: "@mobile/lib/parser.ts", root_id: extId },
          { path: "src/app.ts", root_id: null },
        ]);
      } finally {
        dbCheck.close();
      }

      expect(symbolSearch(dbPath, projectId, "remoteClient", 10)).toEqual([
        { name: "remoteClient", kind: "function", path: "@mobile/lib/client.ts", line: 2 },
      ]);
      expect(graphNeighbors(dbPath, projectId, "@mobile/lib/client.ts", 10, 1)).toEqual([
        {
          kind: "imports",
          from: "@mobile/lib/client.ts",
          to: "@mobile/lib/parser.ts",
          label: "@mobile/lib/parser.ts",
        },
      ]);
    } finally {
      await rm(extRoot, { recursive: true, force: true });
    }
  });
});

describe("Go, Rust & Python local import resolution", () => {
  it("parses Go imports and resolves go.mod local packages without dangling stdlib edges", async () => {
    const outside = await mkdtemp(join(tmpdir(), "catenext-go-outside-"));
    try {
      await mkdir(join(root, "cmd/api"), { recursive: true });
      await mkdir(join(root, "internal/auth"), { recursive: true });
      await mkdir(join(root, "pkg/types"), { recursive: true });
      await writeFile(join(outside, "leak.go"), "package auth\nfunc Leak() {}\n");

      await writeFile(
        join(root, "go.mod"),
        ["// comment", "module example.com/myapp // trailing comment", "", "go 1.23.0", ""].join(
          "\n",
        ),
      );
      expect(loadGoModule(root)).toBe("example.com/myapp");

      const mainGo = [
        "package main",
        "",
        "import (",
        '\t"fmt"',
        '\t_ "net/http/pprof"',
        '\tauth "example.com/myapp/internal/auth" // local',
        '\t/* block */ . "example.com/myapp/pkg/types"',
        '\t"github.com/external/pkg"',
        ")",
        'import "example.com/myapp/internal/missing"',
        '// import "example.com/myapp/commented"',
        "",
        "func main() { _ = auth.Verify; fmt.Println() }",
      ].join("\n");

      expect(parseImports(mainGo, ".go")).toEqual([
        "fmt",
        "net/http/pprof",
        "example.com/myapp/internal/auth",
        "example.com/myapp/pkg/types",
        "github.com/external/pkg",
        "example.com/myapp/internal/missing",
      ]);

      await writeFile(join(root, "cmd/api/main.go"), mainGo);
      await writeFile(
        join(root, "internal/auth/auth.go"),
        "package auth\nfunc Verify() bool { return true }\n",
      );
      await writeFile(
        join(root, "internal/auth/tokens.go"),
        'package auth\nfunc IssueToken() string { return "t" }\n',
      );
      await writeFile(
        join(root, "internal/auth/auth_test.go"),
        'package auth\nimport "testing"\nfunc TestVerify(t *testing.T) {}\n',
      );
      await writeFile(join(root, "pkg/types/user.go"), "package types\ntype User struct{}\n");

      try {
        await symlink(join(outside, "leak.go"), join(root, "internal/auth/leak.go"));
      } catch (error) {
        if (
          !(
            process.platform === "win32" &&
            error instanceof Error &&
            "code" in error &&
            error.code === "EPERM"
          )
        ) {
          throw error;
        }
      }

      expect(resolveImport(join(root, "cmd/api/main.go"), "fmt", root)).toBeNull();
      expect(
        resolveImport(join(root, "cmd/api/main.go"), "example.com/myapp/internal/auth", root),
      ).toBe("internal/auth/auth.go");
      expect(
        resolveImport(join(root, "cmd/api/main.go"), "example.com/myapp/internal/missing", root),
      ).toBeNull();

      const res = await indexProjectGraph(dbPath, projectId, root);
      expect(res.files).toBe(5);
      expect(res.edges).toBe(3);

      expect(graphNeighbors(dbPath, projectId, "cmd/api/main.go", 10, 1)).toEqual([
        {
          kind: "imports",
          from: "cmd/api/main.go",
          to: "internal/auth/auth.go",
          label: "internal/auth/auth.go",
        },
        {
          kind: "imports",
          from: "cmd/api/main.go",
          to: "internal/auth/tokens.go",
          label: "internal/auth/tokens.go",
        },
        {
          kind: "imports",
          from: "cmd/api/main.go",
          to: "pkg/types/user.go",
          label: "pkg/types/user.go",
        },
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("parses and resolves Rust mod, crate::, super::, and self:: imports within root boundaries", async () => {
    await mkdir(join(root, "src/routes/users"), { recursive: true });
    await mkdir(join(root, "src/parent"), { recursive: true });
    await writeFile(join(root, "Cargo.toml"), '[package]\nname = "app"\nversion = "0.1.0"\n');

    const libRs = [
      "mod config;",
      "pub mod routes;",
      "pub(crate) mod parent;",
      "mod inline_only {",
      "  pub fn stay_inline() {}",
      "}",
      "// mod commented_out;",
      'const TEXT: &str = "use crate::fake;";',
      "pub struct AppState;",
    ].join("\n");

    expect(parseImports(libRs, ".rs")).toEqual(["mod::config", "mod::routes", "mod::parent"]);

    const routesModRs = [
      "pub mod users;",
      "use crate::config::Settings;",
      "use crate::routes::users::{self, list::{self, Handler as ListHandler}};",
      "use super::AppState;",
      "use std::collections::HashMap;",
    ].join("\n");

    expect(parseImports(routesModRs, ".rs")).toEqual([
      "mod::users",
      "crate::config::Settings",
      "crate::routes::users",
      "crate::routes::users::list",
      "crate::routes::users::list::Handler",
      "super::AppState",
    ]);

    const usersModRs = [
      "pub mod list;",
      "use self::list::Handler;",
      "use super::super::config::Settings;",
      "use serde::Serialize;",
    ].join("\n");

    const parentRs = [
      "mod child;",
      "use self::child::ChildItem;",
      "use super::config::Settings;",
    ].join("\n");

    await writeFile(join(root, "src/lib.rs"), libRs);
    await writeFile(join(root, "src/config.rs"), "pub struct Settings;\n");
    await writeFile(join(root, "src/routes/mod.rs"), routesModRs);
    await writeFile(join(root, "src/routes/users/mod.rs"), usersModRs);
    await writeFile(join(root, "src/routes/users/list.rs"), "pub struct Handler;\n");
    await writeFile(join(root, "src/parent.rs"), parentRs);
    await writeFile(join(root, "src/parent/child.rs"), "pub struct ChildItem;\n");

    expect(resolveImport(join(root, "src/lib.rs"), "mod::config", root)).toBe("src/config.rs");
    expect(resolveImport(join(root, "src/lib.rs"), "mod::routes", root)).toBe("src/routes/mod.rs");
    expect(resolveImport(join(root, "src/lib.rs"), "mod::missing", root)).toBeNull();
    expect(resolveImport(join(root, "src/parent.rs"), "mod::child", root)).toBe(
      "src/parent/child.rs",
    );
    expect(resolveImport(join(root, "src/routes/mod.rs"), "super::AppState", root)).toBe(
      "src/lib.rs",
    );
    expect(
      resolveImport(join(root, "src/routes/users/mod.rs"), "super::super::config::Settings", root),
    ).toBe("src/config.rs");
    expect(
      resolveImport(join(root, "src/routes/mod.rs"), "std::collections::HashMap", root),
    ).toBeNull();

    const res = await indexProjectGraph(dbPath, projectId, root);
    expect(res.files).toBe(7);

    const libNeighbors = graphNeighbors(dbPath, projectId, "src/lib.rs", 10, 1);
    expect(libNeighbors).toHaveLength(4);
    expect(libNeighbors).toEqual(
      expect.arrayContaining([
        { kind: "imports", from: "src/lib.rs", to: "src/config.rs", label: "src/config.rs" },
        {
          kind: "imports",
          from: "src/lib.rs",
          to: "src/routes/mod.rs",
          label: "src/routes/mod.rs",
        },
        { kind: "imports", from: "src/lib.rs", to: "src/parent.rs", label: "src/parent.rs" },
        { kind: "imports", from: "src/routes/mod.rs", to: "src/lib.rs", label: "src/lib.rs" },
      ]),
    );

    const parentNeighbors = graphNeighbors(dbPath, projectId, "src/parent.rs", 10, 1);
    expect(parentNeighbors).toHaveLength(3);
    expect(parentNeighbors).toEqual(
      expect.arrayContaining([
        {
          kind: "imports",
          from: "src/parent.rs",
          to: "src/parent/child.rs",
          label: "src/parent/child.rs",
        },
        { kind: "imports", from: "src/parent.rs", to: "src/config.rs", label: "src/config.rs" },
        { kind: "imports", from: "src/lib.rs", to: "src/parent.rs", label: "src/parent.rs" },
      ]),
    );

    const usersNeighbors = graphNeighbors(dbPath, projectId, "src/routes/users/mod.rs", 10, 1);
    expect(usersNeighbors).toHaveLength(3);
    expect(usersNeighbors).toEqual(
      expect.arrayContaining([
        {
          kind: "imports",
          from: "src/routes/users/mod.rs",
          to: "src/routes/users/list.rs",
          label: "src/routes/users/list.rs",
        },
        {
          kind: "imports",
          from: "src/routes/users/mod.rs",
          to: "src/config.rs",
          label: "src/config.rs",
        },
        {
          kind: "imports",
          from: "src/routes/mod.rs",
          to: "src/routes/users/mod.rs",
          label: "src/routes/users/mod.rs",
        },
      ]),
    );
  });

  it("parses and resolves Python package and relative imports while ignoring stdlib/third-party", async () => {
    await mkdir(join(root, "pkg/util"), { recursive: true });
    await mkdir(join(root, "pkg/sub"), { recursive: true });

    const mainPy = [
      "import json, pkg.util as pu",
      "import pytest",
      "from pkg.sub import fn",
      "from .local import local_fn",
      "from os.path import join",
      "",
      "def run():",
      "  return fn()",
    ].join("\n");

    expect(parseImports(mainPy, ".py")).toEqual([
      "./local",
      "pkg.sub",
      "os.path",
      "json",
      "pkg.util",
      "pytest",
    ]);

    await writeFile(join(root, "pkg/__init__.py"), "");
    await writeFile(join(root, "pkg/main.py"), mainPy);
    await writeFile(join(root, "pkg/local.py"), "def local_fn():\n  return 1\n");
    await writeFile(join(root, "pkg/sub.py"), "def fn():\n  return 2\n");
    await writeFile(join(root, "pkg/util/__init__.py"), "def util_fn():\n  return 3\n");
    await writeFile(join(root, "pkg/sub/nested.py"), "from ..util import util_fn\n");

    expect(resolveImport(join(root, "pkg/main.py"), "json", root)).toBeNull();
    expect(resolveImport(join(root, "pkg/main.py"), "pytest", root)).toBeNull();
    expect(resolveImport(join(root, "pkg/main.py"), "pkg.sub", root)).toBe("pkg/sub.py");
    expect(resolveImport(join(root, "pkg/main.py"), "pkg.util", root)).toBe("pkg/util/__init__.py");
    expect(resolveImport(join(root, "pkg/main.py"), "./local", root)).toBe("pkg/local.py");
    expect(resolveImport(join(root, "pkg/sub/nested.py"), "../util", root)).toBe(
      "pkg/util/__init__.py",
    );

    const res = await indexProjectGraph(dbPath, projectId, root);
    expect(res.files).toBe(6);
    expect(res.edges).toBe(4);

    expect(graphNeighbors(dbPath, projectId, "pkg/main.py", 10, 1)).toEqual([
      { kind: "imports", from: "pkg/main.py", to: "pkg/local.py", label: "pkg/local.py" },
      { kind: "imports", from: "pkg/main.py", to: "pkg/sub.py", label: "pkg/sub.py" },
      {
        kind: "imports",
        from: "pkg/main.py",
        to: "pkg/util/__init__.py",
        label: "pkg/util/__init__.py",
      },
    ]);
    expect(graphNeighbors(dbPath, projectId, "pkg/sub/nested.py", 10, 1)).toEqual([
      {
        kind: "imports",
        from: "pkg/sub/nested.py",
        to: "pkg/util/__init__.py",
        label: "pkg/util/__init__.py",
      },
    ]);
  });
});
