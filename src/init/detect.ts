import { readFile } from "node:fs/promises";
import { join } from "node:path";

const exists = async (p: string) =>
  readFile(p, "utf8").then(
    (s) => s,
    () => null,
  );

/** Deteksi stack ringan dari file manifest di root repo (tanpa membaca kode sumber). */
export async function detectStack(root: string): Promise<string[]> {
  const stack = new Set<string>();

  const goMod = await exists(join(root, "go.mod"));
  if (goMod !== null) stack.add("go");

  const pkg = await exists(join(root, "package.json"));
  if (pkg !== null) {
    stack.add("node");
    try {
      const json = JSON.parse(pkg) as Record<string, Record<string, string> | undefined>;
      const deps = { ...json.dependencies, ...json.devDependencies };
      const known: Record<string, string> = {
        typescript: "typescript",
        next: "nextjs",
        react: "react",
        vue: "vue",
        svelte: "svelte",
        hono: "hono",
        express: "express",
        "@nestjs/core": "nestjs",
        "drizzle-orm": "drizzle",
        prisma: "prisma",
      };
      for (const [dep, label] of Object.entries(known)) if (deps[dep]) stack.add(label);
    } catch {
      // package.json rusak: cukup "node".
    }
  }

  const composer = await exists(join(root, "composer.json"));
  if (composer !== null) {
    stack.add("php");
    if (composer.includes('"laravel/framework"')) stack.add("laravel");
  }

  if ((await exists(join(root, "pyproject.toml"))) !== null) stack.add("python");
  else if ((await exists(join(root, "requirements.txt"))) !== null) stack.add("python");
  if ((await exists(join(root, "Cargo.toml"))) !== null) stack.add("rust");

  return [...stack].slice(0, 20);
}
