import { describe, expect, it } from "vitest";
import { PullRequestUrlSchema } from "../index.js";

describe("PullRequestUrlSchema", () => {
  it.each([
    ["GitHub", "https://github.com/org/repo/pull/42"],
    ["GitHub http", "http://github.com/org/repo/pull/1"],
    ["GitLab", "https://gitlab.com/org/repo/merge_requests/12"],
    ["GitLab nested group", "https://gitlab.com/org/group/repo/-/merge_requests/99"],
    ["Bitbucket", "https://bitbucket.org/org/repo/pull-requests/7"],
    ["Gitea", "https://gitea.example.com/org/repo/pulls/15"],
    ["Custom host with port", "https://git.internal:8443/team/service/pulls/3"],
  ])("accepts valid %s URL: %s", (_host, url) => {
    expect(PullRequestUrlSchema.safeParse(url).success).toBe(true);
  });

  it("accepts a 240-character URL and rejects URLs over 240 characters", () => {
    const prefix = "https://github.com/org/";
    const suffix = "/pull/1";
    const exact240 = `${prefix}${"r".repeat(240 - prefix.length - suffix.length)}${suffix}`;
    const over240 = `${prefix}${"r".repeat(241 - prefix.length - suffix.length)}${suffix}`;

    expect(exact240).toHaveLength(240);
    expect(over240).toHaveLength(241);
    expect(PullRequestUrlSchema.safeParse(exact240).success).toBe(true);
    expect(PullRequestUrlSchema.safeParse(over240).success).toBe(false);
  });

  it.each([
    ["credentials (user:pass)", "https://user:pass@github.com/org/repo/pull/1"],
    ["credentials (token)", "https://token@github.com/org/repo/pull/1"],
    ["query string", "https://github.com/org/repo/pull/1?tab=files"],
    ["hash fragment", "https://github.com/org/repo/pull/1#discussion"],
    ["GitHub /pull/0", "https://github.com/org/repo/pull/0"],
    ["GitLab /merge_requests/0", "https://gitlab.com/org/repo/merge_requests/0"],
    ["Bitbucket /pull-requests/0", "https://bitbucket.org/org/repo/pull-requests/0"],
    ["Gitea /pulls/0", "https://gitea.example.com/org/repo/pulls/0"],
    ["non-http protocol", "ftp://github.com/org/repo/pull/1"],
    ["missing PR number", "https://github.com/org/repo/pull/"],
    ["missing repo segment", "https://github.com/only-owner/pull/1"],
  ])("rejects invalid URL (%s): %s", (_reason, url) => {
    expect(PullRequestUrlSchema.safeParse(url).success).toBe(false);
  });
});
