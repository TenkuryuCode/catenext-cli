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
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasVersionedSegment,
  nodeLauncherWarning,
  npxLaunch,
  stableNodeCommand,
} from "./node-command.js";

const SERVBAY = "/Applications/ServBay/package/node/24/24.21.0/bin/node";

describe("stableNodeCommand", () => {
  it("menulis `node` jika node pertama di PATH adalah binary yang sama", () => {
    const real = (p: string) => (p === "/Applications/ServBay/bin/node" ? SERVBAY : p);
    const exec = (p: string) => p === "/Applications/ServBay/bin/node";
    expect(stableNodeCommand(SERVBAY, "/usr/sbin:/Applications/ServBay/bin", real, exec)).toBe(
      "node",
    );
  });

  it("tetap path absolut jika node di PATH adalah binary lain", () => {
    const exec = (p: string) => p === "/usr/local/bin/node";
    expect(stableNodeCommand(SERVBAY, "/usr/local/bin", (p) => p, exec)).toBe(SERVBAY);
  });

  it("uses a verified ServBay current link without relying on PATH", () => {
    const current = "/Applications/ServBay/package/node/current/bin/node";
    const old = "/usr/local/bin/node";
    const real = (p: string) => (p === current ? SERVBAY : p);
    expect(
      stableNodeCommand(SERVBAY, "/usr/local/bin", real, (p) => [current, old].includes(p)),
    ).toBe(current);
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
    const nvm = "/home/test/.nvm/versions/node/v22.11.0/bin/node";
    const exec = (p: string) => [nvm, "/usr/bin/node", "/home/test/bin/node"].includes(p);
    const real = (p: string) => (p === "/home/test/bin/node" ? nvm : p);
    expect(stableNodeCommand(nvm, dirname(nvm), real, exec)).toBe(nvm);
    expect(stableNodeCommand(nvm, "/usr/bin:/home/test/bin", real, exec)).toBe(nvm);
    expect(stableNodeCommand(nvm, "/home/test/bin", real, exec)).toBe("node");
    expect(nodeLauncherWarning(nvm)).toContain("--mcp-command");
    expect(nodeLauncherWarning("/home/test/.nvm/current/bin/node")).toBeNull();
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
