import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasVersionedSegment,
  nodeLauncherWarning,
  npxLaunch,
  stableNodeCommand,
  stableScriptPath,
} from "./node-command.js";

const SERVBAY = resolve("/Applications/ServBay/package/node/24/24.21.0/bin/node");

describe("stableNodeCommand", () => {
  it("menulis `node` jika node pertama di PATH adalah binary yang sama", () => {
    const binDir = resolve("/Applications/ServBay/bin");
    const binNode = join(binDir, "node");
    const real = (p: string) => (p === binNode ? SERVBAY : p);
    const exec = (p: string) => p === binNode;
    expect(
      stableNodeCommand(SERVBAY, [resolve("/usr/sbin"), binDir].join(delimiter), real, exec),
    ).toBe("node");
  });

  it("tetap path absolut jika node di PATH adalah binary lain", () => {
    const localBin = resolve("/usr/local/bin");
    const exec = (p: string) => p === join(localBin, "node");
    expect(stableNodeCommand(SERVBAY, localBin, (p) => p, exec)).toBe(SERVBAY);
  });

  it("uses a verified ServBay current link without relying on PATH", () => {
    const current = resolve("/Applications/ServBay/package/node/current/bin/node");
    const localBin = resolve("/usr/local/bin");
    const old = join(localBin, "node");
    const real = (p: string) => (p === current ? SERVBAY : p);
    expect(stableNodeCommand(SERVBAY, localBin, real, (p) => [current, old].includes(p))).toBe(
      current,
    );
    expect(
      stableNodeCommand(
        SERVBAY,
        undefined,
        (p) => p,
        (p) => p === current,
      ),
    ).toBe(SERVBAY);
    expect(stableNodeCommand(SERVBAY, undefined, real, () => false)).toBe(SERVBAY);
  });

  it("does not hide a pinned nvm executable or skip the first PATH executable", () => {
    const nvm = resolve("/home/test/.nvm/versions/node/v22.11.0/bin/node");
    const usrBin = resolve("/usr/bin");
    const testBin = resolve("/home/test/bin");
    const exec = (p: string) => [nvm, join(usrBin, "node"), join(testBin, "node")].includes(p);
    const real = (p: string) => (p === join(testBin, "node") ? nvm : p);
    expect(stableNodeCommand(nvm, dirname(nvm), real, exec)).toBe(nvm);
    expect(stableNodeCommand(nvm, [usrBin, testBin].join(delimiter), real, exec)).toBe(nvm);
    expect(stableNodeCommand(nvm, testBin, real, exec)).toBe("node");
    expect(nodeLauncherWarning(nvm)).toContain("--mcp-command");
    expect(nodeLauncherWarning(resolve("/home/test/.nvm/current/bin/node"))).toBeNull();
    expect(nodeLauncherWarning("node")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("verifies executable files and real symlinks", () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "catenext-node-"));
    try {
      const target = join(dir, "versions/node/v22.11.0/bin/node");
      const currentDir = join(dir, "current");
      const current = join(currentDir, "bin/node");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      symlinkSync(dirname(dirname(target)), currentDir, "dir");
      expect(stableNodeCommand(target, undefined)).toBe(current);
      chmodSync(target, 0o644);
      expect(stableNodeCommand(target, undefined)).toBe(target);
      rmSync(target);
      mkdirSync(target);
      expect(stableNodeCommand(target, undefined)).toBe(target);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("tetap path absolut jika node tidak ada di PATH", () => {
    expect(
      stableNodeCommand(
        SERVBAY,
        "/usr/bin",
        (p) => p,
        () => false,
      ),
    ).toBe(SERVBAY);
    expect(
      stableNodeCommand(
        SERVBAY,
        undefined,
        (p) => p,
        () => false,
      ),
    ).toBe(SERVBAY);
  });
});

describe("hasVersionedSegment", () => {
  it("mengenali folder berversi", () => {
    expect(hasVersionedSegment(SERVBAY)).toBe(true);
    expect(hasVersionedSegment("/Users/a/.nvm/versions/node/v22.11.0/bin/node")).toBe(true);
    expect(hasVersionedSegment("/usr/local/bin/node")).toBe(false);
  });
});

describe("npxLaunch", () => {
  it("memakai npx bila CLI berjalan dari cache npx", () => {
    expect(npxLaunch("/Users/a/.npm/_npx/3e60d89d/node_modules/catenext/dist/index.js")).toEqual({
      command: "npx",
      args: ["-y", "catenext"],
    });
    expect(
      npxLaunch(
        "C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\ab\\node_modules\\catenext\\dist\\index.js",
      ),
    ).not.toBeNull();
  });
  it("tetap memakai path skrip untuk instalasi global atau build lokal", () => {
    expect(npxLaunch("/usr/local/lib/node_modules/catenext/dist/index.js")).toBeNull();
    expect(npxLaunch("/repo/apps/cli/dist/index.js")).toBeNull();
  });
});

describe("stableScriptPath", () => {
  it("resolves versioned ServBay and nvm script paths to current symlink when available", () => {
    const servbayScript = resolve(
      "/Applications/ServBay/package/node/24/24.21.0/lib/node_modules/catenext/dist/index.js",
    );
    const servbayCurrent = resolve(
      "/Applications/ServBay/package/node/current/lib/node_modules/catenext/dist/index.js",
    );
    expect(
      stableScriptPath(
        servbayScript,
        (p) => (p === servbayCurrent ? servbayScript : p),
        (p) => p === servbayCurrent,
      ),
    ).toBe(servbayCurrent);

    const nvmScript = resolve(
      "/home/test/.nvm/versions/node/v22.11.0/lib/node_modules/catenext/dist/index.js",
    );
    const nvmCurrent = resolve("/home/test/.nvm/current/lib/node_modules/catenext/dist/index.js");
    expect(
      stableScriptPath(
        nvmScript,
        (p) => (p === nvmCurrent ? nvmScript : p),
        (p) => p === nvmCurrent,
      ),
    ).toBe(nvmCurrent);
  });

  it("keeps relative or unpinned script paths unchanged", () => {
    expect(stableScriptPath("cli.js")).toBe("cli.js");
    expect(
      stableScriptPath(
        resolve("/repo/apps/cli/dist/index.js"),
        (p) => p,
        () => true,
      ),
    ).toBe(resolve("/repo/apps/cli/dist/index.js"));
  });
});
