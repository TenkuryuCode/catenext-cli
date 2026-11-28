import { describe, expect, it } from "vitest";
import { BRIEF_LIMITS, briefText, findScopeFileOverlaps } from "../index.js";

describe("findScopeFileOverlaps", () => {
  it("normalizes slashes, leading ./, and trailing slashes across file and directory scopes", () => {
    const overlaps = findScopeFileOverlaps([
      { id: "t1", scope_files: ["./src\\api\\route.ts", "src/shared/"] },
      { id: "t2", scope_files: ["src/api/route.ts", "./src/shared/util.ts"] },
    ]);

    expect(overlaps).toEqual([
      { path: "src/api/route.ts", task_ids: ["t1", "t2"] },
      { path: "src/shared/util.ts", task_ids: ["t1", "t2"] },
    ]);
  });

  it("matches glob-vs-file patterns including **, *, ?, and regex metacharacters", () => {
    const overlaps = findScopeFileOverlaps([
      { id: "t1", scope_files: ["src/**/*.ts", "apps/cli/v1+2/a?.ts"] },
      {
        id: "t2",
        scope_files: ["src/api/route.ts", "src/root.ts", "apps/cli/v1+2/ab.ts", "other/x.ts"],
      },
      { id: "t3", scope_files: ["src/nested/deep/file.tsx"] },
    ]);

    expect(overlaps).toEqual([
      { path: "apps/cli/v1+2/ab.ts", task_ids: ["t1", "t2"] },
      { path: "src/api/route.ts", task_ids: ["t1", "t2"] },
      { path: "src/root.ts", task_ids: ["t1", "t2"] },
    ]);
  });

  it("treats identical normalized globs as overlapping and distinct globs as non-overlapping", () => {
    expect(
      findScopeFileOverlaps([
        { id: "t1", scope_files: ["./src/**/*.ts"] },
        { id: "t2", scope_files: ["src/**/*.ts"] },
      ]),
    ).toEqual([{ path: "src/**/*.ts", task_ids: ["t1", "t2"] }]);

    expect(
      findScopeFileOverlaps([
        { id: "t1", scope_files: ["src/**/*.ts"] },
        { id: "t2", scope_files: ["src/api/*.ts"] },
      ]),
    ).toEqual([]);
  });

  it("compares null/unnamed target_repo against named repos, and skips mismatched named repos", () => {
    const overlaps = findScopeFileOverlaps([
      { id: "t-null", target_repo: null, scope_files: ["src/index.ts"] },
      { id: "t-api-1", target_repo: "api", scope_files: ["src/index.ts"] },
      { id: "t-api-2", target_repo: "api", scope_files: ["src/index.ts"] },
      { id: "t-web", target_repo: "web", scope_files: ["src/index.ts"] },
    ]);

    expect(overlaps).toEqual([
      { path: "src/index.ts", task_ids: ["t-null", "t-api-1", "t-api-2", "t-web"] },
    ]);

    expect(
      findScopeFileOverlaps([
        { id: "t-api", target_repo: "api", scope_files: ["src/index.ts"] },
        { id: "t-web", target_repo: "web", scope_files: ["src/index.ts"] },
      ]),
    ).toEqual([]);
  });

  it("skips direct dependencies while still flagging transitive pairs not directly linked", () => {
    const overlaps = findScopeFileOverlaps([
      { id: "a", scope_files: ["src/shared.ts"] },
      { id: "b", dependencies: ["a"], scope_files: ["src/shared.ts"] },
      { id: "c", dependencies: ["b"], scope_files: ["src/shared.ts"] },
    ]);

    expect(overlaps).toEqual([{ path: "src/shared.ts", task_ids: ["a", "c"] }]);
  });

  it("returns empty when fewer than two tasks have non-empty scope_files", () => {
    expect(findScopeFileOverlaps([{ id: "t1", scope_files: ["src/a.ts"] }])).toEqual([]);
    expect(
      findScopeFileOverlaps([
        { id: "t1", scope_files: ["src/a.ts"] },
        { id: "t2", scope_files: [] },
        { id: "t3" },
      ]),
    ).toEqual([]);
  });
});

describe("briefText", () => {
  it("collapses whitespace and preserves text within max length", () => {
    expect(briefText("  hello \n\t  world  ")).toBe("hello world");
    const exact = "x".repeat(BRIEF_LIMITS.line);
    expect(briefText(exact)).toBe(exact);
  });

  it("truncates text exceeding max length with an ellipsis", () => {
    expect(briefText("abcdef", 5)).toBe("abcd…");
    expect(briefText("abcdef", 1)).toBe("…");
    expect(briefText("a".repeat(BRIEF_LIMITS.line + 10))).toBe(
      `${"a".repeat(BRIEF_LIMITS.line - 1)}…`,
    );
  });
});
