import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema } from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalService } from "./local-service.js";
import { saveSkill } from "./skills.js";
import {
  buildTemplateBundle,
  importTemplateBundle,
  loadTemplateBundle,
  TEMPLATE_BUNDLE_KIND,
  TEMPLATE_BUNDLE_SCHEMA_VERSION,
  TemplateBundleError,
  writeTemplateBundle,
} from "./template-bundle.js";

let root: string;
let service: LocalService;
const config = () =>
  CatenextConfigSchema.parse({
    schema_version: 1,
    project_id: randomUUID(),
    project_name: "TemplateTest",
    repo_name: "be",
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-tpl-"));
  service = new LocalService(root, config());
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("template bundle export/import", () => {
  it("exports personas + skills and round-trips import", async () => {
    await service.callTool("upsert_persona", {
      alias: "be",
      role: "backend",
      rules: ["Own apps/api"],
      repos: ["be"],
    });
    await saveSkill(root, {
      name: "api-style",
      when_to_use: "When changing REST handlers",
      content: "Prefer path refs. Never paste secrets.\n",
    });

    const { bundle } = await buildTemplateBundle(service, root, config());
    expect(bundle.kind).toBe(TEMPLATE_BUNDLE_KIND);
    expect(bundle.schema_version).toBe(TEMPLATE_BUNDLE_SCHEMA_VERSION);
    expect(bundle.personas).toHaveLength(1);
    expect(bundle.personas[0]?.alias).toBe("be");
    expect(bundle.skills.map((s) => s.name)).toEqual(["api-style"]);

    const out = join(root, "bundle.json");
    await writeTemplateBundle(out, bundle);

    const targetRoot = await mkdtemp(join(tmpdir(), "catenext-tpl-in-"));
    try {
      const target = new LocalService(targetRoot, config());
      const loaded = await loadTemplateBundle(out);
      const result = await importTemplateBundle(target, targetRoot, loaded.bundle);
      expect(result.personas.created).toEqual(["be"]);
      expect(result.skills.created).toEqual(["api-style"]);
      const listed = await target.callTool("list_personas", {});
      expect(listed.personas[0]?.alias).toBe("be");
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  it("scrubs secrets on load and rejects leftover secret text", async () => {
    const dirty = join(root, "dirty.json");
    await writeFile(
      dirty,
      JSON.stringify({
        kind: TEMPLATE_BUNDLE_KIND,
        schema_version: TEMPLATE_BUNDLE_SCHEMA_VERSION,
        exported_at: new Date().toISOString(),
        personas: [
          {
            alias: "be",
            role: "backend",
            rules: ["token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
            repos: [],
          },
        ],
        skills: [],
      }),
    );
    const loaded = await loadTemplateBundle(dirty);
    expect(loaded.redacted).toBeGreaterThan(0);
    expect(loaded.bundle.personas[0]?.rules.join("\n")).toContain("[REDACTED:");
    expect(loaded.bundle.personas[0]?.rules.join("\n")).not.toContain("ghp_");
  });

  it("rejects invalid bundles and supports dry-run / personas-only", async () => {
    const bad = join(root, "bad.json");
    await writeFile(bad, JSON.stringify({ kind: "nope" }));
    await expect(loadTemplateBundle(bad)).rejects.toBeInstanceOf(TemplateBundleError);

    await service.callTool("upsert_persona", {
      alias: "fe",
      role: "frontend",
      rules: ["UI only"],
      repos: [],
    });
    const { bundle } = await buildTemplateBundle(service, root, config());
    const out = join(root, "ok.json");
    await writeTemplateBundle(out, bundle);

    const targetRoot = await mkdtemp(join(tmpdir(), "catenext-tpl-dry-"));
    try {
      const target = new LocalService(targetRoot, config());
      const loaded = await loadTemplateBundle(out);
      const dry = await importTemplateBundle(target, targetRoot, loaded.bundle, { dryRun: true });
      expect(dry.dry_run).toBe(true);
      expect(dry.personas.created).toEqual(["fe"]);
      expect((await target.callTool("list_personas", {})).personas).toEqual([]);

      const personasOnly = await importTemplateBundle(target, targetRoot, loaded.bundle, {
        skills: false,
      });
      expect(personasOnly.personas.created).toEqual(["fe"]);
      expect(personasOnly.skills.created).toEqual([]);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});
