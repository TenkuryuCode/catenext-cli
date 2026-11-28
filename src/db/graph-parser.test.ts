import { describe, expect, it } from "vitest";
import {
  extractSfcScriptBlocks,
  MAX_INDEXED_FILE_SYMBOLS,
  parseImports,
  parseSymbols,
  parseTsJsImportEntries,
} from "./graph-parser.js";

describe("extractSfcScriptBlocks", () => {
  it("extracts Vue/Svelte multi-script blocks with accurate line offsets and attribute edge cases", () => {
    const sfc = [
      "<template>",
      "  <scripture>export function notAScript() {}</scripture>",
      "  <script />",
      "</template>",
      '<script type="application/json">',
      '{"ignored": true}',
      "</script>",
      '<script context="module" lang="ts">',
      'import type { Shared } from "./shared";',
      "export type Kind = 'a' | 'b';",
      "</script>",
      '<script setup lang="ts" data-expr="a>b">',
      'import Card from "./Card.vue";',
      "export function mountCard() {}",
      '</SCRIPT data-close="ok">',
    ].join("\n");

    expect(extractSfcScriptBlocks(sfc)).toEqual([
      {
        code: "\nimport type { Shared } from \"./shared\";\nexport type Kind = 'a' | 'b';\n",
        startLine: 8,
      },
      {
        code: '\nimport Card from "./Card.vue";\nexport function mountCard() {}\n',
        startLine: 12,
      },
    ]);
  });
});

describe("parseTsJsImportEntries & parseImports (TS/JS)", () => {
  it("distinguishes imports vs re-exports and handles relative/non-relative filtering", () => {
    const code = [
      'import { a } from "./a";',
      'import type { T } from "./types";',
      'import "./side";',
      'import pkg from "external-pkg";',
      'export { b, c as d } from "./re";',
      'export * from "./star";',
      'export type * from "./type-star";',
      'const cjs = require("./cjs");',
      'const dyn = await import("./dyn");',
      'export { a as reexportedA } from "./a";',
    ].join("\n");

    expect(parseTsJsImportEntries(code, false)).toEqual([
      { spec: "./a", kind: "imports" },
      { spec: "./types", kind: "imports" },
      { spec: "./side", kind: "imports" },
      { spec: "./re", kind: "reexport" },
      { spec: "./star", kind: "reexport" },
      { spec: "./type-star", kind: "reexport" },
      { spec: "./cjs", kind: "imports" },
      { spec: "./dyn", kind: "imports" },
    ]);

    expect(parseTsJsImportEntries(code, true).map((e) => e.spec)).toEqual([
      "./a",
      "./types",
      "./side",
      "external-pkg",
      "./re",
      "./star",
      "./type-star",
      "./cjs",
      "./dyn",
    ]);
  });

  it("prevents false positives from comments, strings, regex literals, and property/identifier calls", () => {
    const code = [
      '// import { fake1 } from "./fake1";',
      '/* export * from "./fake2";',
      '   require("./fake3"); */',
      "const s1 = \"import { fake4 } from './fake4'\";",
      "const r1 = /\\/\\*/;",
      'const r2 = /a"b/;',
      'const r3 = /import(".\\/fake5")/;',
      "const div = 10 / 2 / 5;",
      'const x = obj.require("./fake6");',
      'const y = obj?.require("./fake7");',
      'const z = myimport("./fake8");',
      'const w = $import("./fake9");',
      'const u = foo_require("./fake10");',
      'import { real } from "./real";',
      'const r = require("./real-cjs");',
      'const d = import("./real-dyn");',
      "/* unclosed comment at EOF",
      'import { fake11 } from "./fake11";',
    ].join("\n");

    expect(parseImports(code, ".ts")).toEqual(["./real", "./real-cjs", "./real-dyn"]);
  });

  it("does not misread JSX closing tags as regex literals", () => {
    const tsx = [
      'import { Card } from "./Card";',
      "export function View() {",
      "  return <div>hello</div><span>world</span>;",
      "}",
      'const lazy = import("./Lazy");',
    ].join("\n");

    expect(parseImports(tsx, ".tsx")).toEqual(["./Card", "./Lazy"]);
  });

  it("masks comments after division following regex literals or type arguments, while keeping arrow regex literals", () => {
    const singleLine = [
      'const x = /a/ / 2; /* import { fake } from "./fake"; */',
      'Foo<Bar> / 2; /* import { fake2 } from "./fake2"; */',
      'const fn = () => /a"b/; /* import { fake3 } from "./fake3"; */',
      'import { real } from "./real";',
    ].join("\n");

    const multiLine = [
      "const x = /a/",
      "  / 2; /*",
      '  import { fake } from "./fake";',
      "*/",
      'import { realMulti } from "./real-multi";',
    ].join("\n");

    expect(parseImports(singleLine, ".ts")).toEqual(["./real"]);
    expect(parseImports(multiLine, ".ts")).toEqual(["./real-multi"]);
  });
});

