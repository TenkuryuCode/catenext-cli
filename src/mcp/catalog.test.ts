import {
  estimateTokens,
  isMcpCrudTool,
  MCP_CRUD_TOOLS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
} from "@catenext/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildMcpToolCatalog,
  compactJsonSchema,
  ROLE_TOOLS,
  TOOL_DESCRIPTIONS,
  toolsForRole,
  zodToCompactJsonSchema,
} from "./catalog.js";

function collectNodes(
  value: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, out);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    out.push(obj);
    for (const inner of Object.values(obj)) collectNodes(inner, out);
  }
  return out;
}

describe("MCP tool catalog compaction & role filtering", () => {
  it("uses crisp <=12-word 1-line descriptions for every tool", () => {
    for (const name of MCP_TOOL_NAMES) {
      const desc = TOOL_DESCRIPTIONS[name];
      expect(desc.length).toBeGreaterThan(0);
      expect(desc).not.toContain("\n");
      const words = desc.trim().split(/\s+/);
      expect(words.length, `${name}: "${desc}"`).toBeLessThanOrEqual(12);
    }
  });

  it("strips verbose UUID regex patterns while keeping format: uuid and root $schema removal", () => {
    const schema = zodToCompactJsonSchema(MCP_TOOLS.claim_task.input);
    expect(schema).not.toHaveProperty("$schema");
    const nodes = collectNodes(schema);
    const uuidNodes = nodes.filter((n) => n.format === "uuid");
    expect(uuidNodes.length).toBeGreaterThanOrEqual(2);
    for (const node of uuidNodes) {
      expect(node).not.toHaveProperty("pattern");
    }

    const raw = z.toJSONSchema(MCP_TOOLS.claim_task.input, { target: "draft-7", io: "input" });
    expect(JSON.stringify(raw)).toContain("[0-9a-fA-F]{8}");
    expect(JSON.stringify(compactJsonSchema(raw))).not.toContain("[0-9a-fA-F]{8}");
    expect(JSON.stringify(compactJsonSchema(raw))).toContain("^[a-zA-Z0-9_./-]+$");
  });

  it("significantly reduces tools/list payload bytes and estimated tokens vs raw schemas", () => {
    const rawCatalog = MCP_TOOL_NAMES.map((name) => ({
      name,
      description: MCP_TOOLS[name].description,
      inputSchema: z.toJSONSchema(MCP_TOOLS[name].input, { target: "draft-7", io: "input" }),
    }));
    const compactCatalog = buildMcpToolCatalog();
    const workerCatalog = buildMcpToolCatalog("worker");

    const rawJson = JSON.stringify(rawCatalog);
    const compactJson = JSON.stringify(compactCatalog);
    const workerJson = JSON.stringify(workerCatalog);
    expect(compactJson.length).toBeLessThan(rawJson.length * 0.7);
    expect(estimateTokens(compactJson)).toBeLessThan(estimateTokens(rawJson) * 0.7);
    expect(workerJson.length).toBeLessThan(rawJson.length * 0.45);
  });

  it("filters tool lists by role and preserves full default tool set", () => {
    expect(toolsForRole()).toEqual(MCP_TOOL_NAMES.filter((name) => !isMcpCrudTool(name)));
    expect(toolsForRole()).toHaveLength(28);

    const orch = toolsForRole("orchestrator");
    expect(orch).toEqual([...ROLE_TOOLS.orchestrator]);
    expect(orch).toContain("session_brief");
    expect(orch).toContain("create_tasks");
    expect(orch).toContain("manage_task");
    expect(orch).not.toContain("claim_task");
    expect(orch).not.toContain("complete_handoff");

    const worker = toolsForRole("worker");
    expect(worker).toEqual([...ROLE_TOOLS.worker]);
    expect(worker).toContain("get_ready_tasks");
    expect(worker).toContain("claim_task");
    expect(worker).toContain("complete_handoff");
    expect(worker).not.toContain("create_tasks");
    expect(worker).not.toContain("manage_task");
    expect(worker).not.toContain("upsert_persona");

    expect(buildMcpToolCatalog("worker").length).toBe(worker.length);
    expect(buildMcpToolCatalog("orchestrator").length).toBe(orch.length);
    expect(toolsForRole(undefined, true)).toEqual([...MCP_TOOL_NAMES]);
    expect(toolsForRole("orchestrator", true)).toEqual([...orch, ...MCP_CRUD_TOOLS]);
    expect(toolsForRole("worker", true)).toEqual(worker);
  });
});
