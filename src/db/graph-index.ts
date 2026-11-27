import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  type Dirent,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type ClaimGraphFile,
  GraphNeighborsInput,
  type GraphNeighborsOutput,
  MAX_CLAIM_SYMBOL_LOCATIONS,
} from "@catenext/shared";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { collectRootTargets } from "../workspace-roots.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SKIP_DIRS,
  isSafeRegularFileSync,
  isWithinRoot,
  readBoundedUtf8File,
  walkWorkspaceFiles,
} from "../workspace-walk.js";
import { checkpointWalAndClose, openDatabaseAt } from "./open.js";

export const GRAPH_PARSER_VERSION = 2;
const MAX_INDEXED_FILE_SYMBOLS = 80;

function graphParserVersionKey(projectId: string): string {
  // The legacy DB-wide marker cannot prove freshness for any one project.
  return `graph_parser_version:${projectId}`;
}

function isGraphParserCurrent(db: DatabaseSync, projectId: string): boolean {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(graphParserVersionKey(projectId));
  const version = Number(row?.value);
  return Number.isFinite(version) && version >= GRAPH_PARSER_VERSION;
}

const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".php",
  ".vue",
  ".svelte",
]);

const TS_JS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SFC_EXT = new Set([".vue", ".svelte"]);

const TS_JS_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [
    /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_][\w$]*)/,
    "function",
  ],
  [
    /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w$]*)/,
    "class",
  ],
  [/^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_][\w$]*)/, "interface"],
  [/^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_][\w$]*)/, "enum"],
  [/^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_][\w$]*)\b(?:\s*<.*>)?\s*=/, "type"],
  [
    /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_][\w$]*)\s*(?::[^=]+)?=/,
    "variable",
  ],
];

const PYTHON_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [/^(?:async\s+)?def\s+([A-Za-z_][\w$]*)\s*\(/, "function"],
  [/^class\s+([A-Za-z_][\w$]*)\s*[:(]/, "class"],
];

const GO_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]+\])?\s*\(/, "function"],
  [/^type\s+([A-Za-z_]\w*)\b/, "type"],
];

const RUST_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [
    /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern(?:\s+"[^"]+")?)\s+)*fn\s+([A-Za-z_]\w*)/,
    "function",
  ],
  [/^(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, "struct"],
  [/^(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, "enum"],
  [/^(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, "trait"],
];

const PHP_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*namespace\s+([A-Za-z_][A-Za-z0-9_\\]*)\s*[;{]/, "namespace"],
  [/^\s*(?:(?:abstract|final|readonly)\s+)*class\s+([A-Za-z_]\w*)/, "class"],
  [/^\s*interface\s+([A-Za-z_]\w*)/, "interface"],
  [/^\s*trait\s+([A-Za-z_]\w*)/, "trait"],
  [/^\s*enum\s+([A-Za-z_]\w*)/, "enum"],
  [
    /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/,
    "function",
  ],
];

const JAVA_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [
    /^\s*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(?:class|record)\s+([A-Za-z_]\w*)/,
    "class",
  ],
  [
    /^\s*(?:(?:public|protected|private|abstract|static|sealed|non-sealed)\s+)*@?interface\s+([A-Za-z_]\w*)/,
    "interface",
  ],
  [/^\s*(?:(?:public|protected|private|static)\s+)*enum\s+([A-Za-z_]\w*)/, "enum"],
  [
    /^\s*(?:@[A-Za-z_]\w*(?:\([^)]*\))?\s+)*(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)*(?:<[^>{};]+>\s+)?(?:[^=;{}()]+\s+)?([A-Za-z_]\w*)\s*\(/,
    "function",
  ],
  [
    /^\s*(?!(?:return|throw|new|if|else|for|while|switch|catch|try|do|case|assert|package|import|super|this)\b)(?:<[^>{};]+>\s+)?[A-Za-z_][\w$.<>[\],\s?]*\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:throws\s+[A-Za-z0-9_.,\s]+)?(?:\{.*|;)\s*$/,
    "function",
  ],
];

const KOTLIN_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+class\s+([A-Za-z_]\w*)/, "enum"],
  [
    /^\s*(?:(?:public|private|protected|internal|sealed|fun)\s+)*interface\s+([A-Za-z_]\w*)/,
    "interface",
  ],
  [
    /^\s*(?:(?:public|private|protected|internal|open|abstract|final|sealed|data|inner|value|annotation|expect|actual)\s+)*class\s+([A-Za-z_]\w*)/,
    "class",
  ],
  [/^\s*(?:(?:public|private|protected|internal|companion)\s+)*object\s+([A-Za-z_]\w*)/, "class"],
  [
    /^\s*(?:(?:public|private|protected|internal|override|open|final|abstract|suspend|inline|infix|operator|tailrec|external|expect|actual)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[A-Za-z_][\w.<>?,\s]*\.)?([A-Za-z_]\w*)\s*(?:<[^>]+>)?\s*\(/,
    "function",
  ],
];

