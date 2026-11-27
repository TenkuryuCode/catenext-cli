/**
 * Workspace, tsconfig, and polyglot import resolution for the Catenext code graph.
 */

import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SKIP_DIRS,
  isSafeRegularFileSync,
  isWithinRoot,
} from "../workspace-walk.js";
import { SFC_EXT, TS_JS_EXT } from "./graph-parser.js";

const MAX_GO_PACKAGE_FILES = 32;
const MAX_TSCONFIG_REF_DEPTH = 8;
const MAX_TSCONFIG_FILES = 64;

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

/**
 * Resolves a filesystem path to its realpath, falling back to `path.resolve` if unreadable.
 */
export function safeRealpathSync(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
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

export function toRelInsideRoot(absRoot: string, candidate: string): string | null {
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

/**
 * Loads PHP PSR-4 autoload mappings from `composer.json` within `root`.
 */
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

/**
 * Loads the Go module path from `go.mod` within `root`, if present.
 */
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

/**
 * Resolves a Go import specifier against `goModule` within `realRoot`.
 */
export function resolveGoImport(
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

/**
 * Discovers workspace package entries from `pnpm-workspace.yaml`, `package.json`, and `apps/*`/`packages/*`.
 */
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

/**
 * Creates a reusable TypeScript/workspace resolution context for `root`.
 */
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

/**
 * Resolves a relative or project-local import specifier to a workspace-relative file path.
 */
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
