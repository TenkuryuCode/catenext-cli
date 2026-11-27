import { describe, expect, it } from "vitest";
import { checkoutPathKey, parseLinkedRunWorktrees } from "./epic-run-git.js";

describe("checkoutPathKey win32 forms", () => {
  it("equates forward-slash Git porcelain paths with backslash Node paths", () => {
    const gitForm = "D:/a/catenext/catenext/wt-a";
    const nodeForm = "D:\\a\\catenext\\catenext\\wt-a";
    expect(checkoutPathKey(gitForm, "win32")).toBe(checkoutPathKey(nodeForm, "win32"));
  });

  it("strips extended-length \\\\?\\ prefixes and case-folds", () => {
    const extended = "\\\\?\\D:\\a\\Catenext\\wt-a";
    const plain = "d:/a/catenext/wt-a";
    expect(checkoutPathKey(extended, "win32")).toBe(checkoutPathKey(plain, "win32"));
  });

  it("strips //?/ forward-slash namespace prefixes", () => {
    const namespaced = "//?/D:/a/catenext/wt-a";
    const plain = "D:\\a\\catenext\\wt-a";
    expect(checkoutPathKey(namespaced, "win32")).toBe(checkoutPathKey(plain, "win32"));
  });

  it("collapses .. segments and trailing separators", () => {
    const alias = "D:\\a\\catenext\\wt-a\\..\\wt-a\\";
    const canonical = "D:/a/catenext/wt-a";
    expect(checkoutPathKey(alias, "win32")).toBe(checkoutPathKey(canonical, "win32"));
  });

  it("trims trailing CR left by mixed CRLF porcelain hosts", () => {
    const withCr = "D:/a/catenext/wt-a\r";
    const clean = "D:\\a\\catenext\\wt-a";
    expect(checkoutPathKey(withCr, "win32")).toBe(checkoutPathKey(clean, "win32"));
  });
});

describe("parseLinkedRunWorktrees win32 porcelain fixtures", () => {
  const epic = "11111111-1111-1111-1111-111111111111";
  const task = "22222222-2222-2222-2222-222222222222";
  const prefix = `catenext/run/${epic}`;
  const branch = `${prefix}/${task}`;

  it("keeps linked checkout when Git emits forward-slash Windows paths", () => {
    const porcelain = [
      "worktree D:/a/catenext/catenext",
      "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "branch refs/heads/main",
      "",
      "worktree D:/a/catenext/wt-a",
      "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      `branch refs/heads/${branch}`,
      "",
      "",
    ].join("\0");
    const linked = parseLinkedRunWorktrees(porcelain, prefix);
    expect(linked).toEqual([{ path: "D:/a/catenext/wt-a", branch, prunable: false }]);
  });

  it("assigns branch after CR-tainted fields and skips primary", () => {
    const porcelain = [
      "worktree C:/Users/runneradmin/AppData/Local/Temp/repo\r",
      "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\r",
      "branch refs/heads/main\r",
      "",
      "worktree C:/Users/runneradmin/AppData/Local/Temp/wt-a\r",
      "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\r",
      `branch refs/heads/${branch}\r`,
      "",
      "",
    ].join("\0");
    const linked = parseLinkedRunWorktrees(porcelain, prefix);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.branch).toBe(branch);
    expect(linked[0]?.path).toBe("C:/Users/runneradmin/AppData/Local/Temp/wt-a");
  });

  it("drops entries outside the run prefix and prunable peers stay listed", () => {
    const other = `catenext/run/${epic}/other`;
    const porcelain = [
      "worktree D:/repo",
      "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "branch refs/heads/main",
      "",
      "worktree D:/wt-a",
      "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      `branch refs/heads/${branch}`,
      "",
      "worktree D:/wt-other",
      "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      `branch refs/heads/${other}`,
      "prunable",
      "",
      "worktree D:/wt-noise",
      "HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "branch refs/heads/feature/x",
      "",
      "",
    ].join("\0");
    const linked = parseLinkedRunWorktrees(porcelain, prefix);
    expect(linked).toEqual([
      { path: "D:/wt-a", branch, prunable: false },
      { path: "D:/wt-other", branch: other, prunable: true },
    ]);
  });
});
