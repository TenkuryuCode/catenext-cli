import { describe, expect, it } from "vitest";
import type { LocalProject } from "./local-state.js";
import { applyProjectSeed, personasForSeed, recommendPersonaAliases } from "./seed.js";

function emptyProject(): LocalProject {
  return {
    repos: [],
    epics: [],
    personas: [],
    tasks: [],
    documents: [],
    permissions: [],
    workspace_roots: [],
    session_prefs: {},
    platform_setup: [],
  };
}

describe("recommendPersonaAliases", () => {
  it("picks fe+be+reviewer for full-stack web", () => {
    expect(recommendPersonaAliases(["node", "react", "hono"])).toEqual(["be", "fe", "reviewer"]);
  });

  it("picks fe+reviewer for frontend-only", () => {
    expect(recommendPersonaAliases(["node", "react", "nextjs"])).toEqual(["fe", "reviewer"]);
  });

  it("picks be+reviewer for API-only", () => {
    expect(recommendPersonaAliases(["go"])).toEqual(["be", "reviewer"]);
  });

  it("includes android when detected", () => {
    expect(recommendPersonaAliases(["android", "kotlin"])).toEqual(["android", "reviewer"]);
  });

  it("falls back to be+fe+reviewer when stack is empty", () => {
    expect(recommendPersonaAliases([])).toEqual(["be", "fe", "reviewer"]);
  });
});

describe("personasForSeed", () => {
  it("matched excludes tester/security/scribe by default", () => {
    const aliases = personasForSeed("matched", ["react", "hono"]).map((p) => p.alias);
    expect(aliases).toEqual(["be", "fe", "reviewer"]);
    expect(aliases).not.toContain("tester");
    expect(aliases).not.toContain("scribe");
  });

  it("all seeds the full catalog", () => {
    expect(personasForSeed("all").map((p) => p.alias)).toEqual([
      "be",
      "fe",
      "tester",
      "android",
      "security",
      "reviewer",
      "scribe",
    ]);
  });
});

describe("applyProjectSeed", () => {
  it("defaults to matched seed and documents the aliases", () => {
    const project = emptyProject();
    applyProjectSeed(project, { stack: ["nextjs", "react"] });
    expect(project.personas.map((p) => p.alias)).toEqual(["fe", "reviewer"]);
    expect(project.documents.find((d) => d.slug === "blueprint")?.content).toContain(
      "fe, reviewer",
    );
  });
});