const ALL_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  ...TS_JS_SYMBOL_PATTERNS,
  ...PYTHON_SYMBOL_PATTERNS,
  ...RUST_SYMBOL_PATTERNS,
  ...GO_SYMBOL_PATTERNS,
  ...PHP_SYMBOL_PATTERNS,
  ...KOTLIN_SYMBOL_PATTERNS,
  ...JAVA_SYMBOL_PATTERNS,
];

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeRealpathSync(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

function withDatabase<T>(dbOrPath: DatabaseSync | string, fn: (db: DatabaseSync) => T): T {
  if (typeof dbOrPath !== "string") return fn(dbOrPath);
  const db = openDatabaseAt(dbOrPath);
  try {
    return fn(db);
  } finally {
    checkpointWalAndClose(db);
  }
}

async function withDatabaseAsync<T>(
  dbOrPath: DatabaseSync | string,
  fn: (db: DatabaseSync) => Promise<T>,
): Promise<T> {
  if (typeof dbOrPath !== "string") return fn(dbOrPath);
  const db = openDatabaseAt(dbOrPath);
  try {
    return await fn(db);
  } finally {
    checkpointWalAndClose(db);
  }
}

function findTagClose(content: string, startIdx: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

function isAllowedScriptType(attrs: string): boolean {
  const typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  const rawType = typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3];
  if (!rawType) return true;
  const mime = rawType.trim().toLowerCase();
  if (!mime) return true;
  return (
    mime === "module" ||
    mime === "text/javascript" ||
    mime === "application/javascript" ||
    mime === "text/typescript" ||
    mime === "application/typescript"
  );
}

function extractSfcScriptBlocks(content: string): Array<{ code: string; startLine: number }> {
  const blocks: Array<{ code: string; startLine: number }> = [];
  const lower = content.toLowerCase();
  const openToken = "<script";
  const closeToken = "</script";
  let pos = 0;

  while (pos < content.length) {
    const openIdx = lower.indexOf(openToken, pos);
    if (openIdx === -1) break;

    const afterOpenIdx = openIdx + openToken.length;
    if (afterOpenIdx >= content.length) break;

    const afterOpenCh = content[afterOpenIdx] ?? "";
    if (afterOpenCh !== ">" && afterOpenCh !== "/" && !/\s/.test(afterOpenCh)) {
      pos = afterOpenIdx;
      continue;
    }

    const openCloseIdx = findTagClose(content, afterOpenIdx);
    if (openCloseIdx === -1) break;

    if (content[openCloseIdx - 1] === "/") {
      pos = openCloseIdx + 1;
      continue;
    }

    const attrs = content.slice(afterOpenIdx, openCloseIdx);
    const codeStart = openCloseIdx + 1;

    let scanPos = codeStart;
    let closeStart = -1;
    let closeEnd = -1;
    while (scanPos < content.length) {
      const closeIdx = lower.indexOf(closeToken, scanPos);
      if (closeIdx === -1) break;

      const afterCloseIdx = closeIdx + closeToken.length;
      if (afterCloseIdx >= content.length) break;

      const afterCloseCh = content[afterCloseIdx] ?? "";
      if (afterCloseCh !== ">" && !/\s/.test(afterCloseCh)) {
        scanPos = afterCloseIdx;
        continue;
      }

      const tagEnd = findTagClose(content, afterCloseIdx);
      if (tagEnd === -1) break;

      closeStart = closeIdx;
      closeEnd = tagEnd;
      break;
    }

    if (closeStart === -1 || closeEnd === -1) break;

    if (isAllowedScriptType(attrs)) {
      const startLine = content.slice(0, codeStart).split(/\r?\n/).length;
      blocks.push({ code: content.slice(codeStart, closeStart), startLine });
    }

    pos = closeEnd + 1;
  }

  return blocks;
}

type TsJsImportEntry = {
  spec: string;
  kind: "imports" | "reexport";
};

function maskTsJsComments(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i] ?? "";
    const next = content[i + 1] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < content.length) {
        const sc = content[i] ?? "";
        out += sc;
        i++;
        if (sc === "\\") {
          if (i < content.length) {
            out += content[i] ?? "";
            i++;
          }
          continue;
        }
        if (sc === quote) break;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      out += "  ";
      i += 2;
      while (i < content.length && content[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const closeIdx = content.indexOf("*/", i + 2);
      if (closeIdx !== -1) {
        for (let j = i; j < closeIdx + 2; j++) {
          out += content[j] === "\n" ? "\n" : " ";
        }
        i = closeIdx + 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function parseTsJsImportEntries(content: string, includeNonRelative = false): TsJsImportEntry[] {
  const cleaned = maskTsJsComments(content);
  const bySpec = new Map<string, "imports" | "reexport">();
  const add = (spec: string | undefined, kind: "imports" | "reexport") => {
    if (!spec) return;
    if (!includeNonRelative && !spec.startsWith(".")) return;
    const prev = bySpec.get(spec);
    if (!prev || (prev === "reexport" && kind === "imports")) {
      bySpec.set(spec, kind);
    }
  };

  const stmtRe =
    /(?:^|[;\n{}])\s*(?:(import)\s+(?:[^'";]+?\s+from\s*)?["']([^"']+)["']|(export)(?:\s+|\s*(?=[{*]))[^'";]+?\bfrom\s*["']([^"']+)["'])/g;
  for (const match of cleaned.matchAll(stmtRe)) {
    if (match[1]) {
      add(match[2], "imports");
    } else if (match[3]) {
      add(match[4], "reexport");
    }
  }

  const callRe = /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of cleaned.matchAll(callRe)) {
    add(match[1], "imports");
  }

  return [...bySpec.entries()].map(([spec, kind]) => ({ spec, kind }));
}

function parseTsJsImports(content: string, includeNonRelative = false): string[] {
  return parseTsJsImportEntries(content, includeNonRelative).map((entry) => entry.spec);
}

function parsePhpImports(content: string): string[] {
  const hits: string[] = [];
  const groupRe =
    /^\s*use\s+(?!(?:function|const)\b)([\\A-Za-z_][\\A-Za-z0-9_]*\\)\s*\{([^}]+)\}\s*;/gm;
  for (const match of content.matchAll(groupRe)) {
    const prefix = (match[1] ?? "").replace(/^\\+/, "");
    const body = match[2] ?? "";
    for (const rawItem of body.split(",")) {
      const trimmed = rawItem.trim();
      if (!trimmed || /^(?:function|const)\s+/i.test(trimmed)) continue;
      const fqn = trimmed
        .replace(/\s+as\s+[A-Za-z_]\w*$/i, "")
        .replace(/^\\+/, "")
        .trim();
      if (fqn) hits.push(`${prefix}${fqn}`);
    }
  }

  const singleRe =
    /^\s*use\s+(?!(?:function|const)\b)([\\A-Za-z_][\\A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_]\w*)?(?:\s*,\s*[\\A-Za-z_][\\A-Za-z0-9_]*(?:\s+as\s+[A-Za-z_]\w*)?)*)\s*;/gm;
  for (const match of content.matchAll(singleRe)) {
    const clause = match[1] ?? "";
    for (const rawItem of clause.split(",")) {
      const fqn = rawItem
        .trim()
        .replace(/\s+as\s+[A-Za-z_]\w*$/i, "")
        .replace(/^\\+/, "")
        .trim();
      if (fqn) hits.push(fqn);
    }
  }
  return [...new Set(hits)];
}

const MAX_GO_PACKAGE_FILES = 32;

function stripGoComments(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i] ?? "";
    const next = content[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        if (content[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      out += " ";
      continue;
    }
    if (ch === '"') {
      out += ch;
      i++;
      while (i < content.length) {
        const sc = content[i] ?? "";
        out += sc;
        i++;
        if (sc === "\\") {
          if (i < content.length) {
            out += content[i] ?? "";
            i++;
          }
          continue;
        }
        if (sc === '"') break;
      }
      continue;
    }
    if (ch === "`") {
      out += ch;
      i++;
      while (i < content.length) {
        const rc = content[i] ?? "";
        out += rc;
        i++;
        if (rc === "`") break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function parseGoImports(content: string): string[] {
  const cleaned = stripGoComments(content);
  const hits: string[] = [];

  const groupRe = /^\s*import\s*\(([\s\S]*?)\)/gm;
  for (const match of cleaned.matchAll(groupRe)) {
    const body = match[1] ?? "";
    for (const strMatch of body.matchAll(/"([^"\n]+)"|`([^`\n]+)`/g)) {
      const spec = (strMatch[1] ?? strMatch[2] ?? "").trim();
      if (spec) hits.push(spec);
    }
  }

  const singleRe = /^\s*import\s+(?:(?:[A-Za-z_]\w*|\.|_)\s+)?(?:"([^"\n]+)"|`([^`\n]+)`)/gm;
  for (const match of cleaned.matchAll(singleRe)) {
    const spec = (match[1] ?? match[2] ?? "").trim();
    if (spec) hits.push(spec);
  }

  return [...new Set(hits)];
}

function sanitizeRustCode(content: string): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const ch = content[i] ?? "";
    const next = content[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < content.length && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < content.length && depth > 0) {
        if (content[i] === "/" && content[i + 1] === "*") {
          depth++;
          i += 2;
          continue;
        }
        if (content[i] === "*" && content[i + 1] === "/") {
          depth--;
          i += 2;
          continue;
        }
        if (content[i] === "\n") out += "\n";
        i++;
      }
      out += " ";
      continue;
    }
    if (ch === "r" && (next === '"' || next === "#")) {
      let hashes = 0;
      let j = i + 1;
      while (j < content.length && content[j] === "#") {
        hashes++;
        j++;
      }
      if (content[j] === '"') {
        j++;
        while (j < content.length) {
          if (content[j] === '"') {
            let matchHashes = 0;
            while (matchHashes < hashes && content[j + 1 + matchHashes] === "#") {
              matchHashes++;
            }
            if (matchHashes === hashes) {
              j += 1 + hashes;
              break;
            }
          }
          if (content[j] === "\n") out += "\n";
          j++;
        }
        out += " ";
        i = j;
        continue;
      }
    }
    if (ch === '"') {
      i++;
      while (i < content.length) {
        const sc = content[i] ?? "";
        i++;
        if (sc === "\\") {
          i++;
          continue;
        }
        if (sc === "\n") out += "\n";
        if (sc === '"') break;
      }
      out += " ";
      continue;
    }
    if (ch === "'") {
      if (next === "\\") {
        let j = i + 2;
        while (j < content.length && content[j] !== "'" && content[j] !== "\n") {
          if (j - i > 8) break;
          j++;
        }
        if (content[j] === "'") {
          out += " ";
          i = j + 1;
          continue;
        }
      } else if (next && next !== "'" && content[i + 2] === "'") {
        out += " ";
        i += 3;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function expandRustUseTree(prefix: string, tree: string, out: string[]): void {
  const cleaned = tree.trim();
  if (!cleaned) return;
  const braceStart = cleaned.indexOf("{");
  if (braceStart === -1) {
    let leaf = cleaned.replace(/\s+as\s+[A-Za-z_]\w*$/g, "").trim();
    if (leaf === "*") {
      if (prefix) out.push(prefix);
      return;
    }
    if (leaf.endsWith("::*")) {
      leaf = leaf.slice(0, -3).trim();
    }
    if (!leaf || leaf === "self") {
      if (prefix) out.push(prefix);
      return;
    }
    const full = prefix ? `${prefix}::${leaf}` : leaf;
    out.push(full.replace(/^::+|::+$/g, ""));
    return;
  }

  const head = cleaned
    .slice(0, braceStart)
    .replace(/::\s*$/, "")
    .trim();
  const nextPrefix = head ? (prefix ? `${prefix}::${head}` : head) : prefix;

  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  if (braceEnd === -1) return;

  const inner = cleaned.slice(braceStart + 1, braceEnd);
  const items: string[] = [];
  let itemStart = 0;
  let innerDepth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{") innerDepth++;
    else if (ch === "}") innerDepth--;
    else if (ch === "," && innerDepth === 0) {
      items.push(inner.slice(itemStart, i));
      itemStart = i + 1;
    }
  }
  items.push(inner.slice(itemStart));

  for (const item of items) {
    expandRustUseTree(nextPrefix, item, out);
  }
}

function parseRustImports(content: string): string[] {
  const cleaned = sanitizeRustCode(content);
  const hits: string[] = [];

  const modRe = /(?:^|[;{}])\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;
  for (const match of cleaned.matchAll(modRe)) {
    const name = match[1];
    if (name) hits.push(`mod::${name}`);
  }

  const useRe = /(?:^|[;{}])\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/gm;
  for (const match of cleaned.matchAll(useRe)) {
    const tree = match[1] ?? "";
    const expanded: string[] = [];
    expandRustUseTree("", tree, expanded);
    for (const item of expanded) {
      const normalized = item.replace(/\s+/g, "").replace(/^::+/, "");
      if (
        normalized.startsWith("crate::") ||
        normalized.startsWith("super::") ||
        normalized.startsWith("self::")
      ) {
        hits.push(normalized);
      }
    }
  }

  return [...new Set(hits)];
}

function parsePythonImports(content: string): string[] {
  const hits: string[] = [];

  const relRe = /^\s*from\s+(\.+)([A-Za-z_][A-Za-z0-9_.]*)?\s+import\b/gm;
  for (const match of content.matchAll(relRe)) {
    const dots = match[1] ?? ".";
    const mod = match[2] ?? "";
    const prefix = dots.length === 1 ? "./" : "../".repeat(dots.length - 1);
    if (mod) {
      hits.push(`${prefix}${mod.replaceAll(".", "/")}`);
    } else {
      hits.push(dots.length === 1 ? "." : prefix.slice(0, -1));
    }
  }

  const fromRe = /^\s*from\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s+import\b/gm;
  for (const match of content.matchAll(fromRe)) {
    const mod = match[1];
    if (mod) hits.push(mod);
  }

  const importRe = /^\s*import\s+([^\n#;]+)/gm;
  for (const match of content.matchAll(importRe)) {
    const clause = match[1] ?? "";
    for (const rawItem of clause.split(",")) {
      const mod = rawItem
        .trim()
        .replace(/\s+as\s+[A-Za-z_]\w*$/, "")
        .trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(mod)) {
        hits.push(mod);
      }
    }
  }

  return [...new Set(hits)];
}

export function parseImports(
  content: string,
  ext?: string,
  options?: { includeNonRelative?: boolean },
): string[] {
  const includeNonRelative = options?.includeNonRelative ?? false;
  const normalizedExt = ext?.toLowerCase();
  if (normalizedExt && SFC_EXT.has(normalizedExt)) {
    const hits: string[] = [];
    for (const block of extractSfcScriptBlocks(content)) {
      hits.push(...parseTsJsImports(block.code, includeNonRelative));
    }
    return [...new Set(hits)];
  }
  if (normalizedExt === ".php") {
    return parsePhpImports(content);
  }
  if (normalizedExt === ".py") {
    return parsePythonImports(content);
  }
  if (normalizedExt === ".go") {
    return parseGoImports(content);
  }
  if (normalizedExt === ".rs") {
    return parseRustImports(content);
  }
  return parseTsJsImports(content, includeNonRelative);
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  const bound = Math.min(offset, text.length);
  for (let i = 0; i < bound; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function parseTsJsReexportSymbols(
  content: string,
  lineOffset = 0,
): Array<{ name: string; kind: string; line: number }> {
  const cleaned = maskTsJsComments(content);
  const results: Array<{ name: string; kind: string; line: number }> = [];

  const nsRe =
    /(?:^|[;\n{}])\s*export\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["'][^"']+["']/g;
  for (const match of cleaned.matchAll(nsRe)) {
    const name = match[1];
    if (!name) continue;
    const exportIdx = match[0].indexOf("export");
    const offset = (match.index ?? 0) + Math.max(0, exportIdx);
    results.push({ name, kind: "reexport", line: lineOffset + lineAtOffset(cleaned, offset) });
  }

  const starRe = /(?:^|[;\n{}])\s*export\s+(?:type\s+)?\*\s+from\s*["']([^"']+)["']/g;
  for (const match of cleaned.matchAll(starRe)) {
    const spec = match[1]?.trim();
    const exportIdx = match[0].indexOf("export");
    const offset = (match.index ?? 0) + Math.max(0, exportIdx);
    results.push({
      name: spec ? `* (${spec})` : "*",
      kind: "reexport",
      line: lineOffset + lineAtOffset(cleaned, offset),
    });
  }

  const namedRe = /(?:^|[;\n{}])\s*export(?:\s+type)?\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  for (const match of cleaned.matchAll(namedRe)) {
    const body = match[1] ?? "";
    const braceRelIdx = match[0].indexOf("{");
    const bodyStartOffset = (match.index ?? 0) + braceRelIdx + 1;
    let cursor = 0;
    for (const part of body.split(",")) {
      const partOffset = bodyStartOffset + cursor;
      cursor += part.length + 1;
      const trimmed = part.trim();
      if (!trimmed) continue;
      const withoutType = trimmed.replace(/^type\s+/, "").trim();
      if (!withoutType) continue;
      const asMatch = withoutType.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      const exportedName =
        asMatch?.[2] ?? (/^[A-Za-z_$][\w$]*$/.test(withoutType) ? withoutType : null);
      if (!exportedName) continue;
      const leadingWs = part.length - part.trimStart().length;
      results.push({
        name: exportedName,
        kind: "reexport",
        line: lineOffset + lineAtOffset(cleaned, partOffset + leadingWs),
      });
    }
  }

  const seen = new Set<string>();
  const deduped: Array<{ name: string; kind: string; line: number }> = [];
  for (const sym of results.sort((a, b) => a.line - b.line)) {
    const key = `${sym.kind}\0${sym.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sym);
  }
  return deduped;
}

function parseTsJsSymbolsForBlock(
  content: string,
  lineOffset = 0,
): Array<{ name: string; kind: string; line: number }> {
  const symbols: Array<{ name: string; kind: string; line: number }> = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const [re, kind] of TS_JS_SYMBOL_PATTERNS) {
      const match = line.match(re);
      if (match?.[1]) {
        symbols.push({ name: match[1], kind, line: lineOffset + i + 1 });
        break;
      }
    }
  }
  symbols.push(...parseTsJsReexportSymbols(content, lineOffset));
  const seen = new Set<string>();
  const deduped: Array<{ name: string; kind: string; line: number }> = [];
  for (const sym of symbols.sort((a, b) => a.line - b.line)) {
    const key = `${sym.line}\0${sym.kind}\0${sym.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sym);
  }
  return deduped;
}

function patternsForExt(ext?: string): Array<[RegExp, string]> {
  const normalizedExt = ext?.toLowerCase();
  if (!normalizedExt) return ALL_SYMBOL_PATTERNS;
  if (TS_JS_EXT.has(normalizedExt) || SFC_EXT.has(normalizedExt)) return TS_JS_SYMBOL_PATTERNS;
  if (normalizedExt === ".py") return PYTHON_SYMBOL_PATTERNS;
  if (normalizedExt === ".go") return GO_SYMBOL_PATTERNS;
  if (normalizedExt === ".rs") return RUST_SYMBOL_PATTERNS;
  if (normalizedExt === ".php") return PHP_SYMBOL_PATTERNS;
  if (normalizedExt === ".java") return JAVA_SYMBOL_PATTERNS;
  if (normalizedExt === ".kt") return KOTLIN_SYMBOL_PATTERNS;
  return ALL_SYMBOL_PATTERNS;
}

export function parseSymbols(
  content: string,
  ext?: string,
): Array<{ name: string; kind: string; line: number }> {
  const normalizedExt = ext?.toLowerCase();
  if (normalizedExt && SFC_EXT.has(normalizedExt)) {
    const symbols: Array<{ name: string; kind: string; line: number }> = [];
    for (const block of extractSfcScriptBlocks(content)) {
      symbols.push(...parseTsJsSymbolsForBlock(block.code, block.startLine - 1));
      if (symbols.length >= MAX_INDEXED_FILE_SYMBOLS) break;
    }
    return symbols.slice(0, MAX_INDEXED_FILE_SYMBOLS);
  }

  if (normalizedExt && TS_JS_EXT.has(normalizedExt)) {
    return parseTsJsSymbolsForBlock(content, 0).slice(0, MAX_INDEXED_FILE_SYMBOLS);
  }

  const symbols: Array<{ name: string; kind: string; line: number }> = [];
  const lines = content.split(/\r?\n/);
  const patterns = patternsForExt(normalizedExt);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const [re, kind] of patterns) {
      const match = line.match(re);
      if (match?.[1]) {
        symbols.push({ name: match[1], kind, line: i + 1 });
        break;
      }
    }
  }
  if (!normalizedExt) {
    symbols.push(...parseTsJsReexportSymbols(content, 0));
    symbols.sort((a, b) => a.line - b.line);
  }
  return symbols.slice(0, MAX_INDEXED_FILE_SYMBOLS);
}

function importCandidates(base: string, spec: string, fromExt?: string): string[] {
  if (fromExt === ".py") {
    return [`${base}.py`, join(base, "__init__.py")];
  }
  const candidates = [base];
  if (spec.endsWith(".js")) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  } else if (spec.endsWith(".jsx")) {
    const stem = base.slice(0, -4);
    candidates.push(`${stem}.tsx`, `${stem}.ts`);
  } else if (spec.endsWith(".mjs")) {
    candidates.push(`${base.slice(0, -4)}.mts`);
  } else if (spec.endsWith(".cjs")) {
    candidates.push(`${base.slice(0, -4)}.cts`);
  }
  candidates.push(
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.vue`,
    `${base}.svelte`,
    `${base}.py`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    join(base, "index.mts"),
    join(base, "index.cts"),
    join(base, "index.js"),
    join(base, "index.jsx"),
    join(base, "index.mjs"),
    join(base, "index.cjs"),
    join(base, "__init__.py"),
  );
  return candidates;
}

function toRelInsideRoot(absRoot: string, candidate: string): string | null {
  const rel = relative(absRoot, candidate).replaceAll("\\", "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

export type ComposerPsr4Entry = {
  prefix: string;
  dirs: string[];
};

function parsePsr4Section(section: unknown, merged: Map<string, string[]>): void {
  if (!section || typeof section !== "object" || Array.isArray(section)) return;
  for (const [rawPrefix, rawDirs] of Object.entries(section)) {
    const trimmed = rawPrefix.replace(/^\\+/, "");
    const prefix = trimmed && !trimmed.endsWith("\\") ? `${trimmed}\\` : trimmed;
    const dirList = Array.isArray(rawDirs)
      ? rawDirs.filter((d): d is string => typeof d === "string")
      : typeof rawDirs === "string"
        ? [rawDirs]
        : [];
    if (dirList.length === 0) continue;
    const existing = merged.get(prefix) ?? [];
    for (const dir of dirList) {
      const cleanDir = dir.replaceAll("\\", "/").replace(/\/+$/, "");
      if (!existing.includes(cleanDir)) existing.push(cleanDir);
    }
    merged.set(prefix, existing);
  }
}

export function loadComposerPsr4(root: string): ComposerPsr4Entry[] {
  const absRoot = resolve(root);
  const realRoot = safeRealpathSync(absRoot);
  const composerPath = join(absRoot, "composer.json");
  if (!isSafeRegularFileSync(realRoot, composerPath)) return [];
  try {
    const stat = lstatSync(composerPath);
    if (stat.size > DEFAULT_MAX_FILE_BYTES) return [];
    const raw = readFileSync(composerPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > DEFAULT_MAX_FILE_BYTES) return [];
    const parsed = JSON.parse(raw) as {
      autoload?: { "psr-4"?: unknown };
      "autoload-dev"?: { "psr-4"?: unknown };
    };
    const merged = new Map<string, string[]>();
    parsePsr4Section(parsed.autoload?.["psr-4"], merged);
    parsePsr4Section(parsed["autoload-dev"]?.["psr-4"], merged);
    return [...merged.entries()]
      .map(([prefix, dirs]) => ({ prefix, dirs }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
  } catch {
    return [];
  }
}

function resolvePhpPsr4Import(
  spec: string,
  absRoot: string,
  realRoot: string,
  psr4Entries: readonly ComposerPsr4Entry[],
  knownFiles?: ReadonlySet<string>,
): string | null {
  const cleanSpec = spec.replace(/^\\+/, "");
  if (!cleanSpec || psr4Entries.length === 0) return null;
  for (const entry of psr4Entries) {
    if (entry.prefix && !cleanSpec.startsWith(entry.prefix)) continue;
    const remainder = cleanSpec.slice(entry.prefix.length);
    if (!remainder) continue;
    const relClass = `${remainder.replaceAll("\\", "/")}.php`;
    for (const dir of entry.dirs) {
      const candidate = dir ? resolve(absRoot, dir, relClass) : resolve(absRoot, relClass);
      const rel = toRelInsideRoot(absRoot, candidate);
      if (!rel) continue;
      const exists = knownFiles ? knownFiles.has(rel) : isSafeRegularFileSync(realRoot, candidate);
      if (exists) return rel;
    }
  }
  return null;
}

function fileExistsInScope(
  candidate: string,
  absRoot: string,
  realRoot: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  const rel = toRelInsideRoot(absRoot, candidate);
  if (!rel) return null;
  const exists = knownFiles ? knownFiles.has(rel) : isSafeRegularFileSync(realRoot, candidate);
  return exists ? rel : null;
}

export function loadGoModule(root: string): string | null {
  const absRoot = resolve(root);
  const realRoot = safeRealpathSync(absRoot);
  const goModPath = join(absRoot, "go.mod");
  if (!isSafeRegularFileSync(realRoot, goModPath)) return null;
  try {
    const stat = lstatSync(goModPath);
    if (stat.size > DEFAULT_MAX_FILE_BYTES) return null;
    const raw = readFileSync(goModPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > DEFAULT_MAX_FILE_BYTES) return null;
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      const match = line.match(/^module\s+(?:"([^"\s]+)"|`([^`\s]+)`|([^\s]+))/);
      if (!match) continue;
      const rawMod = match[1] ?? match[2] ?? match[3] ?? "";
      const mod = rawMod.replace(/\/\/.*$/, "").replace(/\/+$/, "");
      if (mod) return mod;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveGoImport(
  spec: string,
  absRoot: string,
  realRoot: string,
  goModule: string | null,
  knownFiles?: ReadonlySet<string>,
): string[] {
  if (!goModule) return [];
  if (spec !== goModule && !spec.startsWith(`${goModule}/`)) return [];
  const subDir = spec === goModule ? "" : spec.slice(goModule.length + 1);
  if (subDir.startsWith("/") || subDir.split("/").includes("..")) return [];

  if (knownFiles) {
    const prefix = subDir ? `${subDir}/` : "";
    const matches: string[] = [];
    for (const rel of knownFiles) {
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      if (!rest.endsWith(".go") || rest.endsWith("_test.go")) continue;
      matches.push(rel);
    }
    matches.sort();
    return matches.slice(0, MAX_GO_PACKAGE_FILES);
  }

  const targetDir = subDir ? resolve(absRoot, subDir) : absRoot;
  if (subDir && !toRelInsideRoot(absRoot, targetDir)) return [];
  let dirReal: string;
  try {
    const dirStat = lstatSync(targetDir);
    if (subDir && dirStat.isSymbolicLink()) return [];
    if (!dirStat.isDirectory()) return [];
    dirReal = realpathSync(targetDir);
  } catch {
    return [];
  }
  if (!isWithinRoot(realRoot, dirReal)) return [];

  let names: string[];
  try {
    names = readdirSync(targetDir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".go") || name.endsWith("_test.go")) continue;
    const candidate = join(targetDir, name);
    if (!isSafeRegularFileSync(realRoot, candidate)) continue;
    const rel = toRelInsideRoot(absRoot, candidate);
    if (rel) matches.push(rel);
  }
  matches.sort();
  return matches.slice(0, MAX_GO_PACKAGE_FILES);
}

function findRustCrateDirs(
  fromDir: string,
  absRoot: string,
  realRoot: string,
  knownFiles?: ReadonlySet<string>,
): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const pushDir = (dir: string) => {
    if (seen.has(dir)) return;
    if (dir !== absRoot && !toRelInsideRoot(absRoot, dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };

  let cur = fromDir;
  while (cur === absRoot || toRelInsideRoot(absRoot, cur) !== null) {
    if (isSafeRegularFileSync(realRoot, join(cur, "Cargo.toml"))) {
      pushDir(join(cur, "src"));
      pushDir(cur);
      return dirs;
    }
    if (
      basename(cur) === "src" &&
      (fileExistsInScope(join(cur, "lib.rs"), absRoot, realRoot, knownFiles) ||
        fileExistsInScope(join(cur, "main.rs"), absRoot, realRoot, knownFiles))
    ) {
      pushDir(cur);
      return dirs;
    }
    if (cur === absRoot) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  pushDir(join(absRoot, "src"));
  pushDir(absRoot);
  return dirs;
}

function resolveRustSegmentsInDir(
  baseDir: string,
  segments: readonly string[],
  absRoot: string,
  realRoot: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  if (segments.length === 0) return null;
  for (let len = segments.length; len >= 1; len--) {
    const sub = segments.slice(0, len);
    if (sub.some((s) => !s || s === "." || s === ".." || s.includes("/") || s.includes("\\"))) {
      continue;
    }
    const stemPath = resolve(baseDir, ...sub);
    const modRs = fileExistsInScope(`${stemPath}.rs`, absRoot, realRoot, knownFiles);
    if (modRs) return modRs;
    const dirModRs = fileExistsInScope(join(stemPath, "mod.rs"), absRoot, realRoot, knownFiles);
    if (dirModRs) return dirModRs;
  }
  return null;
}

function resolveRustImport(
  fromFile: string,
  spec: string,
  absRoot: string,
  realRoot: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  const absFrom = isAbsolute(fromFile) ? resolve(fromFile) : resolve(absRoot, fromFile);
  const fromRel = toRelInsideRoot(absRoot, absFrom);
  const fromDir = dirname(absFrom);
  const fromBase = basename(absFrom);
  const isDirModule = fromBase === "lib.rs" || fromBase === "main.rs" || fromBase === "mod.rs";
  const selfDir = isDirModule ? fromDir : join(fromDir, fromBase.replace(/\.rs$/i, ""));

  if (spec.startsWith("mod::")) {
    const modName = spec.slice("mod::".length);
    if (!/^[A-Za-z_]\w*$/.test(modName)) return null;
    const stemPath = join(selfDir, modName);
    const modRs = fileExistsInScope(`${stemPath}.rs`, absRoot, realRoot, knownFiles);
    if (modRs && modRs !== fromRel) return modRs;
    const dirModRs = fileExistsInScope(join(stemPath, "mod.rs"), absRoot, realRoot, knownFiles);
    return dirModRs && dirModRs !== fromRel ? dirModRs : null;
  }

  if (spec.startsWith("self::")) {
    const segments = spec.slice("self::".length).split("::").filter(Boolean);
    const hit = resolveRustSegmentsInDir(selfDir, segments, absRoot, realRoot, knownFiles);
    return hit && hit !== fromRel ? hit : null;
  }

  if (spec.startsWith("super::")) {
    const parts = spec.split("::").filter(Boolean);
    let superCount = 0;
    while (superCount < parts.length && parts[superCount] === "super") {
      superCount++;
    }
    const rest = parts.slice(superCount);
    let targetDir = isDirModule ? dirname(fromDir) : fromDir;
    for (let i = 1; i < superCount; i++) {
      targetDir = dirname(targetDir);
    }
    if (targetDir !== absRoot && !toRelInsideRoot(absRoot, targetDir)) return null;

    if (rest.length > 0) {
      const hit = resolveRustSegmentsInDir(targetDir, rest, absRoot, realRoot, knownFiles);
      if (hit && hit !== fromRel) return hit;
    }
    if (rest.length <= 1) {
      const parentCandidates = [
        join(targetDir, "mod.rs"),
        targetDir !== absRoot ? `${targetDir}.rs` : null,
        join(targetDir, "lib.rs"),
        join(targetDir, "main.rs"),
      ];
      for (const cand of parentCandidates) {
        if (!cand) continue;
        const hit = fileExistsInScope(cand, absRoot, realRoot, knownFiles);
        if (hit && hit !== fromRel) return hit;
      }
    }
    return null;
  }

  if (spec.startsWith("crate::")) {
    const segments = spec.slice("crate::".length).split("::").filter(Boolean);
    if (segments.length === 0) return null;
    const crateDirs = findRustCrateDirs(fromDir, absRoot, realRoot, knownFiles);
    for (const crateDir of crateDirs) {
      const hit = resolveRustSegmentsInDir(crateDir, segments, absRoot, realRoot, knownFiles);
      if (hit && hit !== fromRel) return hit;
      if (segments.length === 1) {
        for (const rootFile of [join(crateDir, "lib.rs"), join(crateDir, "main.rs")]) {
          const rootHit = fileExistsInScope(rootFile, absRoot, realRoot, knownFiles);
          if (rootHit && rootHit !== fromRel) return rootHit;
        }
      }
    }
    return null;
  }

  return null;
}

function resolvePythonImport(
  fromFile: string,
  spec: string,
  absRoot: string,
  realRoot: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  const parts = spec.split(".").filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === "." || p === ".." || p.includes("/"))) {
    return null;
  }
  const modRel = parts.join("/");
  const baseDirs: string[] = [absRoot, join(absRoot, "src")];

  const absFrom = isAbsolute(fromFile) ? resolve(fromFile) : resolve(absRoot, fromFile);
  let cur = dirname(absFrom);
  while (cur !== absRoot && toRelInsideRoot(absRoot, cur) !== null) {
    if (
      isSafeRegularFileSync(realRoot, join(cur, "pyproject.toml")) ||
      isSafeRegularFileSync(realRoot, join(cur, "setup.py")) ||
      isSafeRegularFileSync(realRoot, join(cur, "setup.cfg"))
    ) {
      baseDirs.push(cur, join(cur, "src"));
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const baseDir of baseDirs) {
    const modFile = resolve(baseDir, `${modRel}.py`);
    const modHit = fileExistsInScope(modFile, absRoot, realRoot, knownFiles);
    if (modHit) return modHit;

    const initFile = resolve(baseDir, modRel, "__init__.py");
    const initHit = fileExistsInScope(initFile, absRoot, realRoot, knownFiles);
    if (initHit) return initHit;
  }

  return null;
}

function readBoundedSafeFileSync(
  realRoot: string,
  filePath: string,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): string | null {
  if (!isSafeRegularFileSync(realRoot, filePath)) return null;
  try {
    const stat = lstatSync(filePath);
    if (stat.size > maxBytes) return null;
    const raw = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > maxBytes) return null;
    return raw;
  } catch {
    return null;
  }
}

function tryResolveCandidateBase(
  base: string,
  spec: string,
  realRoot: string,
  fromExt?: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  for (const candidate of importCandidates(base, spec, fromExt)) {
    const rel = toRelInsideRoot(realRoot, candidate);
    if (!rel) continue;
    const exists = knownFiles ? knownFiles.has(rel) : isSafeRegularFileSync(realRoot, candidate);
    if (exists) return rel;
  }
  return null;
}

export type WorkspacePackageEntry = {
  name: string;
  dir: string;
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
};

type TsconfigPathMapping = {
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
  targets: string[];
  baseDir: string;
};

type TsconfigResolved = {
  configDir: string;
  baseUrlAbs: string | null;
  mappings: TsconfigPathMapping[];
  references: string[];
};

export type TsResolutionContext = {
  realRoot: string;
  packages: WorkspacePackageEntry[];
  tsconfigCache: Map<string, TsconfigResolved | null>;
};

function globSegmentToRegex(segment: string): RegExp {
  let src = "^";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (ch === "*") {
      src += "[^/]*";
    } else if (ch === "?") {
      src += "[^/]";
    } else if (/[.*+?^${}()|[\]\\]/.test(ch)) {
      src += `\\${ch}`;
    } else {
      src += ch;
    }
  }
  src += "$";
  return new RegExp(src);
}

function workspaceGlobToRegex(pattern: string): RegExp | null {
  const clean = pattern
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  const segments = clean.split("/").filter(Boolean);
  let src = "^";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? "";
    if (seg === "**") {
      if (i === 0 && segments.length === 1) {
        src += ".*";
      } else if (i === 0) {
        src += "(?:.+/)?";
      } else {
        src += "(?:/.*)?";
      }
      continue;
    }
    if (i > 0 && segments[i - 1] !== "**") src += "/";
    src += globSegmentToRegex(seg).source.slice(1, -1);
  }
  src += "$";
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

function readWorkspacePatterns(realRoot: string): { includes: string[]; excludes: RegExp[] } {
  const includes: string[] = [];
  const excludes: RegExp[] = [];

  const pushPattern = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("!")) {
      const re = workspaceGlobToRegex(trimmed.slice(1));
      if (re) excludes.push(re);
    } else {
      includes.push(trimmed);
    }
  };

  const pnpmWsRaw = readBoundedSafeFileSync(realRoot, join(realRoot, "pnpm-workspace.yaml"));
  if (pnpmWsRaw !== null) {
    try {
      const parsed = parseYaml(pnpmWsRaw) as { packages?: unknown } | null;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.packages)) {
        for (const item of parsed.packages) {
          if (typeof item === "string") pushPattern(item);
        }
      }
    } catch {
      // Ignore malformed pnpm-workspace.yaml
    }
  }

  const rootPkgRaw = readBoundedSafeFileSync(realRoot, join(realRoot, "package.json"));
  if (rootPkgRaw !== null) {
    try {
      const parsed = JSON.parse(rootPkgRaw) as { workspaces?: unknown };
      const ws = parsed.workspaces;
      const wsList = Array.isArray(ws)
        ? ws
        : ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)
          ? (ws as { packages: unknown[] }).packages
          : [];
      for (const item of wsList) {
        if (typeof item === "string") pushPattern(item);
      }
    } catch {
      // Ignore malformed root package.json
    }
  }

  for (const fallback of ["apps/*", "packages/*"]) {
    if (!includes.includes(fallback)) includes.push(fallback);
  }

  return { includes, excludes };
}

function parsePackageJsonEntry(pkgDir: string, realRoot: string): WorkspacePackageEntry | null {
  const pkgPath = join(pkgDir, "package.json");
  const raw = readBoundedSafeFileSync(realRoot, pkgPath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      exports?: unknown;
      main?: unknown;
      module?: unknown;
      types?: unknown;
      typings?: unknown;
    };
    if (typeof parsed.name !== "string" || !parsed.name.trim()) return null;
    return {
      name: parsed.name.trim(),
      dir: pkgDir,
      ...(parsed.exports !== undefined ? { exports: parsed.exports } : {}),
      ...(typeof parsed.main === "string" ? { main: parsed.main } : {}),
      ...(typeof parsed.module === "string" ? { module: parsed.module } : {}),
      ...(typeof parsed.types === "string"
        ? { types: parsed.types }
        : typeof parsed.typings === "string"
          ? { types: parsed.typings }
          : {}),
    };
  } catch {
    return null;
  }
}

export function loadWorkspacePackages(root: string): WorkspacePackageEntry[] {
  const realRoot = safeRealpathSync(resolve(root));
  const { includes, excludes } = readWorkspacePatterns(realRoot);
  const candidateDirs = new Set<string>();

  const isExcluded = (relDir: string): boolean => excludes.some((re) => re.test(relDir));

  for (const pattern of includes) {
    const clean = pattern
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "");
    if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) continue;
    const segments = clean.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    const visitedGlobStates = new Set<string>();
    const expandSegments = (
      currentDir: string,
      segs: readonly string[],
      idx: number,
      depth: number,
    ): void => {
      if (depth > 8) return;
      if (idx >= segs.length) {
        const rel = toRelInsideRoot(realRoot, currentDir);
        if (rel && !isExcluded(rel)) candidateDirs.add(currentDir);
        return;
      }

      const stateKey = `${currentDir}\0${idx}`;
      if (visitedGlobStates.has(stateKey)) return;
      visitedGlobStates.add(stateKey);

      const seg = segs[idx] ?? "";
      if (!seg || seg === ".") {
        expandSegments(currentDir, segs, idx + 1, depth);
        return;
      }
      if (seg === "..") return;

      if (seg === "**") {
        expandSegments(currentDir, segs, idx + 1, depth);
        let entries: Dirent[];
        try {
          entries = readdirSync(currentDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          if (entry.name.startsWith(".") || DEFAULT_SKIP_DIRS.has(entry.name)) continue;
          const child = join(currentDir, entry.name);
          try {
            const lst = lstatSync(child);
            if (lst.isSymbolicLink() || !lst.isDirectory()) continue;
            const realChild = realpathSync(child);
            if (!isWithinRoot(realRoot, realChild)) continue;
            expandSegments(realChild, segs, idx, depth + 1);
          } catch {
            // Ignore unreadable dirs
          }
        }
        return;
      }

      if (!seg.includes("*") && !seg.includes("?")) {
        const child = join(currentDir, seg);
        try {
          const lst = lstatSync(child);
          if (lst.isSymbolicLink() || !lst.isDirectory()) return;
          const realChild = realpathSync(child);
          if (!isWithinRoot(realRoot, realChild)) return;
          expandSegments(realChild, segs, idx + 1, depth + 1);
        } catch {
          // Ignore missing dir
        }
        return;
      }

      const segRe = globSegmentToRegex(seg);
      let entries: Dirent[];
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".") || DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        if (!segRe.test(entry.name)) continue;
        const child = join(currentDir, entry.name);
        try {
          const lst = lstatSync(child);
          if (lst.isSymbolicLink() || !lst.isDirectory()) continue;
          const realChild = realpathSync(child);
          if (!isWithinRoot(realRoot, realChild)) continue;
          expandSegments(realChild, segs, idx + 1, depth + 1);
        } catch {
          // Ignore unreadable dirs
        }
      }
    };

    expandSegments(realRoot, segments, 0, 0);
  }

  const packages: WorkspacePackageEntry[] = [];
  const seenNames = new Set<string>();

  for (const dir of [...candidateDirs].sort()) {
    const pkg = parsePackageJsonEntry(dir, realRoot);
    if (!pkg || seenNames.has(pkg.name)) continue;
    seenNames.add(pkg.name);
    packages.push(pkg);
  }

  const rootPkg = parsePackageJsonEntry(realRoot, realRoot);
  if (rootPkg && !seenNames.has(rootPkg.name)) {
    packages.push(rootPkg);
  }

  return packages.sort((a, b) => b.name.length - a.name.length);
}

