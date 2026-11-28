import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const VERSION_SEGMENT = /([\\/])v?\d+\.\d+\.\d+(?=[\\/])/;
const MANAGER_NODE = /([\\/])node[\\/]\d+[\\/]\d+\.\d+\.\d+(?=[\\/])/;
const NVM_NODE = /([\\/])versions[\\/]node[\\/]v\d+\.\d+\.\d+(?=[\\/])/;

/**
 * Pilih perintah node untuk entri MCP yang tidak rusak saat Node di-upgrade.
 *
 * `process.execPath` sering berisi folder berversi (mis. ServBay
 * `/Applications/ServBay/package/node/24/24.21.0/bin/node`, nvm, fnm). Path itu hilang
 * begitu Node di-update. Utamakan path stabil yang terbukti menunjuk ke executable
 * yang sama, bahkan jika IDE tidak mewarisi PATH shell. Jika tidak ada, gunakan `node`
 * hanya bila executable pertama di PATH cocok. Terakhir, pertahankan `execPath`.
 */
export function stableNodeCommand(
  execPath: string,
  pathEnv: string | undefined,
  resolveReal: (p: string) => string = realpathSync,
  isExecutable: (p: string) => boolean = defaultIsExecutable,
): string {
  const { target, stable } = stableVersionedPath(execPath, resolveReal, isExecutable);
  if (!target) return execPath;
  if (stable) return stable;

  for (const dir of (pathEnv ?? "").split(delimiter)) {
    // Empty/relative PATH entries are cwd-dependent, so do not skip ahead to a later executable.
    if (!isAbsolute(dir)) break;
    for (const name of process.platform === "win32" ? ["node.exe", "node"] : ["node"]) {
      const candidate = join(dir, name);
      if (!isExecutable(candidate)) continue;
      if (safeReal(candidate, resolveReal) !== target) return execPath;
      // An unversioned runtime or PATH alias can use bare node. Version-pinned PATH is not stable.
      return !hasVersionedSegment(target) ||
        (!hasVersionedSegment(candidate) && safeReal(candidate, resolveReal) === target)
        ? "node"
        : execPath;
    }
  }
  return execPath;
}

/**
 * Hindari path skrip berversi (mis. `node/24/24.21.0/...` atau `versions/node/v22.11.0/...`)
 * bila symlink `current` yang menunjuk ke file yang sama tersedia.
 */
export function stableScriptPath(
  scriptPath: string,
  resolveReal: (p: string) => string = realpathSync,
  isFile: (p: string) => boolean = defaultIsFile,
): string {
  if (!isAbsolute(scriptPath)) return scriptPath;
  const { stable } = stableVersionedPath(scriptPath, resolveReal, isFile);
  return stable ?? scriptPath;
}

function stableVersionedPath(
  inputPath: string,
  resolveReal: (p: string) => string,
  isValid: (p: string) => boolean,
): { target: string | null; stable: string | null } {
  const target = safeReal(inputPath, resolveReal);
  if (!target) return { target: null, stable: null };
  const matches = (candidate: string) =>
    isAbsolute(candidate) &&
    !hasVersionedSegment(candidate) &&
    isValid(candidate) &&
    safeReal(candidate, resolveReal) === target;

  if (inputPath !== target && matches(inputPath)) return { target, stable: inputPath };
  for (const candidate of new Set([
    target.replace(MANAGER_NODE, "$1node$1current"),
    target.replace(NVM_NODE, "$1current"),
    target.replace(VERSION_SEGMENT, "$1current"),
  ])) {
    if (candidate !== target && matches(candidate)) return { target, stable: candidate };
  }
  return { target, stable: null };
}

export function nodeLauncherWarning(command: string): string | null {
  return hasVersionedSegment(command)
    ? `! Entri MCP memakai ${command}, path berversi yang bisa rusak saat Node di-update. ` +
        "Sediakan symlink Node tanpa versi yang menunjuk ke executable ini, atau pakai --mcp-command."
    : null;
}

/** True jika path mengandung segmen versi seperti `24.21.0` atau `v22.11.0`. */
export function hasVersionedSegment(path: string): boolean {
  return VERSION_SEGMENT.test(path);
}

function safeReal(p: string, resolveReal: (p: string) => string): string | null {
  try {
    return resolveReal(p);
  } catch {
    return null;
  }
}

function defaultIsExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Bila CLI sedang dijalankan lewat `npx` (file ada di cache `_npx`), path skripnya bersifat
 * sementara: cache bisa dibersihkan kapan saja. Entri MCP lalu memakai `npx -y catenext`
 * agar tetap jalan per repo tanpa instalasi global.
 */
export function npxLaunch(entry: string): { command: string; args: string[] } | null {
  return /[\\/]_npx[\\/]/.test(entry) ? { command: "npx", args: ["-y", "catenext"] } : null;
}
