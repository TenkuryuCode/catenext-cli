import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { LocalServiceError } from "./errors.js";

export const fullSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function git(root: string, ...args: string[]): string {
  // No caller-selected remote, external diff, or inherited Git repo/config override.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    return execFileSync(
      "git",
      ["--no-optional-locks", "--no-replace-objects", "-c", `core.hooksPath=${devNull}`, ...args],
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 2500,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new LocalServiceError(
      "run_git",
      `Local Git check failed (${args[0]}). Inspect checkout and refs before resuming.`,
    );
  }
}

/** Strip Win32 extended-length / UNC prefixes so keys compare across Node vs Git forms. */
function stripWin32Namespace(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\/i.test(path)) return path.slice(4);
  if (/^\/\/\?\/UNC\//i.test(path)) return `//${path.slice(8)}`;
  if (/^\/\/\?\//i.test(path)) return path.slice(4);
  return path;
}

/**
 * Collapse separators, `..`, trailing slash, `\\?\` prefixes; case-fold on win32.
 * Exported for fixture tests (pass `platform: "win32"` to exercise Windows rules on any host).
 */
export function checkoutPathKey(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  let cleaned = stripWin32Namespace(input.replace(/\r$/, ""));
  // Git for Windows porcelain uses `/`; Node realpath uses `\`. Normalize before resolve.
  if (platform === "win32") cleaned = cleaned.replaceAll("/", "\\");
  let resolved: string;
  if (platform === process.platform) {
    try {
      resolved = realpathSync(cleaned);
    } catch {
      resolved = api.resolve(cleaned);
    }
  } else {
    // Cross-platform fixtures: pure string normalize (no host filesystem).
    resolved = api.resolve(cleaned);
  }
  resolved = stripWin32Namespace(api.resolve(resolved));
  if (platform === "win32") {
    return resolved.replaceAll("/", "\\").toLowerCase();
  }
  return resolved;
}

function pathsEqual(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const ka = checkoutPathKey(a, platform);
  const kb = checkoutPathKey(b, platform);
  if (ka === kb) return true;
  const api = platform === "win32" ? path.win32 : path.posix;
  // win32 relative is separator- and case-insensitive once both sides are keyed.
  try {
    return api.relative(ka, kb) === "";
  } catch {
    return false;
  }
}

/** True when Git porcelain path and a Node claim path name the same checkout. */
export function sameCheckoutPath(gitWorktreePath: string, claimPath: string): boolean {
  if (pathsEqual(gitWorktreePath, claimPath)) return true;
  // Git may store the long path while Node still holds an 8.3 short path (or the reverse).
  // Compare Git's own toplevel for the claim against the porcelain path (same emitter).
  try {
    const top = git(claimPath, "rev-parse", "--show-toplevel").trim().replace(/\r$/, "");
    return pathsEqual(gitWorktreePath, top);
  } catch {
    return false;
  }
}

export interface RunWorktreeEntry {
  path: string;
  branch: string | null;
  prunable: boolean;
}

/**
 * Parse `git worktree list --porcelain -z` into linked (non-primary) entries under prefix.
 * Exported so Windows-style porcelain fixtures can be tested on any host.
 */
export function parseLinkedRunWorktrees(porcelain: string, prefix: string): RunWorktreeEntry[] {
  const trees: RunWorktreeEntry[] = [];
  let current: RunWorktreeEntry | undefined;
  let primary = true;
  for (const raw of porcelain.split("\0")) {
    const field = raw.replace(/\r$/, "");
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), branch: null, prunable: false };
      if (!primary) trees.push(current);
      primary = false;
    } else if (current && field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    } else if (current && (field === "prunable" || field.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  const needle = `${prefix}/`;
  return trees.filter((tree) => tree.branch?.startsWith(needle));
}

/** Linked (non-primary) worktrees under `refs/heads/${prefix}/`. */
function linkedRunWorktrees(root: string, prefix: string): RunWorktreeEntry[] {
  return parseLinkedRunWorktrees(git(root, "worktree", "list", "--porcelain", "-z"), prefix);
}

export function localCommit(root: string, branch: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,254}$/.test(branch)) {
    throw new LocalServiceError("invalid_input", "Expected a local branch name.");
  }
  const sha = git(root, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`).trim();
  if (!fullSha.test(sha)) throw new LocalServiceError("run_git", "Invalid Git commit ID.");
  return sha;
}

export function assertDescends(root: string, base: string, head: string) {
  git(root, "merge-base", "--is-ancestor", base, head);
}

export function assertRunCheckout(root: string, prefix: string, branch: string, path: string) {
  try {
    realpathSync(path);
  } catch {
    throw new LocalServiceError("run_worktree", "Run worktree path does not exist.");
  }
  const linked = linkedRunWorktrees(root, prefix);
  if (
    linked.length > 2 ||
    !linked.some(
      (entry) => sameCheckoutPath(entry.path, path) && entry.branch === branch && !entry.prunable,
    )
  ) {
    throw new LocalServiceError(
      "run_worktree",
      "Use the reserved branch in a registered linked checkout; at most two run checkouts may exist.",
    );
  }
}

/** Exact path and post-image (mode + object ID). Renames are delete/add. */
export function commitChanges(root: string, base: string, head: string): Map<string, string> {
  const fields = git(
    root,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--ignore-submodules=none",
    "-z",
    base,
    head,
    "--",
  ).split("\0");
  const changes = new Map<string, string>();
  for (let i = 0; i < fields.length - 1; i += 2) {
    const meta = fields[i]?.match(/^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) [AMDT]$/);
    const path = fields[i + 1];
    if (
      !meta ||
      !path ||
      Array.from(path).some((char) => char < " " || char === "\x7f" || char === "\ufffd")
    ) {
      throw new LocalServiceError("run_git", "Unsupported Git change metadata or path.");
    }
    changes.set(path, `${meta[2]} ${meta[4]}`);
  }
  return changes;
}

export function assertCleanRunHead(
  root: string,
  prefix: string,
  branch: string,
  path: string,
  head: string,
) {
  assertRunCheckout(root, prefix, branch, path);
  if (
    git(path, "rev-parse", "--verify", "HEAD").trim() !== head ||
    git(path, "status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none")
      .length
  ) {
    throw new LocalServiceError(
      "run_worktree",
      "Verification needs a clean integration checkout at the reported commit.",
    );
  }
}