const EXPORT_CONDITION_ORDER = [
  "source",
  "development",
  "import",
  "module",
  "default",
  "node",
  "browser",
  "require",
  "types",
];

function collectExportConditionTargets(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    if (!out.includes(node)) out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectExportConditionTargets(item, out);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const preferred of EXPORT_CONDITION_ORDER) {
    if (preferred in record) {
      collectExportConditionTargets(record[preferred], out);
    }
  }
  for (const key of keys) {
    if (!EXPORT_CONDITION_ORDER.includes(key)) {
      collectExportConditionTargets(record[key], out);
    }
  }
}

function resolvePackageExportsTargets(exportsField: unknown, subpath: string): string[] {
  if (typeof exportsField === "string") {
    return subpath === "." ? [exportsField] : [];
  }
  if (Array.isArray(exportsField)) {
    if (subpath !== ".") return [];
    const out: string[] = [];
    collectExportConditionTargets(exportsField, out);
    return out;
  }
  if (!exportsField || typeof exportsField !== "object") return [];
  const record = exportsField as Record<string, unknown>;
  const keys = Object.keys(record);
  const isSubpathMap = keys.some((k) => k === "." || k.startsWith("./"));

  if (!isSubpathMap) {
    if (subpath !== ".") return [];
    const out: string[] = [];
    collectExportConditionTargets(record, out);
    return out;
  }

  if (subpath in record) {
    if (record[subpath] === null) return [];
    const out: string[] = [];
    collectExportConditionTargets(record[subpath], out);
    return out;
  }

  const wildcardKeys = keys
    .filter((k) => k.startsWith("./") && k.includes("*"))
    .sort((a, b) => {
      const aStar = a.indexOf("*");
      const bStar = b.indexOf("*");
      return bStar - aStar || b.length - a.length;
    });

  for (const patternKey of wildcardKeys) {
    const starIdx = patternKey.indexOf("*");
    const prefix = patternKey.slice(0, starIdx);
    const suffix = patternKey.slice(starIdx + 1);
    if (subpath.length < prefix.length + suffix.length) continue;
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (record[patternKey] === null) return [];
    const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
    const rawTargets: string[] = [];
    collectExportConditionTargets(record[patternKey], rawTargets);
    return rawTargets.map((t) => (t.includes("*") ? t.replaceAll("*", matched) : t));
  }

  return [];
}

