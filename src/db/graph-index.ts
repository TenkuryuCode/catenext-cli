import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
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

function parseTsJsImports(content: string): string[] {
  const hits: string[] = [];
  const re =
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']|(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(re)) {
    const spec = match[1] ?? match[2];
    if (spec?.startsWith(".")) hits.push(spec);
  }
  return [...new Set(hits)];
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

export function parseImports(content: string, ext?: string): string[] {
  const normalizedExt = ext?.toLowerCase();
  if (normalizedExt && SFC_EXT.has(normalizedExt)) {
    const hits: string[] = [];
    for (const block of extractSfcScriptBlocks(content)) {
      hits.push(...parseTsJsImports(block.code));
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
  return parseTsJsImports(content);
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
      const lines = block.code.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const [re, kind] of TS_JS_SYMBOL_PATTERNS) {
          const match = line.match(re);
          if (match?.[1]) {
            symbols.push({ name: match[1], kind, line: block.startLine + i });
            break;
          }
        }
        if (symbols.length >= 80) return symbols.slice(0, 80);
      }
    }
    return symbols.slice(0, 80);
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
  return symbols.slice(0, 80);
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

export function resolveImport(
  fromFile: string,
  spec: string,
  root: string,
  knownFiles?: ReadonlySet<string>,
  psr4Entries?: readonly ComposerPsr4Entry[],
  goModule?: string | null,
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
    const entryByRel = new Map(entries.map((entry) => [entry.rel, entry]));

    const existingRows = db
      .prepare("SELECT id, root_id, path, hash, mtime_ms FROM files WHERE project_id = ?")
      .all(projectId) as ExistingFileRow[];
    const existingByPath = new Map(existingRows.map((row) => [row.path, row]));

    const deletedIds: number[] = [];
    for (const row of existingRows) {
      if (!knownFiles.has(row.path)) deletedIds.push(row.id);
    }

    const edgeRefreshPaths = new Set<string>();
    if (deletedIds.length > 0) {
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

    const addedCount = entries.filter((entry) => !existingByPath.has(entry.rel)).length;
    if (addedCount > 0) {
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
    const newFiles: Array<{
      rootId: string | null;
      rel: string;
      hash: string;
      mtimeMs: number;
      symbols: Array<{ name: string; kind: string; line: number }>;
      imports: string[];
    }> = [];
    const modifiedFiles: Array<{
      id: number;
      rootId: string | null;
      rel: string;
      hash: string;
      mtimeMs: number;
      symbols: Array<{ name: string; kind: string; line: number }>;
      imports: string[];
    }> = [];
    const refreshedEdges: Array<{ id: number; rel: string; imports: string[] }> = [];

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

    const resolveImportsForEntry = (entry: WalkedEntry, content: string): string[] => {
      const rootKnown = knownFilesByRoot.get(entry.rootId);
      const psr4 = entry.ext === ".php" ? getPsr4ForRoot(entry.realRoot) : undefined;
      const goMod = entry.ext === ".go" ? getGoModuleForRoot(entry.realRoot) : undefined;
      const resolvedTargets: string[] = [];
      for (const spec of parseImports(content, entry.ext)) {
        if (entry.ext === ".go") {
          for (const target of resolveGoImport(
            spec,
            entry.realRoot,
            entry.realRoot,
            goMod ?? null,
            rootKnown,
          )) {
            if (target !== entry.relInRoot) {
              resolvedTargets.push(entry.prefix ? `${entry.prefix}/${target}` : target);
            }
          }
          continue;
        }
        const to = resolveImport(entry.full, spec, entry.realRoot, rootKnown, psr4, goMod);
        if (to && to !== entry.relInRoot) {
          resolvedTargets.push(entry.prefix ? `${entry.prefix}/${to}` : to);
        }
      }
      return [...new Set(resolvedTargets)];
    };

    for (const entry of entries) {
      const existing = existingByPath.get(entry.rel);
      if (existing && existing.mtime_ms === entry.mtimeMs && existing.root_id === entry.rootId) {
        idByPath.set(entry.rel, existing.id);
        continue;
      }

      const content = await readBoundedUtf8File(entry.full, entry.realRoot, maxFileBytes);
      if (content === null) {
        if (existing) deletedIds.push(existing.id);
        continue;
      }
      const contentHash = hash(content);
      if (existing && existing.hash === contentHash) {
        idByPath.set(entry.rel, existing.id);
        mtimeOnlyUpdates.push({ id: existing.id, rootId: entry.rootId, mtimeMs: entry.mtimeMs });
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

    const changedRels = new Set([
      ...newFiles.map((f) => f.rel),
      ...modifiedFiles.map((f) => f.rel),
    ]);
    for (const rel of edgeRefreshPaths) {
      if (changedRels.has(rel)) continue;
      const existing = existingByPath.get(rel);
      const entry = entryByRel.get(rel);
      if (!existing || !entry) continue;
      const content = await readBoundedUtf8File(entry.full, entry.realRoot, maxFileBytes);
      if (content === null) continue;
      const imports = resolveImportsForEntry(entry, content);
      refreshedEdges.push({ id: existing.id, rel, imports });
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

      const pendingEdges: Array<{ fromId: number; to: string }> = [];

      for (const item of newFiles) {
        const row = insertFile.get(projectId, item.rootId, item.rel, item.hash, item.mtimeMs) as {
          id: number;
        };
        idByPath.set(item.rel, row.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, row.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const to of item.imports) pendingEdges.push({ fromId: row.id, to });
      }

      for (const item of modifiedFiles) {
        updateFile.run(item.rootId, item.hash, item.mtimeMs, item.id);
        deleteSymbolsForFile.run(projectId, item.id);
        deleteEdgesForFile.run(projectId, item.id);
        for (const symbol of item.symbols) {
          insertSymbol.run(projectId, item.id, symbol.name, symbol.kind, symbol.line);
        }
        for (const to of item.imports) pendingEdges.push({ fromId: item.id, to });
      }

      for (const item of refreshedEdges) {
        deleteEdgesForFile.run(projectId, item.id);
        for (const to of item.imports) pendingEdges.push({ fromId: item.id, to });
      }

      for (const edge of pendingEdges) {
        const toId = idByPath.get(edge.to);
        insertEdge.run(projectId, "imports", edge.fromId, toId ?? null, edge.to);
      }

      db.exec(useSavepoint ? "RELEASE SAVEPOINT graph_index" : "COMMIT");
    } catch (error) {
      db.exec(
        useSavepoint
          ? "ROLLBACK TO SAVEPOINT graph_index; RELEASE SAVEPOINT graph_index"
          : "ROLLBACK",
      );
      throw error;
    }

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
  });
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
