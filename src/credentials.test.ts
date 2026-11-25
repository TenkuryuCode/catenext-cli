import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCredentials, resolveApiUrl, saveCredentials, validateApiKey } from "./credentials.js";

const KEY = "ctnx_abcdefghijklmnopqrstuvwxyz";
const saved = { ...process.env };

beforeEach(async () => {
  process.env.CATENEXT_HOME = await mkdtemp(join(tmpdir(), "catenext-home-"));
  delete process.env.CATENEXT_API_KEY;
  delete process.env.CATENEXT_API_URL;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("credentials", () => {
  it("menyimpan dengan izin 0600 dan bisa dibaca ulang", async () => {
    const path = await saveCredentials({ api_key: KEY, api_url: "http://localhost:8787" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).api_key).toBe(KEY);
    expect(await loadCredentials()).toMatchObject({
      api_key: KEY,
      api_url: "http://localhost:8787",
    });
  });

  it("memberi petunjuk login bila belum ada", async () => {
    await expect(loadCredentials()).rejects.toThrow(/catenext login/);
  });

  it("memvalidasi format key", () => {
    expect(validateApiKey(`  ${KEY}\n`)).toBe(KEY);
    expect(() => validateApiKey("sk-abc")).toThrow(/ctnx_/);
  });

  it("urutan api_url: env > config > credentials > default", () => {
    expect(resolveApiUrl(undefined, undefined)).toBe("http://localhost:8787");
    expect(resolveApiUrl(undefined, "http://c/")).toBe("http://c");
    expect(resolveApiUrl("http://cfg", "http://c")).toBe("http://cfg");
    process.env.CATENEXT_API_URL = "http://env";
    expect(resolveApiUrl("http://cfg", "http://c")).toBe("http://env");
  });
});