function normalizeDeclarationExt(relTarget: string): string[] {
  if (relTarget.endsWith(".d.ts")) {
    const stem = relTarget.slice(0, -5);
    return [`${stem}.ts`, `${stem}.tsx`];
  }
  if (relTarget.endsWith(".d.mts")) {
    return [`${relTarget.slice(0, -6)}.mts`];
  }
  if (relTarget.endsWith(".d.cts")) {
    return [`${relTarget.slice(0, -6)}.cts`];
  }
  return [relTarget];
}

function tryResolvePackageTarget(
  pkgDir: string,
  rawTarget: string,
  subpath: string,
  realRoot: string,
  fromExt?: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  const clean = rawTarget.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean || clean.startsWith("/") || clean.split("/").includes("..")) return null;

  const candidateTargets: string[] = [];
  const pushWithDts = (relPath: string) => {
    for (const expanded of normalizeDeclarationExt(relPath)) {
      if (!candidateTargets.includes(expanded)) candidateTargets.push(expanded);
    }
  };

  if (/^(?:dist|build|out|lib)\//.test(clean)) {
    const stripped = clean.replace(/^(?:dist|build|out|lib)\//, "");
    pushWithDts(`src/${stripped}`);
    pushWithDts(stripped);
  }
  pushWithDts(clean);
  if (subpath === "." && !clean.startsWith("src/")) {
    pushWithDts(`src/${clean}`);
  }

  for (const relTarget of candidateTargets) {
    const candBase = resolve(pkgDir, relTarget);
    const hit = tryResolveCandidateBase(candBase, relTarget, realRoot, fromExt, knownFiles);
    if (hit) return hit;
  }
  return null;
}

