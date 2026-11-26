// Bundel CLI menjadi satu file dist/index.js tanpa runtime dependency npm untuk distribusi.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));

// Monorepo: packages/shared; mirror publik: ./shared.
const sharedCandidates = [
  resolve(here, "../../packages/shared/src/index.ts"),
  resolve(here, "shared/src/index.ts"),
];
const shared = sharedCandidates.find((p) => existsSync(p));
if (!shared) throw new Error("Source @catenext/shared tidak ditemukan.");

const watch = process.argv.includes("--watch");
const sourcemap = watch || process.argv.includes("--sourcemap");

const options = {
  entryPoints: [resolve(here, "src/index.ts")],
  outfile: resolve(here, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  mainFields: ["module", "main"],
  target: "node22",
  minify: !watch,
  sourcemap,
  alias: { "@catenext/shared": shared },
  external: Object.keys(pkg.dependencies ?? {}),
  banner: {
    js: 'import { createRequire as __catenextCreateRequire } from "node:module"; const require = __catenextCreateRequire(import.meta.url);',
  },
  define: {
    "process.env.CATENEXT_BUILD_VERSION": JSON.stringify(pkg.version),
  },
  logLevel: "info",
};

// Bersihkan sisa build lama (mis. keluaran tsc per file) agar paket npm hanya berisi bundel.
rmSync(resolve(here, "dist"), { recursive: true, force: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
