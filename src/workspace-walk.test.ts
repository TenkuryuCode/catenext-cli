import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_FILE_BYTES,
  isGitignored,
  isSafeRegularFileSync,
  isWithinRoot,
  parseGitignore,
  readBoundedUtf8File,
  walkWorkspaceFiles,
} from "./workspace-walk.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const real = await realpath(dir);
  tempDirs.push(real);
  return real;
}

async function trySymlink(
  target: string,
  linkPath: string,
  type?: "file" | "dir" | "junction",
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("isWithinRoot", () => {
  it("accepts exact root and nested descendants while rejecting sibling and parent escapes", () => {
    const root = "/workspace/project";
    expect(isWithinRoot(root, root)).toBe(true);
    expect(isWithinRoot(root, "/workspace/project/src/index.ts")).toBe(true);
    expect(isWithinRoot(root, "/workspace/project-other/src/index.ts")).toBe(false);
    expect(isWithinRoot(root, "/workspace")).toBe(false);
    expect(isWithinRoot(root, "/etc/passwd")).toBe(false);
  });
});

describe("parseGitignore & isGitignored", () => {
  it("parses comments, escaped # and !, trailing spaces, leading /, dirOnly, and ** globs", () => {
    const rules = parseGitignore(
      [
        "# comment line",
        "",
        "\\#literal-hash.txt",
        "\\!literal-bang.txt",
        "trailing-space.txt   ",
        "escaped-space\\ ",
        "/root-only.log",
        "build/",
        "**/generated/*.ts",
        "a/**/b.txt",
        "docs/**",
        "[unclosed",
      ].join("\r\n"),
    );

    expect(isGitignored("#literal-hash.txt", false, rules)).toBe(true);
    expect(isGitignored("!literal-bang.txt", false, rules)).toBe(true);
    expect(isGitignored("trailing-space.txt", false, rules)).toBe(true);
    expect(isGitignored("trailing-space.txt   ", false, rules)).toBe(false);
    expect(isGitignored("escaped-space ", false, rules)).toBe(true);

    expect(isGitignored("root-only.log", false, rules)).toBe(true);
    expect(isGitignored("sub/root-only.log", false, rules)).toBe(false);

    expect(isGitignored("build", true, rules)).toBe(true);
    expect(isGitignored("build", false, rules)).toBe(false);
    expect(isGitignored("build/a.js", false, rules)).toBe(true);
    expect(isGitignored("src/build/sub/a.js", false, rules)).toBe(true);

    expect(isGitignored("generated/types.ts", false, rules)).toBe(true);
    expect(isGitignored("src/generated/types.ts", false, rules)).toBe(true);
    expect(isGitignored("a/b.txt", false, rules)).toBe(true);
    expect(isGitignored("a/x/y/b.txt", false, rules)).toBe(true);
    expect(isGitignored("docs/guide/intro.md", false, rules)).toBe(true);
  });

  it("handles nested .gitignore baseRel, negation overrides, and dirOnly ancestor checks", () => {
    const rootRules = parseGitignore(
      [
        "*.log",
        "!keep.log",
        "/dist-only/",
        "src/gen/*",
        "!src/gen/keep.ts",
        "cache/",
        "!cache/",
      ].join("\n"),
    );
    const nestedRules = parseGitignore(["*.tmp", "!local.tmp", "out/"].join("\n"), "packages/app");
    const combined = [...rootRules, ...nestedRules];

    expect(isGitignored("error.log", false, combined)).toBe(true);
    expect(isGitignored("sub/keep.log", false, combined)).toBe(false);
    expect(isGitignored("dist-only/bundle.js", false, combined)).toBe(true);
    expect(isGitignored("sub/dist-only/bundle.js", false, combined)).toBe(false);

    expect(isGitignored("src/gen/drop.ts", false, combined)).toBe(true);
    expect(isGitignored("src/gen/keep.ts", false, combined)).toBe(false);

    // Negated dirOnly rule overrides earlier dirOnly rule for that directory and its files
    expect(isGitignored("cache/entry.bin", false, combined)).toBe(false);

    // Nested .gitignore only applies under packages/app/
    expect(isGitignored("other/file.tmp", false, combined)).toBe(false);
    expect(isGitignored("packages/app/file.tmp", false, combined)).toBe(true);
    expect(isGitignored("packages/app/local.tmp", false, combined)).toBe(false);
    expect(isGitignored("packages/app/out/index.js", false, combined)).toBe(true);
  });

  it("treats [^a] as literal ^ in character class while [!a] remains negation", () => {
    const rules = parseGitignore(["file[^a].txt", "neg[!a].txt", "br[]a].txt"].join("\n"));

    expect(isGitignored("file^.txt", false, rules)).toBe(true);
    expect(isGitignored("filea.txt", false, rules)).toBe(true);
    expect(isGitignored("fileb.txt", false, rules)).toBe(false);

    expect(isGitignored("nega.txt", false, rules)).toBe(false);
    expect(isGitignored("negb.txt", false, rules)).toBe(true);
    expect(isGitignored("neg^.txt", false, rules)).toBe(true);

    expect(isGitignored("br].txt", false, rules)).toBe(true);
    expect(isGitignored("bra.txt", false, rules)).toBe(true);
    expect(isGitignored("brb.txt", false, rules)).toBe(false);
  });
});

describe("readBoundedUtf8File & isSafeRegularFileSync", () => {
  it("reads valid UTF-8 regular files within size cap and rejects invalid inputs, symlinks, and binaries", async () => {
    const root = await makeTempDir("catenext-walk-read-");
    const outside = await makeTempDir("catenext-walk-outside-");

    const okPath = join(root, "ok.txt");
    const emptyPath = join(root, "empty.txt");
    const bigPath = join(root, "big.txt");
    const nulPath = join(root, "binary.bin");
    const badUtf8Path = join(root, "invalid-utf8.bin");
    const outsidePath = join(outside, "secret.txt");
    const escapedLink = join(root, "escaped.txt");
    const insideLink = join(root, "inside-link.txt");
    const subDir = join(root, "sub");

    await mkdir(subDir, { recursive: true });
    await writeFile(okPath, "halo dunia ✓", "utf8");
    await writeFile(emptyPath, "", "utf8");
    await writeFile(bigPath, "0123456789", "utf8");
    await writeFile(nulPath, Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(badUtf8Path, Buffer.from([0xff, 0xfe, 0x80]));
    await writeFile(outsidePath, "leak", "utf8");

    const hasEscapedLink = await trySymlink(outsidePath, escapedLink);
    const hasInsideLink = await trySymlink(okPath, insideLink);

    expect(await readBoundedUtf8File(okPath, root)).toBe("halo dunia ✓");
    expect(await readBoundedUtf8File(emptyPath, root)).toBe("");
    expect(await readBoundedUtf8File(bigPath, root, 10)).toBe("0123456789");
    expect(await readBoundedUtf8File(bigPath, root, 9)).toBeNull();
    expect(await readBoundedUtf8File(okPath, root, 0)).toBeNull();
    expect(await readBoundedUtf8File(okPath, root, -5)).toBeNull();
    expect(await readBoundedUtf8File(okPath, root, Number.NaN)).toBeNull();
    expect(await readBoundedUtf8File(okPath, root, Number.POSITIVE_INFINITY)).toBeNull();

    expect(await readBoundedUtf8File(nulPath, root)).toBeNull();
    expect(await readBoundedUtf8File(badUtf8Path, root)).toBeNull();
    expect(await readBoundedUtf8File(outsidePath, root)).toBeNull();
    expect(await readBoundedUtf8File(subDir, root)).toBeNull();
    expect(await readBoundedUtf8File(join(root, "missing.txt"), root)).toBeNull();

    if (hasEscapedLink) {
      expect(await readBoundedUtf8File(escapedLink, root)).toBeNull();
      expect(isSafeRegularFileSync(root, escapedLink)).toBe(false);
    }
    if (hasInsideLink) {
      expect(await readBoundedUtf8File(insideLink, root)).toBeNull();
      expect(isSafeRegularFileSync(root, insideLink)).toBe(false);
    }

    expect(isSafeRegularFileSync(root, okPath)).toBe(true);
    expect(isSafeRegularFileSync(root, outsidePath)).toBe(false);
    expect(isSafeRegularFileSync(root, subDir)).toBe(false);
    expect(isSafeRegularFileSync(root, join(root, "missing.txt"))).toBe(false);
  });
});

describe("walkWorkspaceFiles", () => {
  it("walks deterministically, honors skipDirs, skipDotEntries, extensions, and nested .gitignore", async () => {
    const root = await makeTempDir("catenext-walk-tree-");
    await mkdir(join(root, "src/z-dir"), { recursive: true });
    await mkdir(join(root, "src/a-dir"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await mkdir(join(root, ".hidden"), { recursive: true });

    await writeFile(join(root, ".gitignore"), "*.gen.ts\nsrc/ignored/\n");
    await mkdir(join(root, "src/ignored"), { recursive: true });
    await writeFile(join(root, "src/ignored/drop.ts"), "export const x = 1;\n");
    await writeFile(join(root, "src/a-dir/.gitignore"), "skip.ts\n");
    await writeFile(join(root, "src/a-dir/skip.ts"), "export const s = 1;\n");
    await writeFile(join(root, "src/a-dir/keep.ts"), "export const k = 1;\n");
    await writeFile(join(root, "src/z-dir/zeta.ts"), "export const z = 1;\n");
    await writeFile(join(root, "src/b.gen.ts"), "export const g = 1;\n");
    await writeFile(join(root, "src/readme.md"), "# docs\n");
    await writeFile(join(root, "node_modules/pkg/index.ts"), "export const nm = 1;\n");
    await writeFile(join(root, ".hidden/secret.ts"), "export const h = 1;\n");

    const walked = await walkWorkspaceFiles(root, {
      extensions: new Set([".ts"]),
      skipDotEntries: true,
    });

    expect(walked.realRoot).toBe(root);
    expect(walked.files.map((f) => f.rel)).toEqual(["src/a-dir/keep.ts", "src/z-dir/zeta.ts"]);
    expect(walked.files.every((f) => f.ext === ".ts" && f.size > 0)).toBe(true);
  });

  it("validates maxFileBytes and skips symlink escapes and symlink loops", async () => {
    const root = await makeTempDir("catenext-walk-sec-");
    const outside = await makeTempDir("catenext-walk-sec-out-");

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/ok.ts"), "export const ok = 1;\n");
    await writeFile(join(outside, "leak.ts"), "export const leak = 1;\n");

    await trySymlink(join(outside, "leak.ts"), join(root, "src/escape.ts"));
    await trySymlink(outside, join(root, "src/escape-dir"), "junction");
    await trySymlink(join(root, "src"), join(root, "src/loop"), "junction");

    const normal = await walkWorkspaceFiles(root, {
      extensions: new Set([".ts"]),
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    });
    expect(normal.files.map((f) => f.rel)).toEqual(["src/ok.ts"]);

    const nanFallback = await walkWorkspaceFiles(root, {
      extensions: new Set([".ts"]),
      maxFileBytes: Number.NaN,
    });
    expect(nanFallback.files.map((f) => f.rel)).toEqual(["src/ok.ts"]);

    const zeroMax = await walkWorkspaceFiles(root, {
      extensions: new Set([".ts"]),
      maxFileBytes: 0,
    });
    expect(zeroMax.files).toEqual([]);

    const negMax = await walkWorkspaceFiles(root, {
      extensions: new Set([".ts"]),
      maxFileBytes: -10,
    });
    expect(negMax.files).toEqual([]);

    const missing = await walkWorkspaceFiles(join(root, "does-not-exist"));
    expect(missing.files).toEqual([]);
  });
});