function resolveWorkspacePackageImport(
  spec: string,
  packages: readonly WorkspacePackageEntry[],
  realRoot: string,
  fromExt?: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  for (const pkg of packages) {
    if (spec !== pkg.name && !spec.startsWith(`${pkg.name}/`)) continue;
    const subpath = spec === pkg.name ? "." : `./${spec.slice(pkg.name.length + 1)}`;
    if (subpath.split("/").includes("..")) return null;

    const candidateTargets: string[] = [];
    if (pkg.exports !== undefined) {
      candidateTargets.push(...resolvePackageExportsTargets(pkg.exports, subpath));
    } else if (subpath === ".") {
      for (const fallback of [pkg.module, pkg.main, pkg.types, "./src/index", "./index"]) {
        if (fallback && !candidateTargets.includes(fallback)) {
          candidateTargets.push(fallback);
        }
      }
    } else {
      const subRel = subpath.slice(2);
      candidateTargets.push(`./src/${subRel}`, `./${subRel}`);
    }

    for (const target of candidateTargets) {
      const hit = tryResolvePackageTarget(pkg.dir, target, subpath, realRoot, fromExt, knownFiles);
      if (hit) return hit;
    }
  }
  return null;
}

const MAX_TSCONFIG_REF_DEPTH = 8;
const MAX_TSCONFIG_FILES = 64;

function resolveTsconfigExtendsPath(
  fromConfigDir: string,
  extSpec: string,
  realRoot: string,
): string | null {
  if (!extSpec || (!extSpec.startsWith(".") && !isAbsolute(extSpec))) return null;
  const rawBase = isAbsolute(extSpec) ? resolve(extSpec) : resolve(fromConfigDir, extSpec);
  const candidates = rawBase.endsWith(".json")
    ? [rawBase]
    : [rawBase, `${rawBase}.json`, join(rawBase, "tsconfig.json")];
  for (const candidate of candidates) {
    if (!toRelInsideRoot(realRoot, candidate)) continue;
    if (isSafeRegularFileSync(realRoot, candidate)) {
      return safeRealpathSync(candidate);
    }
  }
  return null;
}

function resolveTsconfigReferencePath(
  fromConfigDir: string,
  refSpec: string,
  realRoot: string,
): string | null {
  if (!refSpec) return null;
  const rawBase = isAbsolute(refSpec) ? resolve(refSpec) : resolve(fromConfigDir, refSpec);
  const candidates = rawBase.endsWith(".json")
    ? [rawBase]
    : [join(rawBase, "tsconfig.json"), rawBase, `${rawBase}.json`];
  for (const candidate of candidates) {
    if (!isWithinRoot(realRoot, candidate)) continue;
    if (isSafeRegularFileSync(realRoot, candidate)) {
      const realCandidate = safeRealpathSync(candidate);
      if (isWithinRoot(realRoot, realCandidate)) return realCandidate;
    }
  }
  return null;
}

function loadTsconfigChain(
  configPath: string,
  realRoot: string,
  cache: Map<string, TsconfigResolved | null>,
  visited = new Set<string>(),
): TsconfigResolved | null {
  const realConfigPath = safeRealpathSync(configPath);
  if (cache.has(realConfigPath)) return cache.get(realConfigPath) ?? null;
  if (visited.has(realConfigPath) || visited.size >= 8) return null;
  if (toRelInsideRoot(realRoot, realConfigPath) === null) return null;

  const raw = readBoundedSafeFileSync(realRoot, realConfigPath);
  if (raw === null) {
    cache.set(realConfigPath, null);
    return null;
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true }) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    cache.set(realConfigPath, null);
    return null;
  }

  const nextVisited = new Set(visited);
  nextVisited.add(realConfigPath);

  const configDir = dirname(realConfigPath);
  const obj = parsed as { extends?: unknown; compilerOptions?: unknown; references?: unknown };

  let inheritedBaseUrl: string | null = null;
  let inheritedMappings: TsconfigPathMapping[] = [];

  const extendsList = Array.isArray(obj.extends)
    ? obj.extends.filter((x): x is string => typeof x === "string")
    : typeof obj.extends === "string"
      ? [obj.extends]
      : [];

  for (const extSpec of extendsList) {
    const extPath = resolveTsconfigExtendsPath(configDir, extSpec, realRoot);
    if (!extPath) continue;
    const parent = loadTsconfigChain(extPath, realRoot, cache, nextVisited);
    if (!parent) continue;
    if (parent.baseUrlAbs !== null) inheritedBaseUrl = parent.baseUrlAbs;
    if (parent.mappings.length > 0) inheritedMappings = parent.mappings;
  }

  const co =
    obj.compilerOptions &&
    typeof obj.compilerOptions === "object" &&
    !Array.isArray(obj.compilerOptions)
      ? (obj.compilerOptions as { baseUrl?: unknown; paths?: unknown })
      : undefined;

  let baseUrlAbs = inheritedBaseUrl;
  if (co && typeof co.baseUrl === "string" && co.baseUrl.trim()) {
    const candidateBase = resolve(configDir, co.baseUrl.trim());
    if (candidateBase === realRoot || toRelInsideRoot(realRoot, candidateBase) !== null) {
      baseUrlAbs = candidateBase;
    }
  }

  let mappings = inheritedMappings;
  if (co?.paths && typeof co.paths === "object" && !Array.isArray(co.paths)) {
    const baseDir = baseUrlAbs ?? configDir;
    const own: TsconfigPathMapping[] = [];
    for (const [pattern, rawTargets] of Object.entries(co.paths)) {
      if (!Array.isArray(rawTargets)) continue;
      const targets = rawTargets.filter((t): t is string => typeof t === "string" && t.length > 0);
      if (targets.length === 0) continue;
      const starIdx = pattern.indexOf("*");
      if (starIdx === -1) {
        own.push({ prefix: pattern, suffix: "", hasWildcard: false, targets, baseDir });
      } else {
        own.push({
          prefix: pattern.slice(0, starIdx),
          suffix: pattern.slice(starIdx + 1),
          hasWildcard: true,
          targets,
          baseDir,
        });
      }
    }
    own.sort((a, b) => {
      if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
      return b.prefix.length - a.prefix.length || b.suffix.length - a.suffix.length;
    });
    mappings = own;
  } else if (baseUrlAbs && baseUrlAbs !== inheritedBaseUrl && inheritedMappings.length > 0) {
    mappings = inheritedMappings.map((m) => ({ ...m, baseDir: baseUrlAbs }));
  }

  const references: string[] = [];
  if (Array.isArray(obj.references)) {
    for (const ref of obj.references) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
      const rawPath = (ref as { path?: unknown }).path;
      if (typeof rawPath !== "string") continue;
      const refPath = resolveTsconfigReferencePath(configDir, rawPath.trim(), realRoot);
      if (refPath && !references.includes(refPath)) {
        references.push(refPath);
      }
    }
  }

  const resolved: TsconfigResolved = { configDir, baseUrlAbs, mappings, references };
  cache.set(realConfigPath, resolved);
  return resolved;
}

