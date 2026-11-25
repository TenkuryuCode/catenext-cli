// Bundel CLI menjadi satu file dist/index.js untuk npm. @catenext/shared (private, tidak
// dipublikasikan) ikut di-bundle dari source; dependensi npm lain tetap eksternal.
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

const options = {
  entryPoints: [resolve(here, "src/index.ts")],
  outfile: resolve(here, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  alias: { "@catenext/shared": shared },
  external: Object.keys(pkg.dependencies ?? {}),
  define: {
    // Versi & URL API default ditanam saat build (rilis npm mengisi CATENEXT_DEFAULT_API_URL).
    "process.env.CATENEXT_BUILD_VERSION": JSON.stringify(pkg.version),
    "process.env.CATENEXT_BUILD_API_URL": JSON.stringify(
      process.env.CATENEXT_DEFAULT_API_URL ?? "",
    ),
  },
  logLevel: "info",
};

// Bersihkan sisa build lama (mis. keluaran tsc per file) agar paket npm hanya berisi bundel.
rmSync(resolve(here, "dist"), { recursive: true, force: true });

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
