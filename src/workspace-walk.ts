import { type Dirent, lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const MAX_GITIGNORE_BYTES = 64 * 1024;

export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".catenext",
  "dist",
  "build",
  ".turbo",
  "coverage",
  "__pycache__",
  ".next",
  "target",
  ".venv",
  "venv",
  ".nuxt",
  "out",
]);

export type GitignoreRule = {
  baseRel: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
};

export type WalkedFile = {
  full: string;
  rel: string;
  ext: string;
  size: number;
  mtimeMs: number;
};

export type WalkWorkspaceOptions = {
  extensions?: ReadonlySet<string>;
  skipDirs?: ReadonlySet<string>;
  skipDotEntries?: boolean;
  maxFileBytes?: number;
  honorGitignore?: boolean;
};

export function isWithinRoot(realRoot: string, candidateRealPath: string): boolean {
  const rel = relative(realRoot, candidateRealPath);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function trimGitignoreTrailingSpaces(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === "\r") end -= 1;
  let trimmedEnd = end;
  while (trimmedEnd > 0 && raw[trimmedEnd - 1] === " ") {
    let backslashes = 0;
    for (let i = trimmedEnd - 2; i >= 0 && raw[i] === "\\"; i -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 1) break;
    trimmedEnd -= 1;
  }
  return raw.slice(0, trimmedEnd);
}

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function findCharClassEnd(pattern: string, start: number): number {
  let i = start;
  if (pattern[i] === "!" || pattern[i] === "^") i += 1;
  if (pattern[i] === "]") i += 1;
  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      i += 2;
      continue;
    }
    if (pattern[i] === "]") return i;
    i += 1;
  }
  return -1;
}

function globToRegexSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? "";
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next !== undefined) {
        out += escapeRegexChar(next);
        i += 2;
        continue;
      }
      out += "\\\\";
      i += 1;
      continue;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const prev = i > 0 ? pattern[i - 1] : "";
        const next = pattern[i + 2];
        if ((i === 0 || prev === "/") && next === "/") {
          out += "(?:.+/)?";
          i += 3;
          continue;
        }
        if ((i === 0 || prev === "/") && next === undefined) {
          out += ".*";
          i += 2;
          continue;
        }
        out += "[^/]*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const close = findCharClassEnd(pattern, i + 1);
      if (close !== -1) {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body}]`;
        i = close + 1;
        continue;
      }
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  return out;
}

export function parseGitignore(content: string, baseRel = ""): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  const normalizedBase = baseRel.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = trimGitignoreTrailingSpaces(rawLine);
    if (!line || line.startsWith("#")) continue;

    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    } else if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
      pattern = pattern.slice(1);
    }
    if (!pattern) continue;

    let dirOnly = false;
    if (pattern.endsWith("/") && !pattern.endsWith("\\/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (!pattern) continue;

    const startsWithSlash = pattern.startsWith("/");
    if (startsWithSlash) pattern = pattern.slice(1);
    if (!pattern) continue;

    const anchored = startsWithSlash || pattern.includes("/");
    const regexSource = globToRegexSource(pattern);
    try {
      rules.push({
        baseRel: normalizedBase,
        negated,
        dirOnly,
        anchored,
        regex: new RegExp(`^${regexSource}$`),
      });
    } catch {
      // Ignore malformed patterns in user .gitignore rather than crashing indexing.
    }
  }
  return rules;
}

export function isGitignored(
  relPath: string,
  isDir: boolean,
  rules: readonly GitignoreRule[],
): boolean {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || rules.length === 0) return false;

  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    let relFromBase: string;
    if (!rule.baseRel) {
      relFromBase = normalized;
    } else if (normalized.startsWith(`${rule.baseRel}/`)) {
      relFromBase = normalized.slice(rule.baseRel.length + 1);
    } else {
      continue;
    }
    if (!relFromBase) continue;

    const target = rule.anchored ? relFromBase : (relFromBase.split("/").pop() ?? relFromBase);
    if (rule.regex.test(target)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

export async function readBoundedUtf8File(
  filePath: string,
  realRoot: string,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<string | null> {
  let lst: Stats;
  try {
    lst = await lstat(filePath);
  } catch {
    return null;
  }
  if (lst.isSymbolicLink() || !lst.isFile() || lst.size > maxFileBytes) {
    return null;
  }
  let realFile: string;
  try {
    realFile = await realpath(filePath);
  } catch {
    return null;
  }
  if (!isWithinRoot(realRoot, realFile)) {
    return null;
  }
  try {
    const content = await readFile(filePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
      return null;
    }
    return content;
  } catch {
    return null;
  }
}

export function isSafeRegularFileSync(realRoot: string, filePath: string): boolean {
  try {
    const lst = lstatSync(filePath);
    if (lst.isSymbolicLink() || !lst.isFile()) return false;
    const realFile = realpathSync(filePath);
    return isWithinRoot(realRoot, realFile);
  } catch {
    return false;
  }
}

export async function walkWorkspaceFiles(
  root: string,
  options: WalkWorkspaceOptions = {},
): Promise<{ realRoot: string; files: WalkedFile[] }> {
  const extensions = options.extensions;
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const skipDotEntries = options.skipDotEntries ?? false;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const honorGitignore = options.honorGitignore ?? true;

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { realRoot: root, files: [] };
  }

  const visitedDirs = new Set<string>([realRoot]);
  const files: WalkedFile[] = [];

  async function visit(
    dir: string,
    relDir: string,
    inheritedRules: GitignoreRule[],
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    let activeRules = inheritedRules;
    if (honorGitignore) {
      const gitignorePath = join(dir, ".gitignore");
      const rawIgnore = await readBoundedUtf8File(gitignorePath, realRoot, MAX_GITIGNORE_BYTES);
      if (rawIgnore !== null) {
        const parsed = parseGitignore(rawIgnore, relDir);
        if (parsed.length > 0) {
          activeRules = [...inheritedRules, ...parsed];
        }
      }
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (skipDotEntries && entry.name.startsWith(".")) continue;
      if (skipDirs.has(entry.name)) continue;

      const full = join(dir, entry.name);
      let lst: Stats;
      try {
        lst = await lstat(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) continue;

      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (lst.isDirectory()) {
        if (honorGitignore && isGitignored(rel, true, activeRules)) {
          continue;
        }
        let realChildDir: string;
        try {
          realChildDir = await realpath(full);
        } catch {
          continue;
        }
        if (!isWithinRoot(realRoot, realChildDir) || visitedDirs.has(realChildDir)) {
          continue;
        }
        visitedDirs.add(realChildDir);
        await visit(full, rel, activeRules);
        continue;
      }

      if (!lst.isFile()) continue;
      if (lst.size > maxFileBytes) continue;
      if (honorGitignore && isGitignored(rel, false, activeRules)) continue;

      const ext = extname(entry.name).toLowerCase();
      if (extensions && !extensions.has(ext)) continue;

      let realFile: string;
      try {
        realFile = await realpath(full);
      } catch {
        continue;
      }
      if (!isWithinRoot(realRoot, realFile)) continue;

      files.push({
        full,
        rel,
        ext,
        size: lst.size,
        mtimeMs: Math.floor(lst.mtimeMs),
      });
    }
  }

  await visit(realRoot, "", []);
  return { realRoot, files };
}