function findTsconfigsForDir(
  fromDirInRealRoot: string,
  realRoot: string,
  cache: Map<string, TsconfigResolved | null>,
): TsconfigResolved[] {
  const configs: TsconfigResolved[] = [];
  const seen = new Set<string>();
  let cur = fromDirInRealRoot;
  while (
    (cur === realRoot || toRelInsideRoot(realRoot, cur) !== null) &&
    configs.length < MAX_TSCONFIG_FILES
  ) {
    const candidate = join(cur, "tsconfig.json");
    if (isSafeRegularFileSync(realRoot, candidate)) {
      const realCfg = safeRealpathSync(candidate);
      const queue: Array<{ path: string; depth: number }> = [{ path: realCfg, depth: 0 }];
      while (queue.length > 0 && configs.length < MAX_TSCONFIG_FILES) {
        const item = queue.shift();
        if (!item || seen.has(item.path)) continue;
        seen.add(item.path);
        const loaded = loadTsconfigChain(item.path, realRoot, cache);
        if (!loaded) continue;
        configs.push(loaded);
        if (item.depth < MAX_TSCONFIG_REF_DEPTH) {
          for (const refPath of loaded.references) {
            if (!seen.has(refPath)) {
              queue.push({ path: refPath, depth: item.depth + 1 });
            }
          }
        }
      }
    }
    if (cur === realRoot) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return configs;
}

function resolveWithTsconfig(
  spec: string,
  tsconfig: TsconfigResolved,
  realRoot: string,
  fromExt?: string,
  knownFiles?: ReadonlySet<string>,
): string | null {
  for (const mapping of tsconfig.mappings) {
    if (!mapping.hasWildcard) {
      if (spec !== mapping.prefix) continue;
      for (const target of mapping.targets) {
        const candBase = resolve(mapping.baseDir, target);
        const hit = tryResolveCandidateBase(candBase, spec, realRoot, fromExt, knownFiles);
        if (hit) return hit;
      }
      continue;
    }

    if (spec.length < mapping.prefix.length + mapping.suffix.length) continue;
    if (!spec.startsWith(mapping.prefix) || !spec.endsWith(mapping.suffix)) continue;
    const matched = spec.slice(mapping.prefix.length, spec.length - mapping.suffix.length);
    for (const target of mapping.targets) {
      const expanded = target.includes("*") ? target.replaceAll("*", matched) : target;
      const candBase = resolve(mapping.baseDir, expanded);
      const hit = tryResolveCandidateBase(candBase, spec, realRoot, fromExt, knownFiles);
      if (hit) return hit;
    }
  }

  if (tsconfig.baseUrlAbs) {
    const candBase = resolve(tsconfig.baseUrlAbs, spec);
    const hit = tryResolveCandidateBase(candBase, spec, realRoot, fromExt, knownFiles);
    if (hit) return hit;
  }

  return null;
}

export function createTsResolutionContext(root: string): TsResolutionContext {
  const realRoot = safeRealpathSync(resolve(root));
  return {
    realRoot,
    packages: loadWorkspacePackages(realRoot),
    tsconfigCache: new Map<string, TsconfigResolved | null>(),
  };
}

function resolveTsJsNonRelativeImport(
  fromFile: string,
  spec: string,
  absRoot: string,
  realRoot: string,
  fromExt: string,
  knownFiles?: ReadonlySet<string>,
  tsContext?: TsResolutionContext,
): string | null {
  if (!spec || spec.startsWith("node:") || spec.startsWith("/")) return null;
  const ctx = tsContext ?? createTsResolutionContext(realRoot);

  const absFrom = isAbsolute(fromFile) ? resolve(fromFile) : resolve(absRoot, fromFile);
  const relFrom = toRelInsideRoot(absRoot, absFrom) ?? toRelInsideRoot(realRoot, absFrom);
  const fromDirInRealRoot = relFrom ? dirname(resolve(realRoot, relFrom)) : realRoot;

  for (const tsconfig of findTsconfigsForDir(fromDirInRealRoot, realRoot, ctx.tsconfigCache)) {
    const hit = resolveWithTsconfig(spec, tsconfig, realRoot, fromExt, knownFiles);
    if (hit) return hit;
  }

  return resolveWorkspacePackageImport(spec, ctx.packages, realRoot, fromExt, knownFiles);
}

export function resolveImport(
  fromFile: string,
  spec: string,
  root: string,
  knownFiles?: ReadonlySet<string>,
  psr4Entries?: readonly ComposerPsr4Entry[],
  goModule?: string | null,
  tsContext?: TsResolutionContext,
): string | null {
  const absRoot = resolve(root);
  const realRoot = safeRealpathSync(absRoot);
  const fromExt = extname(fromFile).toLowerCase();
  if (!spec.startsWith(".")) {
    if (fromExt === ".php" || spec.includes("\\")) {
      const entries = psr4Entries ?? loadComposerPsr4(absRoot);
      return resolvePhpPsr4Import(spec, absRoot, realRoot, entries, knownFiles);
    }
    if (fromExt === ".go") {
      const modPath = goModule === undefined ? loadGoModule(absRoot) : goModule;
      const matches = resolveGoImport(spec, absRoot, realRoot, modPath, knownFiles);
      return matches[0] ?? null;
    }
    if (fromExt === ".rs") {
      return resolveRustImport(fromFile, spec, absRoot, realRoot, knownFiles);
    }
    if (fromExt === ".py") {
      return resolvePythonImport(fromFile, spec, absRoot, realRoot, knownFiles);
    }
    if (!fromExt || TS_JS_EXT.has(fromExt) || SFC_EXT.has(fromExt)) {
      return resolveTsJsNonRelativeImport(
        fromFile,
        spec,
        absRoot,
        realRoot,
        fromExt,
        knownFiles,
        tsContext,
      );
    }
    return null;
  }
  const absFrom = isAbsolute(fromFile) ? resolve(fromFile) : resolve(absRoot, fromFile);
  const base = resolve(dirname(absFrom), spec);
  for (const candidate of importCandidates(base, spec, fromExt)) {
    const rel = toRelInsideRoot(absRoot, candidate);
    if (!rel) continue;
    const exists = knownFiles ? knownFiles.has(rel) : isSafeRegularFileSync(realRoot, candidate);
    if (exists) return rel;
  }
  return toRelInsideRoot(absRoot, base);
}

export type GraphIndexResult = {
  files: number;
  symbols: number;
  edges: number;
};

export type GraphIndexOptions = {
  maxFileBytes?: number;
  rebuildEdges?: boolean;
};

type WalkedEntry = {
  rootId: string | null;
  absRoot: string;
  realRoot: string;
  prefix: string;
  full: string;
  relInRoot: string;
  rel: string;
  ext: string;
  mtimeMs: number;
};

type ExistingFileRow = {
  id: number;
  root_id: string | null;
  path: string;
  hash: string | null;
  mtime_ms: number | null;
};

export async function indexProjectGraph(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  root: string,
  options: GraphIndexOptions = {},
): Promise<GraphIndexResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return withDatabaseAsync(dbOrPath, async (db) => {
    const registeredRoots = db
      .prepare("SELECT id, path, label FROM workspace_roots WHERE project_id = ? ORDER BY path")
      .all(projectId) as Array<{ id: string; path: string; label: string | null }>;
    const targets = await collectRootTargets(root, registeredRoots);

    const entries: WalkedEntry[] = [];
    const knownFilesByRoot = new Map<string | null, Set<string>>();

    for (const target of targets) {
      const { realRoot, files: walkedFiles } = await walkWorkspaceFiles(target.absRoot, {
        extensions: CODE_EXT,
        skipDirs: DEFAULT_SKIP_DIRS,
        skipDotEntries: true,
        maxFileBytes,
        honorGitignore: true,
      });
      const rootKnown = new Set<string>();
      for (const file of walkedFiles) {
        const relInRoot = file.rel;
        const rel = target.prefix ? `${target.prefix}/${relInRoot}` : relInRoot;
        rootKnown.add(relInRoot);
        entries.push({
          rootId: target.rootId,
          absRoot: target.absRoot,
          realRoot,
          prefix: target.prefix,
          full: file.full,
          relInRoot,
          rel,
          ext: file.ext,
          mtimeMs: file.mtimeMs,
        });
      }
      knownFilesByRoot.set(target.rootId, rootKnown);
    }

    const knownFiles = new Set(entries.map((entry) => entry.rel));

    const existingRows = db
      .prepare("SELECT id, root_id, path, hash, mtime_ms FROM files WHERE project_id = ?")
      .all(projectId) as ExistingFileRow[];
    const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

    const needsParserUpgrade = !isGraphParserCurrent(db, projectId);

    const legacyReexportFileIds = new Set<number>();
    if (!needsParserUpgrade && existingRows.length > 0) {
      const legacyRows = db
        .prepare(
          `SELECT DISTINCT e.from_file_id AS id
           FROM edges e
           WHERE e.project_id = ?
             AND e.kind = 'reexport'
             AND e.from_file_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM symbols s WHERE s.project_id = ? AND s.file_id = e.from_file_id
             )`,
        )
        .all(projectId, projectId) as Array<{ id: number }>;
      for (const row of legacyRows) legacyReexportFileIds.add(row.id);
    }

    const deletedIds: number[] = [];
    for (const row of existingRows) {
      if (!knownFiles.has(row.path)) deletedIds.push(row.id);
    }

    const edgeRefreshPaths = new Set<string>();
    if (!options.rebuildEdges && deletedIds.length > 0) {
      const placeholders = deletedIds.map(() => "?").join(", ");
      const affected = db
        .prepare(
          `SELECT DISTINCT f.path
           FROM edges e
           JOIN files f ON f.id = e.from_file_id
           WHERE e.project_id = ? AND e.to_file_id IN (${placeholders})`,
        )
        .all(projectId, ...deletedIds) as Array<{ path: string }>;
      for (const row of affected) {
        if (knownFiles.has(row.path)) edgeRefreshPaths.add(row.path);
      }
    }

    if (!options.rebuildEdges && entries.some((entry) => !existingByPath.has(entry.rel))) {
      const unresolved = db
        .prepare(
          `SELECT DISTINCT f.path
           FROM edges e
           JOIN files f ON f.id = e.from_file_id
           WHERE e.project_id = ? AND e.to_file_id IS NULL`,
        )
        .all(projectId) as Array<{ path: string }>;
      for (const row of unresolved) {
        if (knownFiles.has(row.path)) edgeRefreshPaths.add(row.path);
      }
    }

    const idByPath = new Map<string, number>();
    const mtimeOnlyUpdates: Array<{ id: number; rootId: string | null; mtimeMs: number }> = [];
    type ResolvedEdgeTarget = {
      to: string;
      kind: "imports" | "reexport";
    };

    const newFiles: Array<{
      rootId: string | null;
      rel: string;
      hash: string;
      mtimeMs: number;
      symbols: Array<{ name: string; kind: string; line: number }>;
      imports: ResolvedEdgeTarget[];
    }> = [];
    const modifiedFiles: Array<{
      id: number;
      rootId: string | null;
      rel: string;
      hash: string;
      mtimeMs: number;
      symbols: Array<{ name: string; kind: string; line: number }>;
      imports: ResolvedEdgeTarget[];
    }> = [];
    const refreshedEdges: Array<{ id: number; imports: ResolvedEdgeTarget[] }> = [];

    const psr4ByRoot = new Map<string, ComposerPsr4Entry[]>();
    const getPsr4ForRoot = (realRoot: string): ComposerPsr4Entry[] => {
      let cached = psr4ByRoot.get(realRoot);
      if (!cached) {
        cached = loadComposerPsr4(realRoot);
        psr4ByRoot.set(realRoot, cached);
      }
      return cached;
    };

    const goModuleByRoot = new Map<string, string | null>();
    const getGoModuleForRoot = (realRoot: string): string | null => {
      if (goModuleByRoot.has(realRoot)) {
        return goModuleByRoot.get(realRoot) ?? null;
      }
      const mod = loadGoModule(realRoot);
      goModuleByRoot.set(realRoot, mod);
      return mod;
    };

    const tsContextByRoot = new Map<string, TsResolutionContext>();
    const getTsContextForRoot = (realRoot: string): TsResolutionContext => {
      let cached = tsContextByRoot.get(realRoot);
      if (!cached) {
        cached = createTsResolutionContext(realRoot);
        tsContextByRoot.set(realRoot, cached);
      }
      return cached;
    };

    const resolveImportsForEntry = (entry: WalkedEntry, content: string): ResolvedEdgeTarget[] => {
      const rootKnown = knownFilesByRoot.get(entry.rootId);
      const psr4 = entry.ext === ".php" ? getPsr4ForRoot(entry.realRoot) : undefined;
      const goMod = entry.ext === ".go" ? getGoModuleForRoot(entry.realRoot) : undefined;
      const isTsJs = TS_JS_EXT.has(entry.ext);
      const isSfc = SFC_EXT.has(entry.ext);
      const tsCtx = isTsJs || isSfc ? getTsContextForRoot(entry.realRoot) : undefined;

      const specs: TsJsImportEntry[] = isTsJs
        ? parseTsJsImportEntries(content, true)
        : isSfc
          ? (() => {
              const merged = new Map<string, "imports" | "reexport">();
              for (const block of extractSfcScriptBlocks(content)) {
                for (const item of parseTsJsImportEntries(block.code, true)) {
                  const prev = merged.get(item.spec);
                  if (!prev || (prev === "reexport" && item.kind === "imports")) {
                    merged.set(item.spec, item.kind);
                  }
                }
              }
              return [...merged.entries()].map(([spec, kind]) => ({ spec, kind }));
            })()
          : parseImports(content, entry.ext).map((spec) => ({ spec, kind: "imports" as const }));

      const byTarget = new Map<string, "imports" | "reexport">();
      const recordTarget = (target: string, kind: "imports" | "reexport") => {
        const prev = byTarget.get(target);
        if (!prev || (prev === "reexport" && kind === "imports")) {
          byTarget.set(target, kind);
        }
      };

      for (const item of specs) {
        if (entry.ext === ".go") {
          for (const target of resolveGoImport(
            item.spec,
            entry.realRoot,
            entry.realRoot,
            goMod ?? null,
            rootKnown,
          )) {
            if (target !== entry.relInRoot) {
              recordTarget(entry.prefix ? `${entry.prefix}/${target}` : target, "imports");
            }
          }
          continue;
        }
        const to = resolveImport(
          entry.full,
          item.spec,
          entry.realRoot,
          rootKnown,
          psr4,
          goMod,
          tsCtx,
        );
        if (to && to !== entry.relInRoot) {
          recordTarget(entry.prefix ? `${entry.prefix}/${to}` : to, item.kind);
        }
      }
      return [...byTarget.entries()].map(([to, kind]) => ({ to, kind }));
    };

    for (const entry of entries) {
      const existing = existingByPath.get(entry.rel);
      const forceReparse =
        existing !== undefined && (needsParserUpgrade || legacyReexportFileIds.has(existing.id));
      const refreshEdges = options.rebuildEdges || edgeRefreshPaths.has(entry.rel);
      if (
        !forceReparse &&
        !refreshEdges &&
        existing &&
        existing.mtime_ms === entry.mtimeMs &&
        existing.root_id === entry.rootId
      ) {
        idByPath.set(entry.rel, existing.id);
        continue;
      }

      const content = await readBoundedUtf8File(entry.full, entry.realRoot, maxFileBytes);
      if (content === null) {
        if (existing) deletedIds.push(existing.id);
        continue;
      }
      const contentHash = hash(content);
      if (!forceReparse && existing && existing.hash === contentHash) {
        idByPath.set(entry.rel, existing.id);
        if (existing.mtime_ms !== entry.mtimeMs || existing.root_id !== entry.rootId) {
          mtimeOnlyUpdates.push({ id: existing.id, rootId: entry.rootId, mtimeMs: entry.mtimeMs });
        }
        if (refreshEdges) {
          refreshedEdges.push({ id: existing.id, imports: resolveImportsForEntry(entry, content) });
        }
        continue;
      }

      const symbols = parseSymbols(content, entry.ext);
      const imports = resolveImportsForEntry(entry, content);

      if (!existing) {
        newFiles.push({
          rootId: entry.rootId,
          rel: entry.rel,
          hash: contentHash,
          mtimeMs: entry.mtimeMs,
          symbols,
          imports,
        });
      } else {
        idByPath.set(entry.rel, existing.id);
        modifiedFiles.push({
          id: existing.id,
          rootId: entry.rootId,
          rel: entry.rel,
          hash: contentHash,
          mtimeMs: entry.mtimeMs,
          symbols,
          imports,
        });
      }
    }

    const useSavepoint = typeof dbOrPath !== "string";
    db.exec(useSavepoint ? "SAVEPOINT graph_index" : "BEGIN IMMEDIATE");
    try {
      const deleteFile = db.prepare("DELETE FROM files WHERE project_id = ? AND id = ?");
      const updateMtime = db.prepare("UPDATE files SET root_id = ?, mtime_ms = ? WHERE id = ?");
      const updateFile = db.prepare(
        "UPDATE files SET root_id = ?, hash = ?, mtime_ms = ? WHERE id = ?",
      );
      const deleteSymbolsForFile = db.prepare(
        "DELETE FROM symbols WHERE project_id = ? AND file_id = ?",
      );
      const deleteEdgesForFile = db.prepare(
        "DELETE FROM edges WHERE project_id = ? AND from_file_id = ?",
      );
      const insertFile = db.prepare(
        "INSERT INTO files (project_id, root_id, path, hash, mtime_ms) VALUES (?, ?, ?, ?, ?) RETURNING id",
      );
      const insertSymbol = db.prepare(
        "INSERT INTO symbols (project_id, file_id, name, kind, line) VALUES (?, ?, ?, ?, ?)",
      );
      const insertEdge = db.prepare(
        "INSERT INTO edges (project_id, kind, from_file_id, to_file_id, label) VALUES (?, ?, ?, ?, ?)",
      );

      for (const id of deletedIds) deleteFile.run(projectId, id);
      for (const item of mtimeOnlyUpdates) updateMtime.run(item.rootId, item.mtimeMs, item.id);

      const pendingEdges: Array<{ fromId: number; to: string; kind: "imports" | "reexport" }> = [];

      for (const item of newFiles) {
        const row = insertFile.get(projectId, item.rootId, item.rel, item.hash, item.mtimeMs) as {
          id: number;
        };
        idByPath.set(item.rel, row.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, row.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const edge of item.imports) {
          pendingEdges.push({ fromId: row.id, to: edge.to, kind: edge.kind });
        }
      }

      for (const item of modifiedFiles) {
        updateFile.run(item.rootId, item.hash, item.mtimeMs, item.id);
        deleteSymbolsForFile.run(projectId, item.id);
        deleteEdgesForFile.run(projectId, item.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, item.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const edge of item.imports) {
          pendingEdges.push({ fromId: item.id, to: edge.to, kind: edge.kind });
        }
      }

      for (const item of refreshedEdges) {
        deleteEdgesForFile.run(projectId, item.id);
        for (const edge of item.imports) {
          pendingEdges.push({ fromId: item.id, to: edge.to, kind: edge.kind });
        }
      }

      for (const edge of pendingEdges) {
        const toId = idByPath.get(edge.to);
        insertEdge.run(projectId, edge.kind, edge.fromId, toId ?? null, edge.to);
      }

      db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(graphParserVersionKey(projectId), String(GRAPH_PARSER_VERSION));

      db.exec(useSavepoint ? "RELEASE SAVEPOINT graph_index" : "COMMIT");
    } catch (error) {
      db.exec(
        useSavepoint
          ? "ROLLBACK TO SAVEPOINT graph_index; RELEASE SAVEPOINT graph_index"
          : "ROLLBACK",
      );
      throw error;
    }

    return readGraphCounts(db, projectId);
  });
}

