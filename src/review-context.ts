import { execFile, execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import {
  briefText,
  REVIEW_CONTEXT_PACK_MAX_BYTES,
  type ReviewChangedFile,
  type ReviewContextPack,
  ReviewContextPackSchema,
  type ReviewDetailPointers,
  type ReviewDiffMeta,
  type ReviewResult,
  type ReviewScopeDrift,
} from "@catenext/shared";
import type { LocalProject, LocalReview, LocalTask } from "./local-state.js";
import { scrubText } from "./scrubber.js";
import { isWithinRoot } from "./workspace-walk.js";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_CHANGED_FILES = 15;
const COMPACT_MAX_CHANGED_FILES = 5;
const DEFAULT_MAX_DECISIONS = 5;
const COMPACT_MAX_DECISIONS = 3;
const DEFAULT_EXCERPT_LIMIT = 600;
const COMPACT_EXCERPT_LIMIT = 240;
export const REVIEW_DIFF_CACHE_MAX_ENTRIES = 64;

const HEX_SHA_RE = /^[0-9a-f]{7,64}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40,64}$/i;

interface CachedRawGitDiff {
  realRoot: string;
  baseBranch: string;
  baseRef: string;
  rawFiles: readonly ReviewChangedFile[];
  additions: number;
  deletions: number;
}

const reviewDiffCache = new Map<string, CachedRawGitDiff>();

export function clearReviewContextCache(): void {
  reviewDiffCache.clear();
}

export function getReviewContextCacheSize(): number {
  return reviewDiffCache.size;
}

function makeDiffCacheKey(taskId: string, headSha: string): string {
  return `${taskId}\0${headSha.toLowerCase()}`;
}

function getCachedRawDiff(
  taskId: string | undefined,
  headSha: string,
  realRoot: string,
  baseBranch: string,
): CachedRawGitDiff | undefined {
  if (!taskId) return undefined;
  const key = makeDiffCacheKey(taskId, headSha);
  const entry = reviewDiffCache.get(key);
  if (!entry) return undefined;
  if (entry.realRoot !== realRoot || entry.baseBranch !== baseBranch) {
    reviewDiffCache.delete(key);
    return undefined;
  }
  // Refresh LRU order.
  reviewDiffCache.delete(key);
  reviewDiffCache.set(key, entry);
  return entry;
}

function setCachedRawDiff(
  taskId: string | undefined,
  headSha: string,
  entry: CachedRawGitDiff,
): void {
  if (!taskId) return;
  const key = makeDiffCacheKey(taskId, headSha);
  if (reviewDiffCache.has(key)) {
    reviewDiffCache.delete(key);
  } else if (reviewDiffCache.size >= REVIEW_DIFF_CACHE_MAX_ENTRIES) {
    const oldest = reviewDiffCache.keys().next().value;
    if (oldest !== undefined) reviewDiffCache.delete(oldest);
  }
  reviewDiffCache.set(key, entry);
}