describe("parseImports across languages", () => {
  it("parses Python relative, package, and multiline imports", () => {
    const py = [
      "from . import init_mod",
      "from .sibling import helper",
      "from ..shared.utils import (",
      "    fmt,",
      "    parse,",
      ")",
      "import json, pkg.core as core",
    ].join("\n");

    expect(parseImports(py, ".py")).toEqual([
      ".",
      "./sibling",
      "../shared/utils",
      "json",
      "pkg.core",
    ]);
  });

  it("parses Go single and grouped imports while stripping comments", () => {
    const go = [
      "package main",
      'import "fmt"',
      'import alias "example.com/app/pkg" // inline',
      "import (",
      '  _ "net/http/pprof"',
      "  /* c */ . `example.com/app/raw`",
      ")",
      '// import "example.com/app/commented"',
    ].join("\n");

    expect(parseImports(go, ".go")).toEqual([
      "net/http/pprof",
      "example.com/app/raw",
      "fmt",
      "example.com/app/pkg",
    ]);
  });

  it("parses Rust mod and use crate/super/self trees while ignoring external crates, strings, and comments", () => {
    const rs = [
      "mod local;",
      "pub(crate) mod routes;",
      "use crate::config::Settings;",
      "use super::models::{self, User, Role as UserRole};",
      "use self::sub::*;",
      "use std::collections::HashMap;",
      "// use crate::commented;",
      'const S: &str = "use crate::in_string;";',
    ].join("\n");

    expect(parseImports(rs, ".rs")).toEqual([
      "mod::local",
      "mod::routes",
      "crate::config::Settings",
      "super::models",
      "super::models::User",
      "super::models::Role",
      "self::sub",
    ]);
  });

  it("parses PHP single, aliased, comma, and grouped use statements", () => {
    const php = [
      "<?php",
      "use App\\Models\\User, App\\Models\\Post as Article;",
      "use App\\Services\\{Billing, Mailer as AppMailer};",
      "use function App\\Helpers\\money;",
      "use const App\\Config\\TAX;",
      "$cb = function () use ($ctx) { return $ctx; };",
    ].join("\n");

    expect(parseImports(php, ".php")).toEqual([
      "App\\Services\\Billing",
      "App\\Services\\Mailer",
      "App\\Models\\User",
      "App\\Models\\Post",
    ]);
  });
});