function readGraphCounts(db: DatabaseSync, projectId: string): GraphIndexResult {
  const totalFiles = (
    db.prepare("SELECT COUNT(*) AS c FROM files WHERE project_id = ?").get(projectId) as {
      c: number;
    }
  ).c;
  const totalSymbols = (
    db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE project_id = ?").get(projectId) as {
      c: number;
    }
  ).c;
  const totalEdges = (
    db.prepare("SELECT COUNT(*) AS c FROM edges WHERE project_id = ?").get(projectId) as {
      c: number;
    }
  ).c;
  return { files: totalFiles, symbols: totalSymbols, edges: totalEdges };
}

export function getGraphCounts(
  dbOrPath: DatabaseSync | string,
  projectId: string,
): GraphIndexResult {
  return withDatabase(dbOrPath, (db) => readGraphCounts(db, projectId));
}

export function graphNeighbors(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  path: string,
  limit: number,
  depth = 1,
): Array<{ kind: string; from: string; to: string; label?: string }> {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const maxDepth = Math.min(2, Math.max(1, Math.floor(depth)));

  return withDatabase(dbOrPath, (db) => {
    const file = db
      .prepare("SELECT id, path FROM files WHERE project_id = ? AND path = ?")
      .get(projectId, path) as { id: number; path: string } | undefined;
    if (!file) return [];

    const seenEdgeIds = new Set<number>();
    const visitedFileIds = new Set<number>([file.id]);
    let frontier = [file.id];
    const results: Array<{ kind: string; from: string; to: string; label?: string }> = [];

    for (let hop = 0; hop < maxDepth && frontier.length > 0 && results.length < safeLimit; hop++) {
      const nodePlaceholders = frontier.map(() => "?").join(", ");
      const remaining = safeLimit - results.length;
      const excludedIds = [...seenEdgeIds];
      const excludeClause =
        excludedIds.length > 0 ? `AND e.id NOT IN (${excludedIds.map(() => "?").join(", ")})` : "";
      const rows = db
        .prepare(
          `SELECT e.id, e.kind, e.from_file_id, e.to_file_id,
                  f1.path AS from_path, COALESCE(f2.path, e.label) AS to_path, e.label
           FROM edges e
           JOIN files f1 ON f1.id = e.from_file_id
           LEFT JOIN files f2 ON f2.id = e.to_file_id
           WHERE e.project_id = ?
             AND (e.from_file_id IN (${nodePlaceholders}) OR e.to_file_id IN (${nodePlaceholders}))
             ${excludeClause}
           ORDER BY e.id
           LIMIT ?`,
        )
        .all(projectId, ...frontier, ...frontier, ...excludedIds, remaining) as Array<{
        id: number;
        kind: string;
        from_file_id: number;
        to_file_id: number | null;
        from_path: string;
        to_path: string;
        label: string | null;
      }>;

      const nextFrontier: number[] = [];
      for (const row of rows) {
        seenEdgeIds.add(row.id);
        results.push({
          kind: row.kind,
          from: row.from_path,
          to: row.to_path,
          ...(row.label ? { label: row.label } : {}),
        });
        if (!visitedFileIds.has(row.from_file_id)) {
          visitedFileIds.add(row.from_file_id);
          nextFrontier.push(row.from_file_id);
        }
        if (row.to_file_id !== null && !visitedFileIds.has(row.to_file_id)) {
          visitedFileIds.add(row.to_file_id);
          nextFrontier.push(row.to_file_id);
        }
      }
      frontier = nextFrontier;
    }

    return results;
  });
}

const MAX_NEIGHBOR_FILE_SYMBOLS = 12;

type NeighborSymbolRow = { name: string; kind?: string; line?: number | null };
type GraphRootDirs = Array<{ rootId: string | null; dir: string }>;
type ClaimTargetRow = Pick<ExistingFileRow, "root_id" | "mtime_ms"> & {
  registered_dir: string | null;
};

