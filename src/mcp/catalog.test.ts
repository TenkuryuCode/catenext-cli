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
  TOOL_ANNOTATIONS,
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
    // Compact catalog includes standard MCP annotations on every tool, so allow up to 75% of raw.
    expect(compactJson.length).toBeLessThan(rawJson.length * 0.75);
    expect(estimateTokens(compactJson)).toBeLessThan(estimateTokens(rawJson) * 0.75);
    expect(workerJson.length).toBeLessThan(rawJson.length * 0.45);
  });

  it("exposes standard MCP tool annotations on every tool in the catalog", () => {
    const fullCatalog = buildMcpToolCatalog(undefined, true);
    expect(fullCatalog).toHaveLength(MCP_TOOL_NAMES.length);

    for (const name of MCP_TOOL_NAMES) {
      const ann = TOOL_ANNOTATIONS[name];
      expect(ann, `missing annotations for ${name}`).toBeDefined();
      expect(typeof ann.readOnlyHint).toBe("boolean");
      expect(typeof ann.destructiveHint).toBe("boolean");
      expect(typeof ann.idempotentHint).toBe("boolean");
      expect(typeof ann.openWorldHint).toBe("boolean");
      expect(ann.openWorldHint).toBe(false);

      const entry = fullCatalog.find((t) => t.name === name);
      expect(entry?.annotations).toEqual(ann);
    }

    const readOnlyTools = [
      "get_project_board",
      "search_context",
      "get_document",
      "get_project_context",
      "get_ready_tasks",
      "list_epics",
      "list_personas",
      "load_skill",
      "interview_setup",
      "session_brief",
      "graph_neighbors",
      "symbol_search",
      "graph_summary",
      "graph_impact",
    ] as const;
    for (const name of readOnlyTools) {
      expect(TOOL_ANNOTATIONS[name]).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }

    const destructiveTools = [
      "cancel_task",
      "remove_persona",
      "archive_document",
      "manage_roots",
    ] as const;
    for (const name of destructiveTools) {
      expect(TOOL_ANNOTATIONS[name].readOnlyHint).toBe(false);
      expect(TOOL_ANNOTATIONS[name].destructiveHint).toBe(true);
    }
  });

  it("hides human approve actions from manage_task MCP tools/list schema", () => {
    const tool = buildMcpToolCatalog("orchestrator").find((t) => t.name === "manage_task");
    expect(tool).toBeDefined();
    const schemaJson = JSON.stringify(tool?.inputSchema);
    expect(schemaJson).not.toContain("approve_plan");
    expect(schemaJson).not.toMatch(/"approve"/);
    expect(schemaJson).toContain("request_revision");
    expect(schemaJson).toContain("assign");
    // Runtime schema still accepts human approve for CLI callers.
    expect(
      MCP_TOOLS.manage_task.input.safeParse({
        action: "approve",
        task_id: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(true);
  });

  it("filters tool lists by role and preserves full default tool set", () => {
    expect(toolsForRole()).toEqual(MCP_TOOL_NAMES.filter((name) => !isMcpCrudTool(name)));
    expect(toolsForRole()).toHaveLength(29);

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

  it("attaches compact object outputSchema to every tool in the catalog", () => {
    const fullCatalog = buildMcpToolCatalog(undefined, true);
    expect(fullCatalog).toHaveLength(MCP_TOOL_NAMES.length);
    for (const tool of fullCatalog) {
      expect(tool.outputSchema).toEqual({ type: "object" });
    }
  });
});
