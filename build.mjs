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

// esbuild cannot tree-shake `export * as locales` on Zod's `z` namespace object,
// which otherwise pulls all 64 locale files (~265 KB) into dist/index.js.
// Zod registers `en` directly in classic/schemas.js; keeping only `en` here preserves
// default English validation errors and `z.locales.en` while dropping unused locales.
const zodEnOnlyLocalesPlugin = {
  name: "zod-en-only-locales",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /[/\\]zod[/\\]v4[/\\]locales[/\\]index\.js$/ }, () => ({
      contents: 'export { default as en } from "./en.js";\n',
      loader: "js",
    }));
    pluginBuild.onLoad({ filter: /[/\\]zod[/\\]v4[/\\]locales[/\\]index\.cjs$/ }, () => ({
      contents: 'exports.en = require("./en.cjs").default;\n',
      loader: "js",
    }));
  },
};

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
  plugins: [zodEnOnlyLocalesPlugin],
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
