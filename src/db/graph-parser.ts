/**
 * Multi-language import and symbol parsing for the Catenext code graph.
 */

export const MAX_INDEXED_FILE_SYMBOLS = 80;

export const CODE_EXT = new Set([
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

export const TS_JS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
export const SFC_EXT = new Set([".vue", ".svelte"]);

const TS_JS_SYMBOL_PATTERNS: Array<[RegExp, string]> = [
  [
    /^(?:\s*export\s+(?:default\s+)?|(?=\S))(?:declare\s+)?(?:async\s+)?function\s+([A-Za-z_][\w$]*)/,
    "function",
  ],
  [
    /^(?:\s*export\s+(?:default\s+)?|(?=\S))(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w$]*)/,
    "class",
  ],
  [/^(?:\s*export\s+|(?=\S))(?:declare\s+)?interface\s+([A-Za-z_][\w$]*)/, "interface"],
  [/^(?:\s*export\s+|(?=\S))(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_][\w$]*)/, "enum"],
  [/^(?:\s*export\s+|(?=\S))(?:declare\s+)?type\s+([A-Za-z_][\w$]*)\b(?:\s*<.*>)?\s*=/, "type"],
  [
    /^(?:\s*export\s+|(?=\S))(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_][\w$]*)\s*(?::[^=]+)?=/,
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

/**
 * Extracts `<script>` blocks from Vue/Svelte SFC files with 1-based starting line offsets.
 */
export function extractSfcScriptBlocks(
  content: string,
): Array<{ code: string; startLine: number }> {
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

export type TsJsImportEntry = {
  spec: string;
  kind: "imports" | "reexport";
};

const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "default",
  "delete",
  "void",
  "typeof",
  "in",
  "instanceof",
  "new",
  "yield",
  "await",
  "of",
  "else",
  "do",
  "export",
]);

function canPrecedeRegexLiteral(out: string): boolean {
  let k = out.length - 1;
  while (k >= 0 && (out[k] === " " || out[k] === "\t" || out[k] === "\n" || out[k] === "\r")) {
    k--;
  }
  if (k < 0) return true;
  const ch = out[k] ?? "";
  if (ch === "+" || ch === "-") {
    return out[k - 1] !== ch;
  }
  if (ch === ">") {
    return out[k - 1] === "=";
  }
  if ("({[;,:=!?&|^~*%}".includes(ch)) {
    return true;
  }
  if (/[A-Za-z0-9_$]/.test(ch)) {
    let start = k;
    while (start > 0 && /[A-Za-z0-9_$]/.test(out[start - 1] ?? "")) {
      start--;
    }
    if (start > 0 && out[start - 1] === ".") return false;
    return REGEX_PREFIX_KEYWORDS.has(out.slice(start, k + 1));
  }
  return false;
}

function findRegexLiteralEnd(content: string, startSlash: number): number {
  let j = startSlash + 1;
  let inClass = false;
  while (j < content.length) {
    const rc = content[j] ?? "";
    if (rc === "\n" || rc === "\r") return -1;
    if (rc === "\\") {
      if (j + 1 >= content.length) return -1;
      const escaped = content[j + 1] ?? "";
      if (escaped === "\n" || escaped === "\r") return -1;
      j += 2;
      continue;
    }
    if (rc === "[" && !inClass) {
      inClass = true;
      j++;
      continue;
    }
    if (rc === "]" && inClass) {
      inClass = false;
      j++;
      continue;
    }
    if (rc === "/" && !inClass) {
      return j;
    }
    j++;
  }
  return -1;
}

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
      const endIdx = closeIdx !== -1 ? closeIdx + 2 : content.length;
      for (let j = i; j < endIdx; j++) {
        out += content[j] === "\n" ? "\n" : " ";
      }
      i = endIdx;
      continue;
    }
    if (ch === "/" && canPrecedeRegexLiteral(out)) {
      const endSlash = findRegexLiteralEnd(content, i);
      if (endSlash !== -1) {
        out += `/${" ".repeat(endSlash - i - 1)}/`;
        i = endSlash + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extracts TS/JS import and re-export entries, preserving whether each specifier is an import or re-export.
 */
export function parseTsJsImportEntries(
  content: string,
  includeNonRelative = false,
): TsJsImportEntry[] {
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

  const callRe = /(?<![.\w$])(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
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

/**
 * Parses import specifiers from source content for supported languages.
 */
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

function parseTsJsReexportSymbolsFromCleaned(
  cleaned: string,
  lineOffset = 0,
): Array<{ name: string; kind: string; line: number }> {
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
  const cleaned = maskTsJsComments(content);
  const symbols: Array<{ name: string; kind: string; line: number }> = [];
  const lines = cleaned.split(/\r?\n/);
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
  symbols.push(...parseTsJsReexportSymbolsFromCleaned(cleaned, lineOffset));
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

/**
 * Extracts top-level symbol declarations and TS/JS barrel re-exports from source content.
 */
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
    symbols.push(...parseTsJsReexportSymbolsFromCleaned(maskTsJsComments(content), 0));
    symbols.sort((a, b) => a.line - b.line);
  }
  return symbols.slice(0, MAX_INDEXED_FILE_SYMBOLS);
}
