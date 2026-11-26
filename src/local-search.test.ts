import { describe, expect, it } from "vitest";
import { searchLocalContext } from "./local-search.js";

describe("searchLocalContext", () => {
  it("ranks title hits above body hits and respects limit", () => {
    const hits = searchLocalContext(
      "auth token",
      [
        { source: "task", ref: "t1", title: "Setup DB", text: "Store auth token hash in table." },
        { source: "document", ref: "auth", title: "Auth Token Flow", text: "Uses auth token." },
        { source: "skill", ref: "be:lint", title: "Lint", text: "Run biome check." },
      ],
      2,
    );
    expect(hits).toHaveLength(2);
    expect(hits[0]?.ref).toBe("auth");
    expect(hits[1]?.ref).toBe("t1");
  });

  it("returns empty array for punctuation-only query", () => {
    expect(
      searchLocalContext("---", [{ source: "document", ref: "a", title: "A", text: "hello" }], 5),
    ).toEqual([]);
  });
});
