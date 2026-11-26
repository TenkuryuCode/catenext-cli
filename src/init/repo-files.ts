import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ConfigError, isMissingFile } from "../config.js";

export interface FileEdit {
  path: string;
  before: string | null;
  after: string | null;
}

async function repoTarget(root: string, path: string) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(path) || !rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ConfigError(`Path di luar repo tidak diizinkan: ${path}`);
  }
  let current = root;
  const segments = rel.split(sep);
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
        throw new ConfigError(
          `Path bukan file/folder biasa di repo (symlink tidak diikuti): ${path}`,
        );
      }
      if (index === segments.length - 1) return { target, mode: stat.mode & 0o777 };
    } catch (error) {
      if (isMissingFile(error)) return { target, mode: undefined };
      throw error;
    }
  }
  return { target, mode: undefined };
}

export async function readRepoFile(root: string, path: string): Promise<string | null> {
  const { target } = await repoTarget(resolve(root), path);
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** Write atomically per file. Refuse stale plans and paths that escape the project. */
export async function applyRepoEdits(root: string, edits: readonly FileEdit[]): Promise<void> {
  root = resolve(root);
  for (const edit of edits) {
    if ((await readRepoFile(root, edit.path)) !== edit.before) {
      throw new ConfigError(
        `${edit.path} berubah setelah rencana dibuat. Jalankan perintah ulang.`,
      );
    }
  }
  for (const { path, before, after } of edits) {
    if (before === after) continue;
    const { target, mode } = await repoTarget(root, path);
    if (after === null) {
      await unlink(target);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, after, { flag: "wx", mode });
      await rename(temp, target);
    } finally {
      await unlink(temp).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
    }
  }
}
