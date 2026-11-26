import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

export type RegisteredRoot = {
  id: string;
  path: string;
  label?: string | null;
};

export type IndexedRootTarget = {
  rootId: string | null;
  absRoot: string;
  prefix: string;
};

function sanitizePrefix(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "root";
}

export async function collectRootTargets(
  primaryRoot: string,
  extraRoots: RegisteredRoot[],
): Promise<IndexedRootTarget[]> {
  const absPrimary = resolve(primaryRoot);
  const targets: IndexedRootTarget[] = [{ rootId: null, absRoot: absPrimary, prefix: "" }];
  const seenPaths = new Set<string>([absPrimary]);
  const usedPrefixes = new Set<string>();

  for (const ws of extraRoots) {
    const absWs = resolve(ws.path);
    if (seenPaths.has(absWs)) continue;
    let isDir = false;
    try {
      const st = await stat(absWs);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    seenPaths.add(absWs);

    const base = sanitizePrefix(ws.label || basename(absWs) || ws.id.slice(0, 8));
    let prefix = `@${base}`;
    if (usedPrefixes.has(prefix)) {
      prefix = `@${base}-${ws.id.slice(0, 8)}`;
    }
    usedPrefixes.add(prefix);
    targets.push({ rootId: ws.id, absRoot: absWs, prefix });
  }

  return targets;
}
