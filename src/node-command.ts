import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Pilih perintah node untuk entri MCP yang tidak rusak saat Node di-upgrade.
 *
 * `process.execPath` sering berisi folder berversi (mis. ServBay
 * `/Applications/ServBay/package/node/24/24.21.0/bin/node`, nvm, fnm). Path itu hilang
 * begitu Node di-update, dan tidak berlaku di mesin lain. Jika `node` di PATH menunjuk
 * ke binary yang sama, tulis `node` saja; selain itu tetap pakai path absolut.
 */
export function stableNodeCommand(
  execPath: string,
  pathEnv: string | undefined,
  resolveReal: (p: string) => string = realpathSync,
  isExecutable: (p: string) => boolean = defaultIsExecutable,
): string {
  const target = safeReal(execPath, resolveReal);
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === "win32" ? ["node.exe", "node"] : ["node"]) {
      const candidate = join(dir, name);
      if (!isExecutable(candidate)) continue;
      // Kandidat pertama di PATH adalah yang dijalankan shell/IDE; hanya itu yang dihitung.
      return safeReal(candidate, resolveReal) === target ? "node" : execPath;
    }
  }
  return execPath;
}

/** True jika path mengandung segmen versi seperti `24.21.0` atau `v22.11.0`. */
export function hasVersionedSegment(path: string): boolean {
  return /[\\/]v?\d+\.\d+\.\d+[\\/]/.test(path);
}

function safeReal(p: string, resolveReal: (p: string) => string): string {
  try {
    return resolveReal(p);
  } catch {
    return p;
  }
}

function defaultIsExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
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
