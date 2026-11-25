import { describe, expect, it } from "vitest";
import { hasVersionedSegment, stableNodeCommand } from "./node-command.js";

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