function isCurrentClaimTarget(path: string, row: ClaimTargetRow, rootDirs: GraphRootDirs): boolean {
  if (row.mtime_ms === null) return false;
  const root = rootDirs.find(({ rootId }) => rootId === row.root_id);
  if (!root) return false;

  try {
    const absRoot = resolve(root.dir);
    let relativePath = path;
    if (row.root_id !== null) {
      if (row.registered_dir === null || resolve(row.registered_dir) !== absRoot) return false;
      const slash = path.indexOf("/");
      if (!path.startsWith("@") || slash < 2) return false;
      relativePath = path.slice(slash + 1);
    }

    const candidate = resolve(absRoot, relativePath);
    if (toRelInsideRoot(absRoot, candidate) !== relativePath) return false;
    if (!lstatSync(absRoot).isDirectory()) return false;
    const realRoot = realpathSync(absRoot);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || Math.floor(stat.mtimeMs) !== row.mtime_ms) return false;
    const realCandidate = realpathSync(candidate);
    if (!isWithinRoot(realRoot, realCandidate)) return false;
    accessSync(realCandidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function prioritizeSymbolLocations(rows: NeighborSymbolRow[]): ClaimGraphFile["symbol_locations"] {
  const functions: Array<{ name: string; line: number }> = [];
  const others: Array<{ name: string; line: number }> = [];
  // Rows come in source order, with ID breaking ties. Keep that order within each group.
  for (const { name, kind, line } of rows) {
    if (line == null || !Number.isSafeInteger(line) || line < 1) continue;
    if (kind === "function" || kind === "method") {
      functions.push({ name, line });
      if (functions.length === MAX_CLAIM_SYMBOL_LOCATIONS) return functions;
    } else if (others.length < MAX_CLAIM_SYMBOL_LOCATIONS) {
      others.push({ name, line });
    }
  }
  const locations = [
    ...functions,
    ...others.slice(0, MAX_CLAIM_SYMBOL_LOCATIONS - functions.length),
  ];
  return locations.length > 0 ? locations : undefined;
}

export function queryGraphNeighbors(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  rawInput: z.input<typeof GraphNeighborsInput>,
  rootDirs?: GraphRootDirs,
): z.output<typeof GraphNeighborsOutput> {
  return queryGraphNeighborsInternal(dbOrPath, projectId, rawInput, rootDirs, false);
}

export function queryClaimGraphSlice(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  paths: string[],
  rootDirs: GraphRootDirs,
): ClaimGraphFile[] {
  return queryGraphNeighborsInternal(
    dbOrPath,
    projectId,
    { paths, depth: 1, limit: 15, include_symbols: true },
    rootDirs,
    true,
  ).files;
}

function queryGraphNeighborsInternal(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  rawInput: z.input<typeof GraphNeighborsInput>,
  rootDirs: GraphRootDirs | undefined,
  claimSlice: boolean,
): Omit<z.output<typeof GraphNeighborsOutput>, "files"> & { files: ClaimGraphFile[] } {
  const parsed = GraphNeighborsInput.parse(rawInput);
  const rawTargets = parsed.paths ?? (parsed.path ? [parsed.path] : []);
  const targetPaths = [...new Set(rawTargets)].slice(0, 5);

  return withDatabase(dbOrPath, (db) => {
    const freshness = rootDirs ? checkGraphFreshness(db, projectId, rootDirs) : undefined;
    const includeLocations = claimSlice && freshness?.stale === false;
    const claimTargetStmt = includeLocations
      ? db.prepare(
          `SELECT f.root_id, f.mtime_ms, r.path AS registered_dir
           FROM files f
           LEFT JOIN workspace_roots r ON r.project_id = f.project_id AND r.id = f.root_id
           WHERE f.project_id = ? AND f.path = ?`,
        )
      : null;
    const symbolStmt = parsed.include_symbols
      ? db.prepare(
          `SELECT s.name${includeLocations ? ", s.kind, s.line" : ""}
           FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE s.project_id = ? AND f.path = ?
           ORDER BY COALESCE(s.line, 2147483647), s.id
           LIMIT ?`,
        )
      : null;

    const files: ClaimGraphFile[] = [];
    const seenEdgeKeys = new Set<string>();
    const aggregatedEdges: Array<{ kind: string; from: string; to: string; label?: string }> = [];

    for (const targetPath of targetPaths) {
      const fileEdges = graphNeighbors(db, projectId, targetPath, parsed.limit, parsed.depth);
      for (const edge of fileEdges) {
        if (aggregatedEdges.length >= parsed.limit) break;
        const key = `${edge.kind}\0${edge.from}\0${edge.to}\0${edge.label ?? ""}`;
        if (seenEdgeKeys.has(key)) continue;
        seenEdgeKeys.add(key);
        aggregatedEdges.push(edge);
      }

      if (symbolStmt) {
        // Project sampling may miss this target or skip an unregistered root.
        const target = claimTargetStmt?.get(projectId, targetPath) as ClaimTargetRow | undefined;
        const targetCurrent =
          target !== undefined &&
          rootDirs !== undefined &&
          isCurrentClaimTarget(targetPath, target, rootDirs);
        const symbolLimit = targetCurrent ? MAX_INDEXED_FILE_SYMBOLS : MAX_NEIGHBOR_FILE_SYMBOLS;
        const symRows = symbolStmt.all(projectId, targetPath, symbolLimit) as NeighborSymbolRow[];
        const locations = targetCurrent ? prioritizeSymbolLocations(symRows) : undefined;
        files.push({
          path: targetPath,
          edges: fileEdges,
          symbols: symRows.slice(0, MAX_NEIGHBOR_FILE_SYMBOLS).map((row) => row.name),
          ...(locations ? { symbol_locations: locations } : {}),
        });
      } else {
        files.push({
          path: targetPath,
          edges: fileEdges,
        });
      }
    }

    const singlePath = parsed.path ?? (targetPaths.length === 1 ? targetPaths[0] : undefined);

    return {
      ...(singlePath !== undefined ? { path: singlePath } : {}),
      edges: aggregatedEdges,
      files,
      ...(freshness?.stale
        ? { stale: true, ...(freshness.reason ? { stale_reason: freshness.reason } : {}) }
        : {}),
    };
  });
}

export function symbolSearch(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  query: string,
  limit: number,
): Array<{ name: string; kind: string; path: string; line?: number }> {
  return withDatabase(dbOrPath, (db) => {
    const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const rows = db
      .prepare(
        `SELECT s.name, s.kind, s.line, f.path
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE s.project_id = ? AND s.name LIKE ? ESCAPE '\\'
         ORDER BY s.name
         LIMIT ?`,
      )
      .all(projectId, `%${escaped}%`, limit) as Array<{
      name: string;
      kind: string;
      line: number | null;
      path: string;
    }>;
    return rows.map((row) => ({
      name: row.name,
      kind: row.kind,
      path: row.path,
      ...(row.line != null ? { line: row.line } : {}),
    }));
  });
}

export type GraphFreshnessResult = {
  stale: boolean;
  reason?: string;
  checked_files?: number;
};

const MAX_FRESHNESS_CHECK_FILES = 100;
const MAX_UNINDEXED_SCAN_DIRS = 64;
const MAX_UNINDEXED_SCAN_ENTRIES = 256;

function hasAnyCodeFileBounded(absDir: string): boolean {
  let realRoot: string;
  try {
    const rootStat = lstatSync(absDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    realRoot = realpathSync(absDir);
  } catch {
    return false;
  }

  const queue: string[] = [realRoot];
  const visited = new Set<string>([realRoot]);
  let dirsChecked = 0;
  let entriesChecked = 0;

  while (queue.length > 0 && dirsChecked < MAX_UNINDEXED_SCAN_DIRS) {
    const dir = queue.shift();
    if (!dir) break;
    dirsChecked++;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entriesChecked >= MAX_UNINDEXED_SCAN_ENTRIES) return false;
      entriesChecked++;
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || DEFAULT_SKIP_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);
      try {
        const lst = lstatSync(full);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) {
          const realChild = realpathSync(full);
          if (isWithinRoot(realRoot, realChild) && !visited.has(realChild)) {
            visited.add(realChild);
            queue.push(realChild);
          }
          continue;
        }
        if (lst.isFile() && CODE_EXT.has(extname(entry.name).toLowerCase())) {
          const realFile = realpathSync(full);
          if (isWithinRoot(realRoot, realFile)) return true;
        }
      } catch {
        // Ignore transient or unreadable entries
      }
    }
  }

  return false;
}

export function checkGraphFreshness(
  dbOrPath: DatabaseSync | string,
  projectId: string,
  rootDirs: Array<{ rootId: string | null; dir: string }>,
): GraphFreshnessResult {
  return withDatabase(dbOrPath, (db) => {
    const totalFiles = (
      db.prepare("SELECT COUNT(*) AS c FROM files WHERE project_id = ?").get(projectId) as {
        c: number;
      }
    ).c;

    if (totalFiles === 0) {
      for (const rootDir of rootDirs) {
        if (hasAnyCodeFileBounded(resolve(rootDir.dir))) {
          return { stale: true, reason: "not_indexed", checked_files: 0 };
        }
      }
      return { stale: false, checked_files: 0 };
    }

    if (!isGraphParserCurrent(db, projectId)) {
      return { stale: true, reason: "parser_version", checked_files: 0 };
    }

    const rootById = new Map<string | null, { absDir: string; realDir: string }>();
    for (const rootDir of rootDirs) {
      const absDir = resolve(rootDir.dir);
      const realDir = safeRealpathSync(absDir);
      rootById.set(rootDir.rootId, { absDir, realDir });
    }

    type FreshnessRow = {
      id: number;
      root_id: string | null;
      path: string;
      mtime_ms: number | null;
    };

    let sampleRows: FreshnessRow[];
    if (totalFiles <= MAX_FRESHNESS_CHECK_FILES) {
      sampleRows = db
        .prepare(
          "SELECT id, root_id, path, mtime_ms FROM files WHERE project_id = ? ORDER BY id LIMIT ?",
        )
        .all(projectId, MAX_FRESHNESS_CHECK_FILES) as FreshnessRow[];
    } else {
      const half = Math.floor(MAX_FRESHNESS_CHECK_FILES / 2);
      const recentRows = db
        .prepare(
          "SELECT id, root_id, path, mtime_ms FROM files WHERE project_id = ? ORDER BY COALESCE(mtime_ms, 0) DESC, id ASC LIMIT ?",
        )
        .all(projectId, half) as FreshnessRow[];
      const spreadRows = db
        .prepare(
          "SELECT id, root_id, path, mtime_ms FROM files WHERE project_id = ? ORDER BY COALESCE(hash, ''), id ASC LIMIT ?",
        )
        .all(projectId, MAX_FRESHNESS_CHECK_FILES) as FreshnessRow[];
      const byId = new Map<number, FreshnessRow>();
      for (const row of recentRows) byId.set(row.id, row);
      for (const row of spreadRows) {
        if (byId.size >= MAX_FRESHNESS_CHECK_FILES) break;
        if (!byId.has(row.id)) byId.set(row.id, row);
      }
      sampleRows = [...byId.values()];
    }

    let checked = 0;
    for (const row of sampleRows) {
      const rootEntry = rootById.get(row.root_id);
      if (!rootEntry) continue;

      let relInRoot = row.path;
      if (row.root_id !== null && relInRoot.startsWith("@")) {
        const slashIdx = relInRoot.indexOf("/");
        if (slashIdx !== -1) relInRoot = relInRoot.slice(slashIdx + 1);
      }

      const candidate = resolve(rootEntry.absDir, relInRoot);
      if (!toRelInsideRoot(rootEntry.absDir, candidate)) continue;

      checked++;
      let diskMtimeMs: number;
      try {
        const lst = lstatSync(candidate);
        if (lst.isSymbolicLink() || !lst.isFile()) {
          return { stale: true, reason: "missing_files", checked_files: checked };
        }
        const realCandidate = realpathSync(candidate);
        if (!isWithinRoot(rootEntry.realDir, realCandidate)) {
          return { stale: true, reason: "missing_files", checked_files: checked };
        }
        diskMtimeMs = Math.floor(lst.mtimeMs);
      } catch {
        return { stale: true, reason: "missing_files", checked_files: checked };
      }

      if (row.mtime_ms === null || diskMtimeMs !== row.mtime_ms) {
        return { stale: true, reason: "modified_files", checked_files: checked };
      }
    }

    return { stale: false, checked_files: checked };
  });
}

export type GraphFastPathState = {
  indexed_files: number;
  stale: boolean;
  reason?: string;
};

export function getGraphIndexFastPathState(
  dbPath: string,
  projectId: string,
  rootDirs: Array<{ rootId: string | null; dir: string }>,
): GraphFastPathState {
  return withDatabase(dbPath, (db) => {
    const indexed_files = (
      db.prepare("SELECT COUNT(*) AS c FROM files WHERE project_id = ?").get(projectId) as {
        c: number;
      }
    ).c;

    const freshness = checkGraphFreshness(db, projectId, rootDirs);
    return {
      indexed_files,
      stale: freshness.stale,
      ...(freshness.reason ? { reason: freshness.reason } : {}),
    };
  });
}
