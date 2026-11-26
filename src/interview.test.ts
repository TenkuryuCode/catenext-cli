import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PLATFORMS, SUPPORTED_PLATFORMS } from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInterviewSetup, parsePlatformChoices, runInitInterview } from "./interview.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-interview-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildInterviewSetup", () => {
  it("defaults to DEFAULT_PLATFORMS and excludes windsurf when no platform hints exist", () => {
    const res = buildInterviewSetup(root);
    expect(res.step).toBe("platform");
    expect(res.locale_hint).toBe("follow_user");
    expect(res.recommended_ids).toEqual([...DEFAULT_PLATFORMS]);
    expect(res.options.map((o) => o.id)).not.toContain("windsurf");
    expect(res.options.map((o) => o.id)).toEqual(
      SUPPORTED_PLATFORMS.filter((id) => id !== "windsurf"),
    );

    const claude = res.options.find((o) => o.id === "claude-code");
    const vscode = res.options.find((o) => o.id === "vscode");
    expect(claude).toMatchObject({ recommended: true, why: "Common default for this CLI." });
    expect(vscode).toMatchObject({ recommended: false, why: "Optional platform." });
  });

  it("recommends detected platforms from project files and annotates why", async () => {
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".mcp.json"), "{}");
    await mkdir(join(root, ".codex"), { recursive: true });
    await mkdir(join(root, ".agents"), { recursive: true });
    await mkdir(join(root, ".opencode"), { recursive: true });
    await mkdir(join(root, ".vscode"), { recursive: true });

    const res = buildInterviewSetup(root, "platform");
    expect(res.recommended_ids).toEqual([
      "cursor",
      "claude-code",
      "codex",
      "antigravity",
      "opencode",
      "vscode",
    ]);
    for (const opt of res.options) {
      expect(opt.recommended).toBe(true);
      expect(opt.why).toMatch(/^Detected /);
    }
  });

  it("builds personas setup cards formatted with detected stack or unknown", () => {
    const unknown = buildInterviewSetup(root, "personas", []);
    expect(unknown.step).toBe("personas");
    expect(unknown.recommended_ids).toEqual(["matched"]);
    expect(unknown.options.map((o) => o.id)).toEqual(["matched", "minimal", "all", "none"]);
    expect(unknown.options[0]?.why).toContain("Matched to stack [unknown].");
    expect(unknown.options[0]?.label).toContain("be, fe, reviewer");

    const stacked = buildInterviewSetup(root, "personas", ["react", "hono", "android"]);
    expect(stacked.options[0]?.why).toContain("Matched to stack [react, hono, android].");
    expect(stacked.options[0]?.label).toBe("Seed for this repo: be, fe, android, reviewer");

    const backendOnly = buildInterviewSetup(root, "personas", ["node", "typescript"]);
    expect(backendOnly.options[0]?.label).toBe("Seed for this repo: be, reviewer");
  });

  it("builds locale setup cards with follow_user recommended", () => {
    const res = buildInterviewSetup(root, "locale");
    expect(res.step).toBe("locale");
    expect(res.locale_hint).toBe("follow_user");
    expect(res.recommended_ids).toEqual(["follow_user"]);
    expect(res.options.map((o) => ({ id: o.id, recommended: o.recommended }))).toEqual([
      { id: "follow_user", recommended: true },
      { id: "en", recommended: false },
      { id: "id", recommended: false },
    ]);
  });
});

describe("parsePlatformChoices", () => {
  it("supports recommended/default keywords, deduplicates, and filters windsurf", () => {
    expect(parsePlatformChoices("recommended")).toEqual([...DEFAULT_PLATFORMS]);
    expect(parsePlatformChoices("default")).toEqual([...DEFAULT_PLATFORMS]);
    expect(parsePlatformChoices("cursor, claude-code  cursor windsurf codex")).toEqual([
      "cursor",
      "claude-code",
      "codex",
    ]);
  });

  it("throws on unsupported platform identifiers", () => {
    expect(() => parsePlatformChoices("cursor, notepad")).toThrow(/Unsupported platform: notepad/);
  });
});

describe("runInitInterview", () => {
  it("returns detected stack, recommended or overridden platforms, and defaults in --yes mode", async () => {
    await mkdir(join(root, ".opencode"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { hono: "4.0.0", react: "19.0.0" } }),
    );

    const detected = await runInitInterview(root, { yes: true });
    expect(detected).toEqual({
      platforms: ["opencode"],
      personaSeed: "matched",
      locale: "follow_user",
      stack: ["node", "react", "hono"],
    });

    const overridden = await runInitInterview(root, {
      yes: true,
      platforms: ["claude-code", "codex"],
    });
    expect(overridden.platforms).toEqual(["claude-code", "codex"]);
    expect(overridden.stack).toEqual(["node", "react", "hono"]);
  });
});