type UnsizedReviewContextPack = Omit<ReviewContextPack, "byte_length">;

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function globToRegExp(globPattern: string): RegExp {
  let regex = "^";
  for (let i = 0; i < globPattern.length; i += 1) {
    const ch = globPattern[i] ?? "";
    if (ch === "*") {
      if (globPattern[i + 1] === "*") {
        if (globPattern[i + 2] === "/") {
          regex += "(?:.+/)?";
          i += 2;
        } else {
          regex += ".*";
          i += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

export function matchesScopePattern(filePath: string, scopeEntry: string): boolean {
  const file = normalizePath(filePath);
  const scope = normalizePath(scopeEntry);
  if (!file || !scope) return false;
  if (scope.includes("*") || scope.includes("?")) {
    return globToRegExp(scope).test(file);
  }
  return file === scope || file.startsWith(`${scope}/`);
}

export function evaluateScopeDrift(
  changedPaths: readonly string[],
  scopeFiles?: readonly string[],
): ReviewScopeDrift | undefined {
  if (!scopeFiles || scopeFiles.length === 0) return undefined;
  const uniqueChanged = [...new Set(changedPaths.map(normalizePath).filter(Boolean))];
  const inScopeFiles: string[] = [];
  const outOfScopeFiles: string[] = [];

  for (const file of uniqueChanged) {
    if (scopeFiles.some((scope) => matchesScopePattern(file, scope))) {
      inScopeFiles.push(file);
    } else {
      outOfScopeFiles.push(file);
    }
  }

  const untouchedScopeFiles = scopeFiles.filter(
    (scope) => !uniqueChanged.some((file) => matchesScopePattern(file, scope)),
  );

  return {
    scope_files: [...scopeFiles],
    in_scope_files: inScopeFiles,
    out_of_scope_files: outOfScopeFiles,
    untouched_scope_files: untouchedScopeFiles,
    drift_detected: outOfScopeFiles.length > 0,
  };
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

function gitBaseArgs(args: readonly string[]): string[] {
  return [
    "--no-optional-locks",
    "--no-replace-objects",
    "-c",
    `core.hooksPath=${devNull}`,
    ...args,
  ];
}

function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false;
  if (ref.startsWith("-") || ref.includes("..") || ref.includes("@{")) return false;
  return !/[\0\r\n\s~^:?*[\\]/.test(ref);
}

function isValidHeadSha(sha: string): boolean {
  return HEX_SHA_RE.test(sha);
}

function resolveGitRootSync(repoRoot: string): string | null {
  try {
    const realRoot = realpathSync(repoRoot);
    return statSync(realRoot).isDirectory() ? realRoot : null;
  } catch {
    return null;
  }
}

async function resolveGitRootAsync(repoRoot: string): Promise<string | null> {
  try {
    const realRoot = await realpath(repoRoot);
    return (await stat(realRoot)).isDirectory() ? realRoot : null;
  } catch {
    return null;
  }
}

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

function hasControlChar(value: string): boolean {
  return Array.from(value).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function sanitizeSafeRepoRelPath(rawPath: string): string | null {
  if (!rawPath || hasControlChar(rawPath)) return null;
  if (isAbsolute(rawPath) || WINDOWS_DRIVE_RE.test(rawPath)) return null;
  if (rawPath.startsWith("/") || rawPath.startsWith("\\")) return null;
  const normalized = normalizePath(rawPath).replace(/^(?:\.\/)+/, "");
  if (!normalized || normalized === ".") return null;
  if (WINDOWS_DRIVE_RE.test(normalized) || normalized.startsWith("/")) return null;
  const segments = normalized.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return normalized;
}

function isSafeRepoRelPath(realRoot: string, rawPath: string): string | null {
  const normalized = sanitizeSafeRepoRelPath(rawPath);
  if (!normalized) return null;
  const resolved = resolve(realRoot, normalized);
  return isWithinRoot(realRoot, resolved) ? normalized : null;
}

function runGitReadOnly(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", gitBaseArgs(args), {
      cwd,
      env: cleanGitEnv(),
      encoding: "utf8",
      timeout: 1500,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

async function runGitReadOnlyAsync(cwd: string, args: string[]): Promise<string | null> {
  try {
    const child = execFileAsync("git", gitBaseArgs(args), {
      cwd,
      env: cleanGitEnv(),
      encoding: "utf8",
      timeout: 1500,
      maxBuffer: 1024 * 1024,
    });
    child.child.stdin?.end();
    const { stdout } = await child;
    return stdout;
  } catch {
    return null;
  }
}

function isSameCommitSha(sha: string, headSha: string): boolean {
  return sha === headSha || sha.toLowerCase().startsWith(headSha.toLowerCase());
}

function resolveGitMergeBase(realRoot: string, baseBranch: string, headSha: string): string | null {
  if (!isSafeGitRef(baseBranch) || !isValidHeadSha(headSha)) return null;
  const localRef = `refs/heads/${baseBranch}`;
  const originRef = `refs/remotes/origin/${baseBranch}`;

  for (const ref of [localRef, originRef, baseBranch]) {
    const out = runGitReadOnly(realRoot, ["merge-base", "--end-of-options", ref, headSha]);
    const sha = out?.trim();
    if (!sha || !FULL_SHA_RE.test(sha)) continue;
    if (!isSameCommitSha(sha, headSha)) return sha;
    if (ref === localRef) {
      // Local baseBranch already resolved to headSha; bare baseBranch would resolve identically.
      // Only check origin/<baseBranch> in case local baseBranch has unpushed commits.
      const originOut = runGitReadOnly(realRoot, [
        "merge-base",
        "--end-of-options",
        originRef,
        headSha,
      ]);
      const originSha = originOut?.trim();
      if (originSha && FULL_SHA_RE.test(originSha) && !isSameCommitSha(originSha, headSha)) {
        return originSha;
      }
      return null;
    }
  }
  return null;
}

async function resolveGitMergeBaseAsync(
  realRoot: string,
  baseBranch: string,
  headSha: string,
): Promise<string | null> {
  if (!isSafeGitRef(baseBranch) || !isValidHeadSha(headSha)) return null;
  const localRef = `refs/heads/${baseBranch}`;
  const originRef = `refs/remotes/origin/${baseBranch}`;

  for (const ref of [localRef, originRef, baseBranch]) {
    const out = await runGitReadOnlyAsync(realRoot, [
      "merge-base",
      "--end-of-options",
      ref,
      headSha,
    ]);
    const sha = out?.trim();
    if (!sha || !FULL_SHA_RE.test(sha)) continue;
    if (!isSameCommitSha(sha, headSha)) return sha;
    if (ref === localRef) {
      const originOut = await runGitReadOnlyAsync(realRoot, [
        "merge-base",
        "--end-of-options",
        originRef,
        headSha,
      ]);
      const originSha = originOut?.trim();
      if (originSha && FULL_SHA_RE.test(originSha) && !isSameCommitSha(originSha, headSha)) {
        return originSha;
      }
      return null;
    }
  }
  return null;
}

function buildGitDiffArgs(mergeBase: string | null, headSha: string): string[] {
  return mergeBase
    ? [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--raw",
        "--numstat",
        "-z",
        "-M",
        "--end-of-options",
        mergeBase,
        headSha,
        "--",
      ]
    : [
        "diff-tree",
        "--no-commit-id",
        "-r",
        "--root",
        "--no-ext-diff",
        "--no-textconv",
        "--raw",
        "--numstat",
        "-z",
        "-M",
        "--end-of-options",
        headSha,
        "--",
      ];
}

function statusFromGitCode(code: string): ReviewChangedFile["status"] {
  const letter = code[0]?.toUpperCase();
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "T":
      return "typechange";
    default:
      return "modified";
  }
}

function parseGitDiffZ(
  combinedOut: string,
  realRoot?: string,
): {
  files: ReviewChangedFile[];
  additions: number;
  deletions: number;
} {
  const statusByPath = new Map<
    string,
    { status: ReviewChangedFile["status"]; previous_path?: string }
  >();
  const files: ReviewChangedFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  const tokens = combinedOut.split("\0");
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i];
    if (!token) {
      i += 1;
      continue;
    }

    if (token.startsWith(":")) {
      const lastSpace = token.lastIndexOf(" ");
      const statusCode = lastSpace === -1 ? "" : token.slice(lastSpace + 1).trim();
      const status = statusFromGitCode(statusCode);
      if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
        const oldPath = tokens[i + 1];
        const newPath = tokens[i + 2];
        i += 3;
        if (newPath) {
          statusByPath.set(newPath, {
            status,
            ...(oldPath ? { previous_path: oldPath } : {}),
          });
        }
      } else {
        const path = tokens[i + 1];
        i += 2;
        if (path) statusByPath.set(path, { status });
      }
      continue;
    }

    const tab1 = token.indexOf("\t");
    if (tab1 === -1) {
      i += 1;
      continue;
    }
    const tab2 = token.indexOf("\t", tab1 + 1);
    if (tab2 === -1) {
      i += 1;
      continue;
    }
    const addRaw = token.slice(0, tab1).trim();
    const delRaw = token.slice(tab1 + 1, tab2).trim();
    const pathPart = token.slice(tab2 + 1);

    let filePath = pathPart;
    let previousPath: string | undefined;
    if (pathPart === "") {
      previousPath = tokens[i + 1];
      filePath = tokens[i + 2] ?? "";
      i += 3;
    } else {
      i += 1;
    }
    if (!filePath) continue;

    const statusInfo = statusByPath.get(filePath);
    const prevRaw = previousPath ?? statusInfo?.previous_path;
    const safePath = realRoot ? isSafeRepoRelPath(realRoot, filePath) : normalizePath(filePath);
    if (!safePath) continue;
    const safePrev = prevRaw
      ? realRoot
        ? isSafeRepoRelPath(realRoot, prevRaw)
        : normalizePath(prevRaw)
      : undefined;

    const binary = addRaw === "-" || delRaw === "-";
    const additions = binary ? 0 : Number.parseInt(addRaw, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(delRaw, 10) || 0;
    totalAdditions += additions;
    totalDeletions += deletions;

    files.push({
      path: safePath,
      status: statusInfo?.status ?? (safePrev ? "renamed" : "modified"),
      additions,
      deletions,
      ...(binary ? { binary: true } : {}),
      ...(safePrev ? { previous_path: safePrev } : {}),
    });
  }

  return { files, additions: totalAdditions, deletions: totalDeletions };
}

function finalizeScopedDiffMeta(options: {
  source: ReviewDiffMeta["source"];
  baseRef?: string;
  rawFiles: readonly ReviewChangedFile[];
  additions: number;
  deletions: number;
  handoffFiles: readonly string[];
  scopeFiles?: readonly string[];
  maxFiles: number;
}): ReviewDiffMeta {
  const { source, baseRef, handoffFiles, scopeFiles, maxFiles, additions, deletions } = options;
  let rawFiles = options.rawFiles.map((file) => ({ ...file }));

  const safeHandoffPaths = [
    ...new Set(
      handoffFiles
        .map(sanitizeSafeRepoRelPath)
        .filter((filePath): filePath is string => filePath !== null),
    ),
  ];

  if (source === "handoff_only") {
    rawFiles = safeHandoffPaths.map((path) => ({
      path,
      status: "handoff" as const,
      additions: 0,
      deletions: 0,
    }));
  }

  const allChangedPaths = rawFiles.length > 0 ? rawFiles.map((f) => f.path) : safeHandoffPaths;
  const scopeDrift = evaluateScopeDrift(allChangedPaths, scopeFiles);

  const annotatedFiles = rawFiles.map((file) => {
    if (!scopeFiles || scopeFiles.length === 0) return file;
    const inScope = scopeFiles.some((scope) => matchesScopePattern(file.path, scope));
    return { ...file, in_scope: inScope };
  });

  const filesTruncated = annotatedFiles.length > maxFiles;
  const changedFiles = annotatedFiles.slice(0, maxFiles).map((file) => ({
    ...file,
    path: scrubText(file.path),
    ...(file.previous_path !== undefined ? { previous_path: scrubText(file.previous_path) } : {}),
  }));
  const scrubbedBaseRef = baseRef ? scrubText(baseRef) : undefined;
  const scrubbedScopeDrift = scopeDrift
    ? {
        scope_files: scopeDrift.scope_files.map((entry) => scrubText(entry)),
        in_scope_files: scopeDrift.in_scope_files.map((entry) => scrubText(entry)),
        out_of_scope_files: scopeDrift.out_of_scope_files.map((entry) => scrubText(entry)),
        untouched_scope_files: scopeDrift.untouched_scope_files.map((entry) => scrubText(entry)),
        drift_detected: scopeDrift.drift_detected,
      }
    : undefined;

  return {
    source,
    ...(scrubbedBaseRef ? { base_ref: scrubbedBaseRef } : {}),
    total_files: annotatedFiles.length,
    additions,
    deletions,
    changed_files: changedFiles,
    ...(filesTruncated ? { files_truncated: true } : {}),
    ...(scrubbedScopeDrift ? { scope_drift: scrubbedScopeDrift } : {}),
  };
}

export function collectScopedDiffMeta(options: {
  repoRoot: string;
  baseBranch: string;
  headSha: string;
  handoffFiles: readonly string[];
  scopeFiles?: readonly string[];
  maxFiles?: number;
  taskId?: string;
}): ReviewDiffMeta {
  const {
    repoRoot,
    baseBranch,
    headSha,
    handoffFiles,
    scopeFiles,
    maxFiles = DEFAULT_MAX_CHANGED_FILES,
    taskId,
  } = options;

  let rawFiles: readonly ReviewChangedFile[] = [];
  let source: ReviewDiffMeta["source"] = "handoff_only";
  let baseRef: string | undefined;
  let additions = 0;
  let deletions = 0;

  const realRoot = isValidHeadSha(headSha) ? resolveGitRootSync(repoRoot) : null;
  if (realRoot) {
    const cached = getCachedRawDiff(taskId, headSha, realRoot, baseBranch);
    if (cached) {
      rawFiles = cached.rawFiles;
      additions = cached.additions;
      deletions = cached.deletions;
      source = "git_diff";
      baseRef = cached.baseRef;
    } else if (isSafeGitRef(baseBranch)) {
      const mergeBase = resolveGitMergeBase(realRoot, baseBranch, headSha);
      const diffOut = runGitReadOnly(realRoot, buildGitDiffArgs(mergeBase, headSha));
      if (diffOut !== null) {
        const parsed = parseGitDiffZ(diffOut, realRoot);
        rawFiles = parsed.files;
        additions = parsed.additions;
        deletions = parsed.deletions;
        source = "git_diff";
        baseRef = mergeBase ?? baseBranch;
        setCachedRawDiff(taskId, headSha, {
          realRoot,
          baseBranch,
          baseRef,
          rawFiles: parsed.files.map((f) => ({ ...f })),
          additions,
          deletions,
        });
      }
    }
  }

  return finalizeScopedDiffMeta({
    source,
    baseRef,
    rawFiles,
    additions,
    deletions,
    handoffFiles,
    scopeFiles,
    maxFiles,
  });
}

export async function collectScopedDiffMetaAsync(options: {
  repoRoot: string;
  baseBranch: string;
  headSha: string;
  handoffFiles: readonly string[];
  scopeFiles?: readonly string[];
  maxFiles?: number;
  taskId?: string;
}): Promise<ReviewDiffMeta> {
  const {
    repoRoot,
    baseBranch,
    headSha,
    handoffFiles,
    scopeFiles,
    maxFiles = DEFAULT_MAX_CHANGED_FILES,
    taskId,
  } = options;

  let rawFiles: readonly ReviewChangedFile[] = [];
  let source: ReviewDiffMeta["source"] = "handoff_only";
  let baseRef: string | undefined;
  let additions = 0;
  let deletions = 0;

  const realRoot = isValidHeadSha(headSha) ? await resolveGitRootAsync(repoRoot) : null;
  if (realRoot) {
    const cached = getCachedRawDiff(taskId, headSha, realRoot, baseBranch);
    if (cached) {
      rawFiles = cached.rawFiles;
      additions = cached.additions;
      deletions = cached.deletions;
      source = "git_diff";
      baseRef = cached.baseRef;
    } else if (isSafeGitRef(baseBranch)) {
      const mergeBase = await resolveGitMergeBaseAsync(realRoot, baseBranch, headSha);
      const diffOut = await runGitReadOnlyAsync(realRoot, buildGitDiffArgs(mergeBase, headSha));
      if (diffOut !== null) {
        const parsed = parseGitDiffZ(diffOut, realRoot);
        rawFiles = parsed.files;
        additions = parsed.additions;
        deletions = parsed.deletions;
        source = "git_diff";
        baseRef = mergeBase ?? baseBranch;
        setCachedRawDiff(taskId, headSha, {
          realRoot,
          baseBranch,
          baseRef,
          rawFiles: parsed.files.map((f) => ({ ...f })),
          additions,
          deletions,
        });
      }
    }
  }

  return finalizeScopedDiffMeta({
    source,
    baseRef,
    rawFiles,
    additions,
    deletions,
    handoffFiles,
    scopeFiles,
    maxFiles,
  });
}

function extractReviewerSyncBoardExcerpt(
  content: string,
  taskId: string,
  persona: string | null,
  maxChars: number,
): string | undefined {
  const trimmed = scrubText(content).trim();
  if (!trimmed) return undefined;

  const lines = trimmed.split(/\r?\n/);
  const taskNeedle = taskId.toLowerCase();
  const shortTaskNeedle = taskId.slice(0, 8).toLowerCase();
  const personaNeedle = persona?.toLowerCase();

  const picked: string[] = [];
  let currentHeading: string | undefined;
  let headingIncluded = false;

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      currentHeading = line;
      headingIncluded = false;
      if (/\b(?:decisions|open\s+asks|verified)\b/i.test(line)) {
        picked.push(line);
        headingIncluded = true;
      }
      continue;
    }
    const clean = line.trim();
    if (!clean) continue;
    const low = clean.toLowerCase();
    const matches =
      low.includes(taskNeedle) ||
      (shortTaskNeedle.length >= 8 && low.includes(shortTaskNeedle)) ||
      (personaNeedle ? low.includes(personaNeedle) : false) ||
      /\b(?:decisions|open\s+asks)\b/i.test(clean);
    if (matches || (currentHeading && /\b(?:decisions|open\s+asks)\b/i.test(currentHeading))) {
      if (currentHeading && !headingIncluded) {
        picked.push(currentHeading);
        headingIncluded = true;
      }
      picked.push(line);
    }
  }

  let excerpt = (picked.length > 0 ? picked : lines.filter((l) => l.trim().length > 0))
    .join("\n")
    .trim();
  if (!excerpt) return undefined;
  if (excerpt.length > maxChars) {
    excerpt = `${Array.from(excerpt)
      .slice(0, maxChars - 1)
      .join("")}…`;
  }
  return excerpt;
}

function orderPackFields(pack: UnsizedReviewContextPack, byteLength: number): ReviewContextPack {
  return ReviewContextPackSchema.parse({
    task_id: pack.task_id,
    reviewed_commit_sha: pack.reviewed_commit_sha,
    head_sha: pack.head_sha,
    last_commit_hash: pack.last_commit_hash,
    base_branch: pack.base_branch,
    ...(pack.git_branch !== undefined ? { git_branch: pack.git_branch } : {}),
    diff_meta: pack.diff_meta,
    handoff_decisions: pack.handoff_decisions,
    verification_command: pack.verification_command,
    ...(pack.task_verify_command !== undefined
      ? { task_verify_command: pack.task_verify_command }
      : {}),
    ...(pack.epic_summary_excerpt !== undefined
      ? { epic_summary_excerpt: pack.epic_summary_excerpt }
      : {}),
    ...(pack.sync_board_excerpt !== undefined
      ? { sync_board_excerpt: pack.sync_board_excerpt }
      : {}),
    detail_pointers: pack.detail_pointers,
    byte_length: byteLength,
    ...(pack.truncated ? { truncated: true as const } : {}),
  });
}

function measurePack(
  pack: UnsizedReviewContextPack,
  maxBytes = REVIEW_CONTEXT_PACK_MAX_BYTES,
): { serialized: ReviewContextPack | null; bytes: number } {
  let estimate = Math.min(
    maxBytes,
    Math.max(1, Buffer.byteLength(JSON.stringify({ ...pack, byte_length: 1000 }), "utf8")),
  );
  for (let i = 0; i < 4; i += 1) {
    if (estimate > maxBytes) {
      return { serialized: null, bytes: estimate };
    }
    const candidate = orderPackFields(pack, estimate);
    const actual = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (actual === estimate) {
      return { serialized: candidate, bytes: actual };
    }
    estimate = actual;
  }
  if (estimate > maxBytes) {
    return { serialized: null, bytes: estimate };
  }
  const finalCandidate = orderPackFields(pack, estimate);
  const finalBytes = Buffer.byteLength(JSON.stringify(finalCandidate), "utf8");
  return {
    serialized: finalBytes <= maxBytes ? finalCandidate : null,
    bytes: finalBytes,
  };
}

function fitTextPrefix(
  text: string,
  applyPrefix: (prefix: string) => UnsizedReviewContextPack,
  maxBytes: number,
): ReviewContextPack | null {
  const chars = Array.from(text);
  let low = 1;
  let high = chars.length - 1;
  let best: ReviewContextPack | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = `${chars.slice(0, mid).join("")}…`;
    const measured = measurePack(applyPrefix(prefix), maxBytes);
    if (measured.serialized && measured.bytes <= maxBytes) {
      best = measured.serialized;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function boundReviewContextPack(
  pack: UnsizedReviewContextPack,
  maxBytes = REVIEW_CONTEXT_PACK_MAX_BYTES,
): ReviewContextPack {
  const initial = measurePack(pack, maxBytes);
  if (initial.serialized && initial.bytes <= maxBytes) {
    return initial.serialized;
  }

  const working: UnsizedReviewContextPack = {
    ...pack,
    diff_meta: {
      ...pack.diff_meta,
      changed_files: [...pack.diff_meta.changed_files],
      ...(pack.diff_meta.scope_drift
        ? {
            scope_drift: {
              ...pack.diff_meta.scope_drift,
              scope_files: [...pack.diff_meta.scope_drift.scope_files],
              in_scope_files: [...pack.diff_meta.scope_drift.in_scope_files],
              out_of_scope_files: [...pack.diff_meta.scope_drift.out_of_scope_files],
              untouched_scope_files: [...pack.diff_meta.scope_drift.untouched_scope_files],
            },
          }
        : {}),
    },
    handoff_decisions: [...pack.handoff_decisions],
    detail_pointers: {
      ...pack.detail_pointers,
      ...(pack.detail_pointers.doc_refs ? { doc_refs: [...pack.detail_pointers.doc_refs] } : {}),
      mcp_tools: [...pack.detail_pointers.mcp_tools],
    },
    truncated: true,
  };

  // 1. Try shortening sync_board_excerpt if removing it makes the pack fit.
  if (working.sync_board_excerpt) {
    const savedExcerpt = working.sync_board_excerpt;
    delete working.sync_board_excerpt;
    const withoutExcerpt = measurePack(working, maxBytes);
    if (withoutExcerpt.serialized && withoutExcerpt.bytes <= maxBytes) {
      const fitted = fitTextPrefix(
        savedExcerpt,
        (prefix) => ({ ...working, sync_board_excerpt: prefix }),
        maxBytes,
      );
      return fitted ?? withoutExcerpt.serialized;
    }
  }

  // 2. Try shortening or dropping epic_summary_excerpt.
  if (working.epic_summary_excerpt) {
    const savedEpic = working.epic_summary_excerpt;
    delete working.epic_summary_excerpt;
    const withoutEpic = measurePack(working, maxBytes);
    if (withoutEpic.serialized && withoutEpic.bytes <= maxBytes) {
      const fitted = fitTextPrefix(
        savedEpic,
        (prefix) => ({ ...working, epic_summary_excerpt: prefix }),
        maxBytes,
      );
      return fitted ?? withoutEpic.serialized;
    }
  }

  // 3. Trim diff_meta.changed_files from the end while preserving total_files / additions / deletions.
  while (working.diff_meta.changed_files.length > 0) {
    working.diff_meta.changed_files.pop();
    working.diff_meta.files_truncated = true;
    const m = measurePack(working, maxBytes);
    if (m.serialized && m.bytes <= maxBytes) return m.serialized;
  }

  // 4. Trim scope_drift arrays if still over budget.
  if (working.diff_meta.scope_drift) {
    const drift = working.diff_meta.scope_drift;
    for (const key of [
      "untouched_scope_files",
      "in_scope_files",
      "out_of_scope_files",
      "scope_files",
    ] as const) {
      while (drift[key].length > 0) {
        drift[key].pop();
        const m = measurePack(working, maxBytes);
        if (m.serialized && m.bytes <= maxBytes) return m.serialized;
      }
    }
  }

  // 5. Trim handoff_decisions and detail_pointers.doc_refs as defensive fallback.
  while (working.handoff_decisions.length > 0) {
    working.handoff_decisions.pop();
    const m = measurePack(working, maxBytes);
    if (m.serialized && m.bytes <= maxBytes) return m.serialized;
  }
  if (working.detail_pointers.doc_refs) {
    delete working.detail_pointers.doc_refs;
    const m = measurePack(working, maxBytes);
    if (m.serialized && m.bytes <= maxBytes) return m.serialized;
  }

  const fallback = measurePack(working, maxBytes);
  if (fallback.serialized) return fallback.serialized;
  throw new Error("Unable to fit review_context_pack within REVIEW_CONTEXT_PACK_MAX_BYTES");
}

export function isStaleReviewCommit(options: {
  task: LocalTask;
  review: LocalReview;
  expectedHeadSha?: string;
}): boolean {
  const { task, review, expectedHeadSha } = options;
  if (expectedHeadSha !== undefined && expectedHeadSha !== review.ref.head_sha) {
    return true;
  }
  if (
    task.handoff?.last_commit_hash &&
    task.handoff.pull_request &&
    task.handoff.last_commit_hash !== review.ref.head_sha
  ) {
    return true;
  }
  return false;
}

export interface ReviewContextSnapshot {
  taskId: string;
  taskPersona: string | null;
  scopeFiles?: readonly string[];
  taskVerifyCommand?: string | null;
  docRefs?: readonly string[];
  gitBranch?: string;
  headSha: string;
  lastCommitHash: string;
  baseBranch: string;
  handoffFiles: readonly string[];
  handoffDecisions: readonly string[];
  verificationCommand: string | null;
  epicSummaryText?: string;
  syncBoardContent?: string;
  compact: boolean;
  maxBytes: number;
}

export function snapshotReviewContext(options: {
  project: LocalProject;
  task: LocalTask;
  review: LocalReview;
  compact?: boolean;
  maxBytes?: number;
}): ReviewContextSnapshot {
  const {
    project,
    task,
    review,
    compact = false,
    maxBytes = REVIEW_CONTEXT_PACK_MAX_BYTES,
  } = options;
  const headSha = review.ref.head_sha;
  const epic = project.epics.find((e) => e.id === task.epicId);
  const syncDoc = project.documents.find((d) => d.slug === "sync-board" && !d.archived_at);
  const gitBranch = task.handoff?.git_branch ?? task.branch?.name;

  return {
    taskId: task.id,
    taskPersona: task.persona,
    ...(task.scope_files ? { scopeFiles: [...task.scope_files] } : {}),
    ...(task.verify_command !== undefined ? { taskVerifyCommand: task.verify_command } : {}),
    ...(task.doc_refs?.length ? { docRefs: [...task.doc_refs] } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    headSha,
    lastCommitHash: task.handoff?.last_commit_hash ?? headSha,
    baseBranch: review.ref.base_branch,
    handoffFiles: [...(task.handoff?.files_modified ?? [])],
    handoffDecisions: [...(task.handoff?.key_decisions ?? [])],
    verificationCommand: task.handoff?.verification_command ?? null,
    ...(epic
      ? { epicSummaryText: `${epic.title}${epic.description ? `: ${epic.description}` : ""}` }
      : {}),
    ...(syncDoc ? { syncBoardContent: syncDoc.content } : {}),
    compact,
    maxBytes,
  };
}

function assembleReviewContextPack(
  snapshot: ReviewContextSnapshot,
  diffMeta: ReviewDiffMeta,
): ReviewContextPack {
  const {
    taskId,
    taskPersona,
    taskVerifyCommand: rawTaskVerifyCommand,
    docRefs,
    gitBranch: rawGitBranch,
    headSha,
    lastCommitHash,
    baseBranch,
    handoffDecisions: rawHandoffDecisions,
    verificationCommand: rawVerificationCommand,
    epicSummaryText,
    syncBoardContent,
    compact,
    maxBytes,
  } = snapshot;

  const rawDecisions = rawHandoffDecisions.map((d) => briefText(scrubText(d), compact ? 120 : 150));
  const maxDecisions = compact ? COMPACT_MAX_DECISIONS : DEFAULT_MAX_DECISIONS;
  const decisionsTruncated = rawDecisions.length > maxDecisions;
  const handoffDecisions = rawDecisions.slice(0, maxDecisions);

  const verificationCommand =
    rawVerificationCommand != null ? scrubText(rawVerificationCommand) : null;
  const taskVerifyCommand =
    rawTaskVerifyCommand !== undefined
      ? rawTaskVerifyCommand === null
        ? null
        : scrubText(rawTaskVerifyCommand)
      : undefined;

  const epicSummaryExcerpt = epicSummaryText
    ? briefText(scrubText(epicSummaryText), compact ? 140 : 240)
    : undefined;

  const syncBoardExcerpt = syncBoardContent
    ? extractReviewerSyncBoardExcerpt(
        syncBoardContent,
        taskId,
        taskPersona,
        compact ? COMPACT_EXCERPT_LIMIT : DEFAULT_EXCERPT_LIMIT,
      )
    : undefined;

  const gitBranch = rawGitBranch ? scrubText(rawGitBranch) : undefined;
  const safeBaseBranch = scrubText(baseBranch);
  const diffBaseRef = diffMeta.base_ref ? scrubText(diffMeta.base_ref) : safeBaseBranch;

  const detailPointers: ReviewDetailPointers = {
    git_diff_command: `git diff ${diffBaseRef}...${headSha} --`,
    git_show_stat_command: `git show --stat ${headSha}`,
    ...(docRefs?.length ? { doc_refs: docRefs.map((ref) => scrubText(ref)) } : {}),
    mcp_tools: compact
      ? ["get_document (section)", "search_context (code)"]
      : [
          "get_document (outline_only: true or section)",
          'search_context (sources: ["code", "document"])',
          "graph_neighbors (paths)",
        ],
  };

  const unsized: UnsizedReviewContextPack = {
    task_id: taskId,
    reviewed_commit_sha: headSha,
    head_sha: headSha,
    last_commit_hash: lastCommitHash,
    base_branch: safeBaseBranch,
    ...(gitBranch ? { git_branch: gitBranch } : {}),
    diff_meta: diffMeta,
    handoff_decisions: handoffDecisions,
    verification_command: verificationCommand,
    ...(taskVerifyCommand !== undefined ? { task_verify_command: taskVerifyCommand } : {}),
    ...(epicSummaryExcerpt ? { epic_summary_excerpt: epicSummaryExcerpt } : {}),
    ...(syncBoardExcerpt ? { sync_board_excerpt: syncBoardExcerpt } : {}),
    detail_pointers: detailPointers,
    ...(diffMeta.files_truncated || decisionsTruncated ? { truncated: true as const } : {}),
  };

  return boundReviewContextPack(unsized, maxBytes);
}

export async function buildReviewContextPackFromSnapshot(
  snapshot: ReviewContextSnapshot,
  repoRoot: string,
): Promise<ReviewContextPack> {
  const diffMeta = await collectScopedDiffMetaAsync({
    repoRoot,
    baseBranch: snapshot.baseBranch,
    headSha: snapshot.headSha,
    handoffFiles: snapshot.handoffFiles,
    scopeFiles: snapshot.scopeFiles,
    maxFiles: snapshot.compact ? COMPACT_MAX_CHANGED_FILES : DEFAULT_MAX_CHANGED_FILES,
    taskId: snapshot.taskId,
  });
  return assembleReviewContextPack(snapshot, diffMeta);
}

export function buildReviewContextPackFromSnapshotSync(
  snapshot: ReviewContextSnapshot,
  repoRoot: string,
): ReviewContextPack {
  const diffMeta = collectScopedDiffMeta({
    repoRoot,
    baseBranch: snapshot.baseBranch,
    headSha: snapshot.headSha,
    handoffFiles: snapshot.handoffFiles,
    scopeFiles: snapshot.scopeFiles,
    maxFiles: snapshot.compact ? COMPACT_MAX_CHANGED_FILES : DEFAULT_MAX_CHANGED_FILES,
    taskId: snapshot.taskId,
  });
  return assembleReviewContextPack(snapshot, diffMeta);
}

export function buildReviewContextPack(options: {
  repoRoot: string;
  project: LocalProject;
  task: LocalTask;
  review: LocalReview;
  compact?: boolean;
  maxBytes?: number;
}): ReviewContextPack {
  return buildReviewContextPackFromSnapshotSync(snapshotReviewContext(options), options.repoRoot);
}

export function withReviewResponseByteLength<T extends Exclude<ReviewResult, { reviews: unknown }>>(
  entry: Omit<T, "byte_length">,
): T & { byte_length: number } {
  let estimate = Math.max(
    1,
    Buffer.byteLength(JSON.stringify({ ...entry, byte_length: 1000 }), "utf8"),
  );
  for (let i = 0; i < 4; i += 1) {
    const candidate = { ...entry, byte_length: estimate };
    const actual = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (actual === estimate) return candidate as T & { byte_length: number };
    estimate = actual;
  }
  const finalCandidate = { ...entry, byte_length: estimate };
  return {
    ...entry,
    byte_length: Buffer.byteLength(JSON.stringify(finalCandidate), "utf8"),
  } as T & { byte_length: number };
}
