import { describe, expect, it } from "vitest";
import { hasVersionedSegment, npxLaunch, stableNodeCommand } from "./node-command.js";

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
