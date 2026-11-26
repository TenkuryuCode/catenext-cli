import { describe, expect, it } from "vitest";
import { resolveStart } from "./run.js";

describe("resolveStart (--root fail closed)", () => {
  it("tanpa --root memakai cwd", () => {
    expect(resolveStart(undefined, "/repo")).toBe("/repo");
  });

  it("menerima path absolut apa adanya", () => {
    expect(resolveStart("/abs/repo", "/repo")).toBe("/abs/repo");
  });

  it("menolak placeholder yang tidak ter-expand alih-alih jatuh ke cwd", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: string literal placeholder yang sengaja diuji.
    expect(resolveStart("${CLAUDE_PROJECT_DIR}", "/other")).toBeNull();
  });

  it("menolak --root kosong atau spasi saja", () => {
    expect(resolveStart("", "/other")).toBeNull();
    expect(resolveStart("   ", "/other")).toBeNull();
  });
});