describe("parseSymbols", () => {
  it("extracts TS/JS declarations and ignores JSDoc, block comments, unclosed comments, and local declarations", () => {
    const ts = [
      "/**",
      " * Example:",
      " * export function fakeDocFn() {}",
      " * export const fakeDocVar = 1;",
      " */",
      "/* export class FakeInlineClass {} */",
      "export async function runJob() {",
      "  const localHelper = () => 1;",
      "  function innerFn() {}",
      "}",
      "export default class MainWorker {}",
      "export interface JobConfig { id: string; }",
      "export type JobId<T> = string & T;",
      "export const enum JobFlag { None = 0 }",
      "export const buildRunner = (x: number) => x;",
      "/* inline note */ export function afterComment() {}",
      "const re = /\\/\\*/;",
      'const re2 = /a"b/;',
      "export function afterRegex() {}",
      "/* unclosed comment",
      "export function fakeTail() {}",
    ].join("\n");

    expect(parseSymbols(ts, ".ts")).toEqual([
      { name: "runJob", kind: "function", line: 7 },
      { name: "MainWorker", kind: "class", line: 11 },
      { name: "JobConfig", kind: "interface", line: 12 },
      { name: "JobId", kind: "type", line: 13 },
      { name: "JobFlag", kind: "enum", line: 14 },
      { name: "buildRunner", kind: "variable", line: 15 },
      { name: "afterComment", kind: "function", line: 16 },
      { name: "re", kind: "variable", line: 17 },
      { name: "re2", kind: "variable", line: 18 },
      { name: "afterRegex", kind: "function", line: 19 },
    ]);
  });

  it("extracts SFC script symbols including indented exports while keeping line offsets accurate", () => {
    const vue = [
      "<template><div /></template>",
      '<script setup lang="ts">',
      "  /* export function fakeSfcComment() {} */",
      "  export interface Props { ok: boolean; }",
      "  export function handleAction() {",
      "    const localOnly = 1;",
      "    return localOnly;",
      "  }",
      "const topLevelInScript = 42;",
      "</script>",
    ].join("\n");

    expect(parseSymbols(vue, ".vue")).toEqual([
      { name: "Props", kind: "interface", line: 4 },
      { name: "handleAction", kind: "function", line: 5 },
      { name: "topLevelInScript", kind: "variable", line: 9 },
    ]);
  });

  it("extracts Python, Go, Rust, PHP, Java, and Kotlin symbols", () => {
    expect(
      parseSymbols("class Worker:\n  pass\nasync def run_task(x):\n  return x\n", ".py"),
    ).toEqual([
      { name: "Worker", kind: "class", line: 1 },
      { name: "run_task", kind: "function", line: 3 },
    ]);

    expect(parseSymbols("type Repo struct{}\nfunc (r *Repo) Save() {}\n", ".go")).toEqual([
      { name: "Repo", kind: "type", line: 1 },
      { name: "Save", kind: "function", line: 2 },
    ]);

    expect(
      parseSymbols(
        "pub struct App;\npub enum Mode { Fast }\npub trait Step {\n  fn run(&self);\n}\npub async fn boot() {}\n",
        ".rs",
      ),
    ).toEqual([
      { name: "App", kind: "struct", line: 1 },
      { name: "Mode", kind: "enum", line: 2 },
      { name: "Step", kind: "trait", line: 3 },
      { name: "run", kind: "function", line: 4 },
      { name: "boot", kind: "function", line: 6 },
    ]);

    expect(
      parseSymbols(
        [
          "<?php",
          "namespace App\\Core;",
          "final class Kernel {",
          "  public function boot(): void {}",
          "}",
        ].join("\n"),
        ".php",
      ),
    ).toEqual([
      { name: "App\\Core", kind: "namespace", line: 2 },
      { name: "Kernel", kind: "class", line: 3 },
      { name: "boot", kind: "function", line: 4 },
    ]);

    expect(
      parseSymbols(
        [
          "public interface Store {}",
          "public record Key(String v) {}",
          "public class Svc {",
          "  public void exec() { if (true) {} }",
          "}",
        ].join("\n"),
        ".java",
      ),
    ).toEqual([
      { name: "Store", kind: "interface", line: 1 },
      { name: "Key", kind: "class", line: 2 },
      { name: "Svc", kind: "class", line: 3 },
      { name: "exec", kind: "function", line: 4 },
    ]);

    expect(
      parseSymbols(
        [
          "enum class Status { OK }",
          "data class Item(val id: Int)",
          "object Registry {",
          "  suspend fun sync() {}",
          "}",
        ].join("\n"),
        ".kt",
      ),
    ).toEqual([
      { name: "Status", kind: "enum", line: 1 },
      { name: "Item", kind: "class", line: 2 },
      { name: "Registry", kind: "class", line: 3 },
      { name: "sync", kind: "function", line: 4 },
    ]);
  });

  it("caps extracted symbols at MAX_INDEXED_FILE_SYMBOLS", () => {
    const manyTs = Array.from(
      { length: MAX_INDEXED_FILE_SYMBOLS + 25 },
      (_, idx) => `export const sym${idx} = ${idx};`,
    ).join("\n");
    const tsSymbols = parseSymbols(manyTs, ".ts");
    expect(tsSymbols).toHaveLength(MAX_INDEXED_FILE_SYMBOLS);
    expect(tsSymbols[0]?.name).toBe("sym0");
    expect(tsSymbols[MAX_INDEXED_FILE_SYMBOLS - 1]?.name).toBe(
      `sym${MAX_INDEXED_FILE_SYMBOLS - 1}`,
    );

    const manyPy = Array.from(
      { length: MAX_INDEXED_FILE_SYMBOLS + 10 },
      (_, idx) => `def fn_${idx}():\n  pass`,
    ).join("\n");
    expect(parseSymbols(manyPy, ".py")).toHaveLength(MAX_INDEXED_FILE_SYMBOLS);
  });
});
