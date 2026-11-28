import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CatenextConfigSchema, MCP_CRUD_TOOLS, type McpToolName } from "@catenext/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { stateFilePath } from "../config.js";
import { indexProjectGraph } from "../db/graph-index.js";
import { LocalStore } from "../db/store.js";
import { LocalService } from "../local-service.js";
import { scrubText } from "../scrubber.js";
import { ROLE_TOOLS } from "./catalog.js";
import {
  createCatenextMcpServer,
  LOCAL_TOOLS,
  SERVER_INSTRUCTIONS,
  type ServerContext,
} from "./server.js";
import type { McpTransport } from "./stdio.js";

const TASK = "11111111-2222-4333-8444-555555555555";

interface Captured {
  name: McpToolName;
  body: unknown;
}

let close: (() => Promise<void>) | undefined;
let root: string | undefined;
afterEach(async () => {
  await close?.();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup(
  respond = (_call: Captured): unknown => ({ ok: 1 }),
  ctxOverride?: ServerContext,
  role?: "orchestrator" | "worker" | "reviewer",
  allowCrud?: boolean,
) {
  const calls: Captured[] = [];
  const service = {
    async callTool(name: McpToolName, body: unknown) {
      const call = { name, body };
      calls.push(call);
      return respond(call);
    },
  } as Extract<ServerContext, { ok: true }>["service"];
  const logs: string[] = [];
  root = await mkdtemp(join(tmpdir(), "catenext-mcp-"));
  const repoRoot = root;
  const server = createCatenextMcpServer({
    version: "test",
    context: async () => ctxOverride ?? { ok: true, service, root: repoRoot },
    log: (m) => logs.push(m),
    role,
    allowCrud,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  // The SDK's in-memory transport omits the ID for errors it cannot correlate.
  // Keep that convention in this test adapter; stdio tests assert the wire ID is null.
  const transport: McpTransport = {
    async start() {
      a.onmessage = transport.onmessage;
      a.onclose = transport.onclose;
      await a.start();
    },
    close: () => a.close(),
    send: (msg) => a.send("error" in msg ? { ...msg, id: msg.id ?? undefined } : msg),
  };
  await Promise.all([server.connect(transport), client.connect(b)]);
  close = async () => {
    await client.close();
    await server.close();
  };
  return { client, calls, logs, root: repoRoot };
}

const textOf = (r: unknown) =>
  ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

const HANDOFF_SHA = "a".repeat(40);
const HANDOFF = {
  files_modified: ["apps/api/src/app.ts"],
  key_decisions: ["Pakai Hono"],
  verification_command: "pnpm test",
  notes_for_next_agent: "Endpoint siap dipakai frontend.",
  git_branch: "feat/x",
  last_commit_hash: HANDOFF_SHA,
  pull_request: {
    url: "https://github.com/example/repo/pull/1",
    base_branch: "main",
    head_sha: HANDOFF_SHA,
  },
};

describe("server MCP catenext", () => {
  it("mengekspos tool lokal tanpa input project_id/repo_name", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...LOCAL_TOOLS].sort());
    for (const t of tools) {
      const props = Object.keys(t.inputSchema.properties ?? {});
      expect(props).not.toContain("project_id");
      expect(props).not.toContain("repo_name");
    }
  });

  it("meneruskan nama tool dan input tervalidasi ke layanan lokal", async () => {
    const { client, calls } = await setup();
    await client.callTool({ name: "get_ready_tasks", arguments: {} });
    expect(calls).toEqual([{ name: "get_ready_tasks", body: { limit: 10 } }]);
  });

  it.each([
    ["approve_plan", "catenext task approve"],
    ["approve", "catenext review approve"],
  ])("rejects %s over JSON-RPC without forwarding to the service", async (action, command) => {
    const { client, calls } = await setup(undefined, undefined, "orchestrator");
    const result = await client.callTool({
      name: "manage_task",
      arguments: { action, task_id: TASK, caller: "human", agent_alias: "human" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`${command} ${TASK}`);
    expect(calls).toEqual([]);

    const revision = await client.callTool({
      name: "manage_task",
      arguments: { action: "request_revision", task_id: TASK, feedback: "Add test coverage" },
    });
    expect(revision.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  it("tidak meneruskan project_id dari agen", async () => {
    const { client, calls } = await setup();
    await client.callTool({
      name: "claim_task",
      arguments: { task_id: TASK, project_id: "00000000-0000-4000-8000-000000000000" },
    });
    expect(calls).toEqual([{ name: "claim_task", body: { task_id: TASK } }]);
  });

  it("menyensor secret di handoff sebelum disimpan dan memberi tahu agen", async () => {
    const { client, calls, logs } = await setup();
    const res = await client.callTool({
      name: "complete_handoff",
      arguments: {
        lease_id: TASK,
        task_id: TASK,
        handoff_summary: {
          ...HANDOFF,
          notes_for_next_agent: "Isi STRIPE_SECRET=sk_live_abcdefghijklmnop di .env",
        },
      },
    });
    const sent = JSON.stringify(calls[0]?.body);
    expect(sent).not.toContain("sk_live_abcdefghijklmnop");
    expect(sent).toContain("[REDACTED:");
    expect(textOf(res)).toMatch(/secret scrubber menyensor/i);
    expect(logs).toHaveLength(1);
  });

  it("menolak handoff yang melebihi batas ukuran tanpa memanggil layanan lokal", async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({
      name: "complete_handoff",
      arguments: {
        lease_id: TASK,
        task_id: TASK,
        handoff_summary: {
          ...HANDOFF,
          files_modified: Array.from({ length: 16 }, (_, i) => `f${i}.ts`),
        },
      },
    });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("menampilkan pesan error layanan lokal", async () => {
    const { client } = await setup(() => {
      throw new Error("Repo backend sedang mengerjakan task lain.");
    });
    const res = await client.callTool({ name: "claim_task", arguments: { task_id: TASK } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Repo backend sedang mengerjakan task lain.");
  });

  it("memberi langkah perbaikan bila belum init", async () => {
    const { client, calls } = await setup(undefined, {
      ok: false,
      error: "Jalankan `catenext init`.",
    });
    const res = await client.callTool({ name: "get_project_context", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("catenext init");
    expect(calls).toHaveLength(0);
  });

  it("create_epic dan list_epics memakai layanan lokal", async () => {
    const { client, calls } = await setup();
    await client.callTool({ name: "create_epic", arguments: { title: "Perbaiki build" } });
    await client.callTool({ name: "list_epics", arguments: {} });
    expect(calls).toEqual([
      { name: "create_epic", body: { title: "Perbaiki build" } },
      { name: "list_epics", body: {} },
    ]);
  });

  it("create_tasks menyensor secret di instruksi tapi tidak menyentuh ref/epic_id", async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({
      name: "create_tasks",
      arguments: {
        epic_id: TASK,
        tasks: [
          {
            ref: "db",
            title: "Skema user",
            prompt_instruction: "Koneksi pakai DATABASE_PASSWORD=supersecretvalue123 lalu migrasi",
          },
          { ref: "api", title: "Endpoint", prompt_instruction: "Buat API", depends_on: ["db"] },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(calls[0]?.name).toBe("create_tasks");
    const sent = JSON.stringify(calls[0]?.body);
    expect(sent).not.toContain("supersecretvalue123");
    expect(calls[0]?.body).toMatchObject({
      epic_id: TASK,
      tasks: [{ ref: "db" }, { ref: "api", depends_on: ["db"] }],
    });
  });

  it("create_tasks menolak dependensi melingkar tanpa memanggil layanan lokal", async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({
      name: "create_tasks",
      arguments: {
        epic_id: TASK,
        tasks: [
          { ref: "a", title: "A", prompt_instruction: "x", depends_on: ["b"] },
          { ref: "b", title: "B", prompt_instruction: "y", depends_on: ["a"] },
        ],
      },
    });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("upsert_persona tidak meneruskan project_id dari agen", async () => {
    const { client, calls } = await setup();
    await client.callTool({
      name: "upsert_persona",
      arguments: {
        alias: "bambang",
        role: "backend",
        rules: ["Selalu tulis tes"],
        project_id: "00000000-0000-4000-8000-000000000000",
      },
    });
    expect(calls[0]?.name).toBe("upsert_persona");
    expect(calls[0]?.body).toEqual({
      alias: "bambang",
      role: "backend",
      rules: ["Selalu tulis tes"],
    });
  });

  it("save_repo_skill menulis file lokal dan menyensor secret tanpa memanggil layanan", async () => {
    const { client, calls, root: dir } = await setup();
    const res = await client.callTool({
      name: "save_repo_skill",
      arguments: {
        name: "db-migrations",
        when_to_use: "Saat mengubah skema database",
        content:
          "Jalankan `pnpm db:generate`. Jangan pakai API_KEY=sk_live_abcdefghijklmnop1234 di tes.",
      },
    });
    expect(res.isError).toBeFalsy();
    const first = (res as { content: { text: string }[] }).content[0]?.text ?? "{}";
    expect(JSON.parse(first)).toEqual({
      path: join(".catenext", "skills", "db-migrations.md"),
      created: true,
    });
    expect(textOf(res)).toMatch(/disensor|REDACTED|secret/i);
    const file = await readFile(join(dir, ".catenext/skills/db-migrations.md"), "utf8");
    expect(file).toContain("name: db-migrations");
    expect(file).not.toContain("sk_live_abcdefghijklmnop1234");
    expect(calls).toHaveLength(0);

    const loaded = await client.callTool({
      name: "load_skill",
      arguments: { name: "db-migrations" },
    });
    expect(loaded.isError).toBeFalsy();
    expect(JSON.parse(textOf(loaded))).toMatchObject({
      name: "db-migrations",
      when_to_use: "Saat mengubah skema database",
    });
  });

  it("save_repo_skill menolak code dump", async () => {
    const { client, calls } = await setup();
    const code = Array.from({ length: 30 }, (_, i) => `line${i}();`).join("\n");
    const res = await client.callTool({
      name: "save_repo_skill",
      arguments: { name: "dump", when_to_use: "x", content: `\`\`\`ts\n${code}\n\`\`\`` },
    });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("loads native project skills and supports explicit source_id disambiguation via MCP load_skill", async () => {
    const { client, root: dir } = await setup();
    await client.callTool({
      name: "save_repo_skill",
      arguments: {
        name: "deploy-flow",
        when_to_use: "Repo deploy flow",
        content: "Repo deploy steps.",
      },
    });
    const claudeDir = join(dir, ".claude", "skills", "deploy-flow");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "SKILL.md"),
      "---\ndescription: Claude native deploy flow\n---\nClaude deploy steps.\n",
    );

    const repoLoaded = await client.callTool({
      name: "load_skill",
      arguments: { name: "deploy-flow" },
    });
    expect(repoLoaded.isError).toBeFalsy();
    expect(JSON.parse(textOf(repoLoaded))).toMatchObject({
      name: "deploy-flow",
      source_id: "repo:.catenext/skills",
      content: "Repo deploy steps.",
      collision: true,
    });

    const claudeLoaded = await client.callTool({
      name: "load_skill",
      arguments: {
        name: "deploy-flow",
        source_id: "claude-code:project:.claude/skills",
      },
    });
    expect(claudeLoaded.isError).toBeFalsy();
    expect(JSON.parse(textOf(claudeLoaded))).toMatchObject({
      name: "deploy-flow",
      source_id: "claude-code:project:.claude/skills",
      source_kind: "project",
      content: "Claude deploy steps.",
      collision: true,
    });
  });

  it("load_skill memberi daftar skill bila nama tidak ada", async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: "load_skill", arguments: { name: "nope" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("tidak ada");
  });

  it("meneruskan keputusan review lokal dan menyensor feedback", async () => {
    const { client, calls } = await setup();
    const result = await client.callTool({
      name: "review_pull_request",
      arguments: {
        request: {
          action: "submit",
          task_id: TASK,
          lease_id: TASK,
          head_sha: HANDOFF_SHA,
          decision: "approve",
          feedback: "API_KEY=sk_live_abcdefghijklmnop",
        },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({
      name: "review_pull_request",
      body: { request: { action: "submit", task_id: TASK, decision: "approve" } },
    });
    expect(JSON.stringify(calls[0])).not.toContain("sk_live_abcdefghijklmnop");
    expect(textOf(result)).toMatch(/secret scrubber menyensor/i);
  });

  it("mempertahankan field path dan query dari SCRUB_TOOL_FIELDS tanpa menyensornya", async () => {
    const { client, calls } = await setup();
    const secretLikePath = "/tmp/token_sk_live_abcdefghijklmnop/repo";
    const secretLikeQuery = "auth_token=supersecretvalue123";
    await client.callTool({
      name: "manage_roots",
      arguments: { action: "add", path: secretLikePath, label: "token=supersecretvalue123" },
    });
    await client.callTool({
      name: "graph_neighbors",
      arguments: { path: secretLikePath },
    });
    await client.callTool({
      name: "symbol_search",
      arguments: { query: secretLikeQuery },
    });
    expect(calls[0]?.body).toMatchObject({
      action: "add",
      path: secretLikePath,
      label: "token=[REDACTED:assignment]",
    });
    expect(calls[1]?.body).toMatchObject({ path: secretLikePath });
    expect(calls[2]?.body).toMatchObject({ query: secretLikeQuery });
  });

  it("tools/list mengembalikan schema ringkas tanpa regex UUID panjang namun validasi runtime tetap ketat", async () => {
    const { client, calls } = await setup();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(LOCAL_TOOLS.length);
    for (const t of tools) {
      expect(t.description ?? "").not.toContain("\n");
      expect((t.description ?? "").trim().split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(JSON.stringify(t.inputSchema)).not.toContain("[0-9a-fA-F]{8}");
    }
    const invalid = await client.callTool({
      name: "claim_task",
      arguments: { task_id: "not-a-uuid" },
    });
    expect(invalid.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("tools/list menyertakan MCP annotations pada setiap tool", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(LOCAL_TOOLS.length);
    for (const t of tools) {
      expect(t.annotations).toBeDefined();
      expect(typeof t.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint).toBe("boolean");
      expect(typeof t.annotations?.idempotentHint).toBe("boolean");
      expect(typeof t.annotations?.openWorldHint).toBe("boolean");
    }

    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("get_ready_tasks")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get("claim_task")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName.get("archive_document")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("memfilter tool tools/list saat role orchestrator atau worker diset", async () => {
    const orch = await setup(undefined, undefined, "orchestrator");
    const orchList = await orch.client.listTools();
    expect(orchList.tools.map((t) => t.name).sort()).toEqual([...ROLE_TOOLS.orchestrator].sort());
    await close?.();
    close = undefined;

    const worker = await setup(undefined, undefined, "worker");
    const workerList = await worker.client.listTools();
    expect(workerList.tools.map((t) => t.name).sort()).toEqual([...ROLE_TOOLS.worker].sort());
  });

  it("menangani onframeerror, onparseerror, dan kegagalan transport.send tanpa unhandled rejection", async () => {
    const logs: string[] = [];
    const sent: unknown[] = [];
    let failSend = false;
    const server = createCatenextMcpServer({
      version: "test",
      context: async () => ({ ok: false, error: "not init" }),
      log: (m) => logs.push(m),
    });
    const fakeTransport: McpTransport = {
      async start() {},
      async close() {},
      async send(msg) {
        if (failSend) throw new Error("EPIPE");
        sent.push(msg);
      },
    };
    await server.connect(fakeTransport);

    fakeTransport.onparseerror?.();
    fakeTransport.onframeerror?.(new Error("Frame too large"));
    await Promise.resolve();
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Frame too large" } },
    ]);

    failSend = true;
    fakeTransport.onmessage?.({ jsonrpc: "2.0", id: 9, method: "ping" });
    await new Promise((r) => setTimeout(r, 10));
    expect(logs.some((l) => l.includes("EPIPE"))).toBe(true);
    await server.close();
  });

  it("melewati scrubbing scope_files/doc_refs/paths tetapi menyensor secret pada verify_command", async () => {
    const { client, calls } = await setup();
    const pathLike = "src/token_sk_live_abcdefghijklmnop.ts";
    const res = await client.callTool({
      name: "create_tasks",
      arguments: {
        epic_id: TASK,
        tasks: [
          {
            ref: "t1",
            title: "Scoped task",
            prompt_instruction: "Implement feature",
            scope_files: [pathLike],
            doc_refs: ["doc_sk_live_abcdefghijklmnop"],
            verify_command: "API_KEY=sk_live_abcdefghijklmnop pnpm test",
          },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/secret scrubber menyensor/i);
    expect(calls[0]?.body).toMatchObject({
      tasks: [
        {
          ref: "t1",
          scope_files: [pathLike],
          doc_refs: ["doc_sk_live_abcdefghijklmnop"],
          verify_command: "API_KEY=[REDACTED:stripe_key] pnpm test",
        },
      ],
    });

    await client.callTool({
      name: "graph_neighbors",
      arguments: { paths: [pathLike, "src/b.ts"], include_symbols: true },
    });
    expect(calls[1]?.body).toMatchObject({
      paths: [pathLike, "src/b.ts"],
      include_symbols: true,
    });
  });

  it("menjalankan tools/call v0.16 via LocalService (claim_task include_context, batched graph_neighbors, graph_summary prefix, session_brief hints)", async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-mcp-e2e-"));
    const repoRoot = root;
    const projectId = randomUUID();
    const config = CatenextConfigSchema.parse({
      schema_version: 1,
      project_id: projectId,
      project_name: "McpE2E",
      repo_name: "be",
    });
    const human = new LocalService(repoRoot, config, "human");
    const agent = new LocalService(repoRoot, config, "agent");

    await mkdir(join(repoRoot, "src/mod"), { recursive: true });
    await mkdir(join(repoRoot, "src/other"), { recursive: true });
    const modA = join(repoRoot, "src/mod/a.ts");
    const modB = join(repoRoot, "src/mod/b.ts");
    const otherC = join(repoRoot, "src/other/c.ts");
    await writeFile(
      modA,
      `import { bFn } from "./b.js";\nexport function aFn() { return bFn(); }\n`,
    );
    await writeFile(modB, `export function bFn() { return 1; }\n`);
    await writeFile(otherC, `export function cFn() { return 2; }\n`);

    await human.callTool("upsert_persona", { alias: "be", role: "backend", repos: ["be"] });
    await human.callTool("save_document", {
      slug: "sync-board",
      title: "Sync Board",
      kind: "other",
      content: "## DECISIONS\n- Compact MCP responses\n## OTHER\n- Ignored",
    });
    const { epic } = await human.callTool("create_epic", {
      title: "MCP v0.16",
      description: "E2E verification",
    });
    const { created } = await human.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [
        {
          ref: "t1",
          title: "Wire MCP tools",
          prompt_instruction: "Check MCP tools.",
          persona: "be",
          scope_files: ["src/mod/a.ts"],
          verify_command: "pnpm test",
          doc_refs: ["sync-board"],
        },
      ],
    });
    const [first] = created;
    if (!first) throw new Error("Expected created task");
    const taskId = first.task_id;
    await human.callTool("manage_task", { action: "approve_plan", task_id: taskId });
    await indexProjectGraph(human.stateFile, projectId, repoRoot);

    const server = createCatenextMcpServer({
      version: "test",
      context: async () => ({ ok: true, service: agent, root: repoRoot }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "claude-code", version: "1.0.0" });
    const transport: McpTransport = {
      async start() {
        a.onmessage = transport.onmessage;
        a.onclose = transport.onclose;
        await a.start();
      },
      close: () => a.close(),
      send: (msg) => a.send("error" in msg ? { ...msg, id: msg.id ?? undefined } : msg),
    };
    await Promise.all([server.connect(transport), client.connect(b)]);
    close = async () => {
      await client.close();
      await server.close();
    };

    const briefClean = await client.callTool({ name: "session_brief", arguments: {} });
    expect(briefClean.isError).toBeFalsy();
    expect(JSON.parse(textOf(briefClean)).hints).toBeUndefined();

    const neighborsRes = await client.callTool({
      name: "graph_neighbors",
      arguments: { paths: ["src/mod/a.ts", "src/mod/b.ts"], include_symbols: true },
    });
    expect(neighborsRes.isError).toBeFalsy();
    const edge = {
      kind: "imports",
      from: "src/mod/a.ts",
      to: "src/mod/b.ts",
      label: "src/mod/b.ts",
    };
    expect(JSON.parse(textOf(neighborsRes))).toEqual({
      edges: [edge],
      files: [
        { path: "src/mod/a.ts", edges: [edge], symbols: ["aFn"] },
        { path: "src/mod/b.ts", edges: [edge], symbols: ["bFn"] },
      ],
    });

    const legacyNeighborsRes = await client.callTool({
      name: "graph_neighbors",
      arguments: { path: "src/mod/a.ts" },
    });
    expect(legacyNeighborsRes.isError).toBeFalsy();
    expect(JSON.parse(textOf(legacyNeighborsRes))).toEqual({
      path: "src/mod/a.ts",
      edges: [edge],
      files: [{ path: "src/mod/a.ts", edges: [edge] }],
    });

    const summaryRes = await client.callTool({
      name: "graph_summary",
      arguments: { prefix: "src/mod", depth: 5 },
    });
    expect(summaryRes.isError).toBeFalsy();
    expect(JSON.parse(textOf(summaryRes)).totals).toEqual({ files: 2, symbols: 2, edges: 1 });

    const claimRes = await client.callTool({
      name: "claim_task",
      arguments: { task_id: taskId, agent_alias: "be", include_context: true },
    });
    expect(claimRes.isError).toBeFalsy();
    expect(JSON.parse(textOf(claimRes))).toMatchObject({
      task: {
        id: taskId,
        scope_files: ["src/mod/a.ts"],
        verify_command: "pnpm test",
        doc_refs: ["sync-board"],
      },
      context_pack: {
        epic_summary: "MCP v0.16: E2E verification",
        sync_board_excerpt: "## DECISIONS\n- Compact MCP responses",
        graph_slice: [
          {
            path: "src/mod/a.ts",
            edges: [edge],
            symbols: ["aFn"],
            symbol_locations: [{ name: "aFn", line: 2 }],
          },
        ],
      },
    });

    await writeFile(modA, `export function aFn() { return 99; }\n`);
    const shifted = new Date(Date.now() + 5_000);
    await utimes(modA, shifted, shifted);

    const briefStale = await client.callTool({ name: "session_brief", arguments: {} });
    expect(briefStale.isError).toBeFalsy();
    expect(JSON.parse(textOf(briefStale)).hints).toEqual([
      expect.stringContaining("Code graph index is stale (modified_files)"),
    ]);
  });

  it("exposes resources/list and resources/read for project documents and handoffs", async () => {
    const handoffPayload = {
      task_id: TASK,
      title: "Implement auth",
      handoff_summary: HANDOFF,
    };
    const { client } = await setup((call) => {
      if (call.name === "get_project_context") {
        return {
          documents: [{ slug: "sync-board", title: "Sync Board", kind: "decision", version: 3 }],
          recent_handoffs: [handoffPayload],
        };
      }
      if (call.name === "get_document") {
        const { slug } = call.body as { slug: string };
        if (slug === "sync-board") {
          return {
            slug: "sync-board",
            title: "Sync Board",
            kind: "decision",
            version: 3,
            content: "# Sync Board\n\n- Use resource_link",
          };
        }
        throw new Error(`Dokumen "${slug}" tidak ditemukan`);
      }
      return { ok: 1 };
    });

    expect(client.getServerCapabilities()).toMatchObject({
      tools: {},
      resources: { subscribe: true },
      prompts: {},
      logging: {},
    });

    const listed = await client.listResources();
    expect(listed.resources).toEqual([
      {
        uri: "catenext://documents/sync-board",
        name: "sync-board",
        title: "Sync Board",
        description: "decision document (v3)",
        mimeType: "text/markdown",
      },
      {
        uri: `catenext://handoffs/${TASK}`,
        name: `handoff-${TASK}`,
        title: "Handoff: Implement auth",
        description: "Task handoff for Implement auth",
        mimeType: "application/json",
      },
    ]);

    const readDoc = await client.readResource({ uri: "catenext://documents/sync-board" });
    expect(readDoc.contents).toEqual([
      {
        uri: "catenext://documents/sync-board",
        mimeType: "text/markdown",
        text: "# Sync Board\n\n- Use resource_link",
      },
    ]);

    const readHandoff = await client.readResource({ uri: `catenext://handoffs/${TASK}` });
    expect(readHandoff.contents).toEqual([
      {
        uri: `catenext://handoffs/${TASK}`,
        mimeType: "application/json",
        text: JSON.stringify(handoffPayload),
      },
    ]);

    await expect(
      client.readResource({ uri: "catenext://documents/missing" }),
    ).rejects.toMatchObject({
      code: -32002,
    });
    await expect(client.readResource({ uri: "catenext://unknown/foo" })).rejects.toMatchObject({
      code: -32002,
    });
  });

  it("emits resource_link items and compacts large handoffs when client supports >= 2025-06-18", async () => {
    const largeNotes = "x".repeat(4500);
    const largeHandoff = {
      task_id: TASK,
      title: "Large handoff",
      handoff_summary: { ...HANDOFF, notes_for_next_agent: largeNotes },
    };
    const { client } = await setup((call) => {
      if (call.name === "get_project_context") {
        return {
          documents: [{ slug: "blueprint", title: "Blueprint", kind: "architecture", version: 1 }],
          recent_handoffs: [largeHandoff],
        };
      }
      if (call.name === "claim_task") {
        return {
          task: { id: TASK },
          dependency_handoffs: [largeHandoff],
        };
      }
      if (call.name === "get_document") {
        return {
          slug: "blueprint",
          title: "Blueprint",
          kind: "architecture",
          version: 1,
          content: "",
          truncated: true,
        };
      }
      return { ok: 1 };
    });

    const ctxRes = await client.callTool({ name: "get_project_context", arguments: {} });
    const ctxContent = ctxRes.content as Array<{ type: string; text?: string; uri?: string }>;
    expect(JSON.parse(ctxContent[0]?.text ?? "{}").recent_handoffs).toEqual([
      {
        task_id: TASK,
        title: "Large handoff",
        resource_uri: `catenext://handoffs/${TASK}`,
      },
    ]);
    expect(ctxContent.slice(1)).toEqual([
      expect.objectContaining({ type: "resource_link", uri: "catenext://documents/blueprint" }),
      expect.objectContaining({ type: "resource_link", uri: `catenext://handoffs/${TASK}` }),
    ]);

    const claimRes = await client.callTool({
      name: "claim_task",
      arguments: { task_id: TASK, agent_alias: "be" },
    });
    const claimContent = claimRes.content as Array<{ type: string; text?: string; uri?: string }>;
    expect(JSON.parse(claimContent[0]?.text ?? "{}").dependency_handoffs).toEqual([
      {
        task_id: TASK,
        title: "Large handoff",
        resource_uri: `catenext://handoffs/${TASK}`,
      },
    ]);
    expect(claimContent.slice(1)).toEqual([
      expect.objectContaining({ type: "resource_link", uri: `catenext://handoffs/${TASK}` }),
    ]);

    const docRes = await client.callTool({
      name: "get_document",
      arguments: { slug: "blueprint", outline_only: true },
    });
    const docContent = docRes.content as Array<{ type: string; uri?: string }>;
    expect(docContent[1]).toMatchObject({
      type: "resource_link",
      uri: "catenext://documents/blueprint",
    });
  });

  it("omits resource_link items for older protocol clients (< 2025-06-18)", async () => {
    const sent: unknown[] = [];
    const server = createCatenextMcpServer({
      version: "test",
      context: async () => ({
        ok: true,
        root: "/tmp",
        service: {
          async callTool() {
            return {
              documents: [
                { slug: "blueprint", title: "Blueprint", kind: "architecture", version: 1 },
              ],
              recent_handoffs: [
                {
                  task_id: TASK,
                  title: "Large handoff",
                  handoff_summary: { ...HANDOFF, notes_for_next_agent: "y".repeat(4500) },
                },
              ],
            };
          },
        } as Extract<ServerContext, { ok: true }>["service"],
      }),
    });
    const transport: McpTransport = {
      async start() {},
      async close() {},
      async send(msg) {
        sent.push(msg);
      },
    };
    await server.connect(transport);
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    await new Promise((r) => setTimeout(r, 10));
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_project_context", arguments: {} },
    });
    await new Promise((r) => setTimeout(r, 10));
    await server.close();

    const callReply = sent[1] as {
      result: { content: Array<{ type: string; text?: string }> };
    };
    expect(callReply.result.content).toHaveLength(1);
    expect(callReply.result.content[0]?.type).toBe("text");
    expect(
      JSON.parse(callReply.result.content[0]?.text ?? "{}").recent_handoffs[0].handoff_summary,
    ).toBeDefined();
  });

  it("lists resource templates for documents and handoffs", async () => {
    const { client } = await setup(() => ({ ok: 1 }));
    const result = await client.listResourceTemplates();
    expect(result.resourceTemplates).toEqual([
      {
        uriTemplate: "catenext://documents/{slug}",
        name: "project-document",
        title: "Project Document",
        description: "Read a Catenext project document by slug (e.g. blueprint, sync-board).",
        mimeType: "text/markdown",
      },
      {
        uriTemplate: "catenext://handoffs/{task_id}",
        name: "task-handoff",
        title: "Task Handoff",
        description: "Read a Catenext task handoff summary by task UUID.",
        mimeType: "application/json",
      },
    ]);
  });

  it("lists and renders parameterized workflow prompts and rejects invalid requests", async () => {
    const { client } = await setup(() => ({ ok: 1 }));
    const listed = await client.listPrompts();
    expect(listed.prompts.map((p) => p.name)).toEqual([
      "kickoff-brainstorm",
      "rc-review",
      "docs-hygiene",
    ]);

    const epicId = "11111111-1111-4111-8111-111111111111";
    const kickoff = await client.getPrompt({
      name: "kickoff-brainstorm",
      arguments: { goal: "Ship MCP v2", personas: "be,reviewer", epic_id: epicId },
    });
    expect(kickoff.messages).toHaveLength(1);
    expect(kickoff.messages[0]?.role).toBe("user");
    expect(kickoff.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("Ship MCP v2"),
    });
    expect(kickoff.messages[0]?.content).toMatchObject({
      text: expect.stringContaining("be,reviewer"),
    });
    expect(kickoff.messages[0]?.content).toMatchObject({
      text: expect.stringContaining(epicId),
    });

    const review = await client.getPrompt({
      name: "rc-review",
      arguments: { task_id: TASK, focus: "security" },
    });
    expect(review.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining(`catenext://handoffs/${TASK}`),
    });
    expect(review.messages[0]?.content).toMatchObject({
      text: expect.stringContaining("Focus: security"),
    });

    const hygiene = await client.getPrompt({ name: "docs-hygiene" });
    expect(hygiene.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("blueprint, orchestrator, permissions, sync-board"),
    });

    const kickoffOmitted = await client.getPrompt({ name: "kickoff-brainstorm" });
    expect(kickoffOmitted.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("No `goal` argument was provided"),
    });
    expect(kickoffOmitted.messages[0]?.content).toMatchObject({
      text: expect.stringContaining("Ask the user what feature or epic goal"),
    });

    const kickoffEmpty = await client.getPrompt({
      name: "kickoff-brainstorm",
      arguments: { personas: "be,fe" },
    });
    expect(kickoffEmpty.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("Personas: be,fe"),
    });

    const reviewOmitted = await client.getPrompt({ name: "rc-review" });
    expect(reviewOmitted.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("No `task_id` argument was provided"),
    });
    expect(reviewOmitted.messages[0]?.content).toMatchObject({
      text: expect.stringContaining("catenext://handoffs/{task_id}"),
    });

    const reviewBlank = await client.getPrompt({
      name: "rc-review",
      arguments: { task_id: "   ", focus: "contracts" },
    });
    expect(reviewBlank.messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("Focus: contracts"),
    });
    expect(reviewBlank.messages[0]?.content).toMatchObject({
      text: expect.stringContaining("Ask the user which task UUID"),
    });

    await expect(client.getPrompt({ name: "unknown-prompt" })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      client.getPrompt({
        name: "kickoff-brainstorm",
        arguments: { goal: 123 as unknown as string },
      }),
    ).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      client.getPrompt({
        name: "rc-review",
        arguments: { task_id: null as unknown as string },
      }),
    ).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("returns structuredContent and outputSchema for MCP >= 2025-06-18 clients", async () => {
    const { client } = await setup((call) => {
      if (call.name === "session_brief") {
        return { ready: 2, blocked: 0, draft: 1, next: ["claim_task"] };
      }
      return { ok: 1 };
    });

    const { tools } = await client.listTools();
    const briefTool = tools.find((t) => t.name === "session_brief");
    expect(briefTool?.outputSchema).toEqual({ type: "object" });

    const okRes = await client.callTool({ name: "session_brief", arguments: {} });
    expect(okRes.structuredContent).toEqual({
      ready: 2,
      blocked: 0,
      draft: 1,
      next: ["claim_task"],
    });
    expect(okRes.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ ready: 2, blocked: 0, draft: 1, next: ["claim_task"] }),
      },
    ]);

    const errRes = await client.callTool({
      name: "claim_task",
      arguments: { task_id: "not-a-uuid" },
    });
    expect(errRes.isError).toBe(true);
    expect(errRes.structuredContent).toBeUndefined();
  });

  it("omits structuredContent and outputSchema for older protocol clients (< 2025-06-18)", async () => {
    const sent: unknown[] = [];
    const server = createCatenextMcpServer({
      version: "test",
      context: async () => ({
        ok: true,
        root: "/tmp",
        service: {
          async callTool() {
            return { ready: 1, blocked: 0, draft: 0 };
          },
        } as Extract<ServerContext, { ok: true }>["service"],
      }),
    });
    const transport: McpTransport = {
      async start() {},
      async close() {},
      async send(msg) {
        sent.push(msg);
      },
    };
    await server.connect(transport);
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    await new Promise((r) => setTimeout(r, 10));
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    await new Promise((r) => setTimeout(r, 10));
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "session_brief", arguments: {} },
    });
    await new Promise((r) => setTimeout(r, 10));
    await server.close();

    const listReply = sent[1] as {
      result: { tools: Array<{ name: string; outputSchema?: unknown }> };
    };
    expect(listReply.result.tools.length).toBeGreaterThan(0);
    for (const tool of listReply.result.tools) {
      expect(tool.outputSchema).toBeUndefined();
    }

    const callReply = sent[2] as {
      result: {
        content: Array<{ type: string; text?: string }>;
        structuredContent?: unknown;
      };
    };
    expect(callReply.result.structuredContent).toBeUndefined();
    expect(callReply.result.content).toEqual([
      { type: "text", text: JSON.stringify({ ready: 1, blocked: 0, draft: 0 }) },
    ]);
  });

  it("supports resources/subscribe, resources/unsubscribe, and emits notifications/resources/updated on mutations", async () => {
    const updatedUris: string[] = [];
    const { client } = await setup((call) => {
      if (call.name === "save_document") {
        const { slug } = call.body as { slug: string };
        if (slug === "fail-doc") throw new Error("Simulated failure");
        return { slug, version: 2 };
      }
      if (call.name === "archive_document" || call.name === "restore_document") {
        return { ok: true };
      }
      if (call.name === "complete_handoff") {
        return { task_id: TASK, status: "NEEDS_REVIEW", unlocked_task_ids: [] };
      }
      return { ok: 1 };
    });

    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updatedUris.push(notification.params.uri);
    });

    const docUri = "catenext://documents/sync-board";
    const handoffUri = `catenext://handoffs/${TASK}`;

    await client.subscribeResource({ uri: docUri });
    await client.subscribeResource({ uri: handoffUri });

    await expect(client.subscribeResource({ uri: "catenext://unknown/foo" })).rejects.toMatchObject(
      {
        code: -32002,
      },
    );
    await expect(client.subscribeResource({ uri: "" })).rejects.toMatchObject({
      code: -32602,
    });

    await client.callTool({
      name: "save_document",
      arguments: {
        slug: "sync-board",
        title: "Sync Board",
        kind: "decision",
        content: "# Updated",
        expected_version: 1,
      },
    });
    await client.callTool({
      name: "archive_document",
      arguments: { slug: "sync-board" },
    });
    await client.callTool({
      name: "restore_document",
      arguments: { slug: "sync-board" },
    });
    await client.callTool({
      name: "save_document",
      arguments: {
        slug: "other-doc",
        title: "Other",
        kind: "decision",
        content: "# Other",
        expected_version: 0,
      },
    });
    await client.callTool({
      name: "complete_handoff",
      arguments: { lease_id: TASK, task_id: TASK, handoff_summary: HANDOFF },
    });

    await new Promise((r) => setTimeout(r, 15));
    expect(updatedUris).toEqual([docUri, docUri, docUri, handoffUri]);

    // Unsubscribe and verify no further notifications for docUri
    await client.unsubscribeResource({ uri: docUri });
    await client.callTool({
      name: "save_document",
      arguments: {
        slug: "sync-board",
        title: "Sync Board",
        kind: "decision",
        content: "# Updated again",
        expected_version: 2,
      },
    });
    // Failed mutation should not notify even if subscribed
    await client.subscribeResource({ uri: "catenext://documents/fail-doc" });
    const failed = await client.callTool({
      name: "save_document",
      arguments: {
        slug: "fail-doc",
        title: "Fail",
        kind: "decision",
        content: "# Fail",
        expected_version: 0,
      },
    });
    expect(failed.isError).toBe(true);

    await new Promise((r) => setTimeout(r, 15));
    expect(updatedUris).toEqual([docUri, docUri, docUri, handoffUri]);
  });

  it("supports logging/setLevel and emits structured notifications/message filtered by severity", async () => {
    const messages: Array<{ level: string; logger?: string; data: unknown }> = [];
    const { client } = await setup();

    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      messages.push({
        level: notification.params.level,
        logger: notification.params.logger,
        data: notification.params.data,
      });
    });

    await expect(
      client.setLoggingLevel("verbose" as Parameters<typeof client.setLoggingLevel>[0]),
    ).rejects.toMatchObject({ code: -32602 });

    await client.setLoggingLevel("warning");
    await client.callTool({ name: "session_brief", arguments: {} });
    await client.callTool({ name: "claim_task", arguments: { task_id: "not-a-uuid" } });

    await new Promise((r) => setTimeout(r, 15));
    expect(messages).toEqual([
      {
        level: "warning",
        logger: "catenext.mcp",
        data: { event: "tools/call", tool: "claim_task", ok: false },
      },
    ]);

    messages.length = 0;
    await client.setLoggingLevel("debug");
    await client.subscribeResource({ uri: "catenext://documents/sync-board" });
    await client.callTool({ name: "session_brief", arguments: {} });

    await new Promise((r) => setTimeout(r, 15));
    expect(messages).toEqual([
      {
        level: "info",
        logger: "catenext.mcp",
        data: { event: "logging/setLevel", level: "debug" },
      },
      {
        level: "debug",
        logger: "catenext.mcp",
        data: { event: "resources/subscribe", uri: "catenext://documents/sync-board" },
      },
      {
        level: "info",
        logger: "catenext.mcp",
        data: { event: "tools/call", tool: "session_brief", ok: true },
      },
    ]);
  });

  it("references --role reviewer and worktree_status in SERVER_INSTRUCTIONS and workflow prompts", async () => {
    expect(SERVER_INSTRUCTIONS).toContain("--role reviewer");
    expect(SERVER_INSTRUCTIONS).toContain("worktree_status");

    const { client } = await setup();
    const { prompts } = await client.listPrompts();
    const rcPrompt = prompts.find((p) => p.name === "rc-review");
    expect(rcPrompt?.description).toContain("--role reviewer");

    const rcRendered = await client.getPrompt({
      name: "rc-review",
      arguments: { task_id: TASK },
    });
    const rcText = (rcRendered.messages[0]?.content as { text?: string } | undefined)?.text;
    expect(rcText).toContain("worktree_status");

    const kickoffRendered = await client.getPrompt({
      name: "kickoff-brainstorm",
      arguments: { goal: "Ship MCP v0.19" },
    });
    const kickoffText = (kickoffRendered.messages[0]?.content as { text?: string } | undefined)
      ?.text;
    expect(kickoffText).toContain("worktree_status");
  });

  it("rejects epic_run start over JSON-RPC without forwarding to the service", async () => {
    const { client, calls } = await setup(undefined, undefined, "orchestrator");
    const result = await client.callTool({
      name: "epic_run",
      arguments: {
        epic_id: TASK,
        action: "start",
        base: "main",
        check: "pnpm test",
        snapshot: "a".repeat(64),
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`catenext epic run start ${TASK}`);
    expect(calls).toEqual([]);
  });

  it("executes worktree_status, bounded epic_run, and compact/filtered get_project_board via LocalService", async () => {
    const execGit = promisify(execFile);
    const repoDir = await mkdtemp(join(tmpdir(), "catenext-mcp-tools-"));
    try {
      await execGit("git", ["init", "-b", "main"], { cwd: repoDir });
      await execGit("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      await execGit("git", ["config", "user.name", "Test"], { cwd: repoDir });
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, ".gitignore"), ".catenext/\n");
      await writeFile(join(repoDir, "src/index.ts"), "export const v = 1;\n");
      await execGit("git", ["add", "."], { cwd: repoDir });
      await execGit("git", ["commit", "-m", "init"], { cwd: repoDir });
      await writeFile(join(repoDir, "src/dirty.ts"), "export const dirty = true;\n");

      const config = CatenextConfigSchema.parse({
        schema_version: 1,
        project_id: randomUUID(),
        repo_name: "api",
        state_file: ".catenext/catenext.sqlite",
      });
      const human = new LocalService(repoDir, config, "human");
      await human.ensureSeed();
      const agent = new LocalService(repoDir, config, "agent");

      const { epic } = (await human.callTool("create_epic", {
        title: "Bounded MCP Epic",
      })) as { epic: { id: string } };
      const longTitle = `Implement bounded epic run and compact board support with extra descriptive context ${"x".repeat(40)}`;
      const { created } = await human.callTool("create_tasks", {
        epic_id: epic.id,
        tasks: [
          {
            ref: "t1",
            title: longTitle,
            prompt_instruction: "Edit src/a.ts only",
            target_repo: "api",
            persona: "be",
            scope_files: ["src/a.ts"],
            verify_command: "pnpm test",
          },
          {
            ref: "t2",
            title: "Second bounded task",
            prompt_instruction: "Edit src/b.ts after t1",
            depends_on: ["t1"],
            target_repo: "api",
            persona: "be",
            scope_files: ["src/b.ts"],
            verify_command: "pnpm test",
          },
        ],
      });

      const server = createCatenextMcpServer({
        version: "test",
        role: "orchestrator",
        context: async () => ({ ok: true, service: agent, root: repoDir }),
        log: () => {},
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "claude-code", version: "1.0.0" });
      const transport: McpTransport = {
        async start() {
          a.onmessage = transport.onmessage;
          a.onclose = transport.onclose;
          await a.start();
        },
        close: () => a.close(),
        send: (msg) => a.send("error" in msg ? { ...msg, id: msg.id ?? undefined } : msg),
      };
      await Promise.all([server.connect(transport), client.connect(b)]);

      try {
        // 1. worktree_status
        const wtRes = await client.callTool({ name: "worktree_status", arguments: {} });
        expect(wtRes.isError).toBeUndefined();
        const wtData = JSON.parse(textOf(wtRes)) as {
          worktrees: Array<{
            branch: string | null;
            dirty_count: number;
            modified_files: string[];
          }>;
          overlaps: unknown[];
        };
        expect(wtData.worktrees).toHaveLength(1);
        expect(wtData.worktrees[0]).toMatchObject({
          branch: "main",
          dirty_count: 1,
          modified_files: ["src/dirty.ts"],
        });
        expect(wtData.overlaps).toEqual([]);

        // 2. get_project_board: default vs compact + filtering
        const fullRes = await client.callTool({
          name: "get_project_board",
          arguments: { epic_id: epic.id },
        });
        const compactRes = await client.callTool({
          name: "get_project_board",
          arguments: { epic_id: epic.id, compact: true, status: ["DRAFT"], limit: 1 },
        });
        const fullBoard = JSON.parse(textOf(fullRes)) as {
          repos: unknown[];
          personas: unknown[];
          tasks: Array<{ title: string }>;
          truncated: boolean;
        };
        const compactBoard = JSON.parse(textOf(compactRes)) as {
          repos: unknown[];
          personas: unknown[];
          tasks: Array<{ title: string }>;
          truncated: boolean;
        };
        expect(fullBoard.personas.length).toBeGreaterThan(0);
        expect(fullBoard.repos.length).toBeGreaterThan(0);
        expect(fullBoard.tasks).toHaveLength(2);
        expect(fullBoard.truncated).toBe(false);
        expect(compactBoard.personas).toEqual([]);
        expect(compactBoard.repos).toEqual([]);
        expect(compactBoard.tasks).toHaveLength(1);
        expect(compactBoard.tasks[0]?.title.length).toBeLessThanOrEqual(60);
        expect(compactBoard.truncated).toBe(true);
        expect(textOf(compactRes).length).toBeLessThan(textOf(fullRes).length);

        // 3. epic_run: preview via MCP, start blocked for agent, start via human CLI boundary, then resume/pause/close via MCP
        const previewRes = await client.callTool({
          name: "epic_run",
          arguments: { epic_id: epic.id, action: "preview", base: "main", check: "pnpm test" },
        });
        expect(previewRes.isError).toBeUndefined();
        const preview = JSON.parse(textOf(previewRes)) as {
          snapshot: string;
          integration_branch: string;
          max_worktrees: number;
          max_revisions_per_task: number;
        };
        expect(preview.snapshot).toMatch(/^[a-f0-9]{64}$/);
        expect(preview.max_worktrees).toBe(2);
        expect(preview.max_revisions_per_task).toBe(2);

        await expect(
          agent.callTool("epic_run", {
            epic_id: epic.id,
            action: "start",
            base: "main",
            check: "pnpm test",
            snapshot: preview.snapshot,
          }),
        ).rejects.toMatchObject({ code: "human_approval_required" });

        await human.epicRun(epic.id, {
          action: "start",
          base: "main",
          check: "pnpm test",
          snapshot: preview.snapshot,
        });

        const resumeRes = await client.callTool({
          name: "epic_run",
          arguments: { epic_id: epic.id, action: "resume" },
        });
        const resumed = JSON.parse(textOf(resumeRes)) as {
          status: string;
          host_mode: string;
          unattended_supported: boolean;
          eligible: string[];
        };
        expect(resumed).toMatchObject({
          status: "RUNNING",
          host_mode: "stepped",
          unattended_supported: false,
          eligible: [created[0]?.task_id],
        });

        const pauseRes = await client.callTool({
          name: "epic_run",
          arguments: { epic_id: epic.id, action: "pause", reason: "Waiting for human check" },
        });
        expect(JSON.parse(textOf(pauseRes))).toMatchObject({
          status: "PAUSED",
          reason: "Waiting for human check",
          eligible: [],
        });

        const closeRes = await client.callTool({
          name: "epic_run",
          arguments: { epic_id: epic.id, action: "close" },
        });
        expect(JSON.parse(textOf(closeRes))).toMatchObject({
          status: "CLOSED",
          eligible: [],
        });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("scrubs unlisted MCP tool inputs, MCP tool outputs, readResource, and quoted multi-word secrets", async () => {
    const fakeKey = ["sk-proj", "testfixture0123456789abcdef"].join("-");
    const fakeGh = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");

    // 1. Quoted multi-word secrets in scrubText
    expect(scrubText('PASSWORD="my secret pass 123"')).toBe('PASSWORD="[REDACTED:assignment]"');
    expect(scrubText("API_SECRET='correct horse battery staple'")).toBe(
      "API_SECRET='[REDACTED:assignment]'",
    );
    expect(scrubText('{"password": "my super secret 123", "note": "ok"}')).toBe(
      '{"password": "[REDACTED:assignment]", "note": "ok"}',
    );
    expect(scrubText('PASSWORD="short"')).toBe('PASSWORD="short"');

    // 2. Unlisted MCP tool input scrubbing (epic_run) + output scrubbing (get_document, search_context, claim_task)
    const {
      client,
      calls,
      logs,
      root: repoRoot,
    } = await setup((call) => {
      if (call.name === "get_document") {
        return {
          slug: "secret-doc",
          title: "Secret Doc",
          kind: "other",
          version: 1,
          content: `Use token ${fakeGh} and PASSWORD="my secret pass 123"`,
        };
      }
      if (call.name === "search_context") {
        return {
          results: [{ snippet: `api_key=${fakeKey}` }],
        };
      }
      if (call.name === "claim_task") {
        return {
          task: {
            id: TASK,
            title: "Task with secret",
            prompt_instruction: `Run with ${fakeKey}`,
          },
          lease_id: "22222222-3333-4444-8555-666666666666",
          dependency_handoffs: [
            {
              task_id: TASK,
              title: "Dep",
              handoff_summary: { ...HANDOFF, notes_for_next_agent: `Token: ${fakeGh}` },
            },
          ],
        };
      }
      return { ok: 1 };
    });

    const epicRes = await client.callTool({
      name: "epic_run",
      arguments: {
        epic_id: TASK,
        action: "pause",
        reason: `Paused due to ${fakeKey}`,
      },
    });
    expect(epicRes.isError).toBeFalsy();
    expect(calls[0]).toEqual({
      name: "epic_run",
      body: {
        epic_id: TASK,
        action: "pause",
        reason: "Paused due to [REDACTED:llm_api_key]",
      },
    });
    expect(logs.some((l) => l.includes("llm_api_key"))).toBe(true);

    const docRes = await client.callTool({
      name: "get_document",
      arguments: { slug: "secret-doc" },
    });
    const docText = (docRes.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(docText).not.toContain(fakeGh);
    expect(docText).not.toContain("my secret pass 123");
    expect(docText).toContain("[REDACTED:github_token]");
    expect(docText).toContain('PASSWORD=\\"[REDACTED:assignment]\\"');

    const searchRes = await client.callTool({
      name: "search_context",
      arguments: { query: "api_key" },
    });
    const searchText = (searchRes.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(searchText).not.toContain(fakeKey);
    expect(searchText).toContain("[REDACTED:llm_api_key]");

    const claimRes = await client.callTool({
      name: "claim_task",
      arguments: { task_id: TASK },
    });
    const claimJson = JSON.parse(
      (claimRes.content as Array<{ text: string }>)[0]?.text ?? "{}",
    ) as {
      task: { prompt_instruction: string };
      lease_id: string;
      dependency_handoffs: Array<{ handoff_summary: { notes_for_next_agent: string } }>;
    };
    expect(claimJson.lease_id).toBe("22222222-3333-4444-8555-666666666666");
    expect(claimJson.task.prompt_instruction).toBe("Run with [REDACTED:llm_api_key]");
    expect(claimJson.dependency_handoffs[0]?.handoff_summary.notes_for_next_agent).toBe(
      "Token: [REDACTED:github_token]",
    );

    // 3. load_skill output scrubbing (native skill on disk containing a secret)
    const claudeSkillDir = join(repoRoot, ".claude", "skills", "secret-skill");
    await mkdir(claudeSkillDir, { recursive: true });
    await writeFile(
      join(claudeSkillDir, "SKILL.md"),
      `---\ndescription: Test skill\n---\nUse ${fakeKey}\n`,
      "utf8",
    );
    const skillRes = await client.callTool({
      name: "load_skill",
      arguments: { name: "secret-skill" },
    });
    const skillText = (skillRes.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(skillText).not.toContain(fakeKey);
    expect(skillText).toContain("[REDACTED:llm_api_key]");

    // 4. readResource scrubbing for documents
    const readDoc = await client.readResource({ uri: "catenext://documents/secret-doc" });
    const readDocText = (readDoc.contents[0] as { text: string }).text;
    expect(readDocText).not.toContain(fakeGh);
    expect(readDocText).toContain("[REDACTED:github_token]");
    expect(readDocText).toContain('PASSWORD="[REDACTED:assignment]"');
  });

  it("reads catenext://handoffs/{task_id} via direct store lookup even when outside recent_handoffs", async () => {
    const fakeKey = ["sk-ant-api03", "testfixture0123456789abcdef"].join("-");
    const repoDir = await mkdtemp(join(tmpdir(), "catenext-mcp-handoff-store-"));
    try {
      await mkdir(join(repoDir, ".catenext"), { recursive: true });
      const config = CatenextConfigSchema.parse({
        schema_version: 1,
        project_id: randomUUID(),
        repo_name: "app",
        state_file: ".catenext/catenext.sqlite",
      });
      await writeFile(
        join(repoDir, ".catenext/config.yaml"),
        `schema_version: 1\nproject_id: ${config.project_id}\nrepo_name: app\nstate_file: .catenext/catenext.sqlite\n`,
        "utf8",
      );
      const human = new LocalService(repoDir, config, "human");
      await human.ensureSeed();
      const agent = new LocalService(repoDir, config, "agent");

      const { epic } = (await human.callTool("create_epic", {
        title: "Handoff Store Epic",
      })) as { epic: { id: string } };
      const { created } = (await human.callTool("create_tasks", {
        epic_id: epic.id,
        tasks: [
          {
            ref: "old-task",
            title: "Older completed task",
            prompt_instruction: "Do work",
            role: "backend",
          },
        ],
      })) as { created: Array<{ task_id: string }> };
      const oldTaskId = created[0]?.task_id ?? "";
      expect(oldTaskId).not.toBe("");
      await human.callTool("manage_task", { action: "approve_plan", task_id: oldTaskId });
      const claim = await agent.callTool("claim_task", { task_id: oldTaskId, agent_alias: "be" });
      await agent.callTool("complete_handoff", {
        task_id: oldTaskId,
        lease_id: claim.lease_id,
        handoff_summary: {
          ...HANDOFF,
          notes_for_next_agent: `Older handoff with secret ${fakeKey}`,
        },
      });
      await human.callTool("manage_task", { action: "approve", task_id: oldTaskId });

      // Verify get_project_context does not include this DONE task in recent_handoffs
      const ctxRes = await agent.callTool("get_project_context", {});
      expect(ctxRes.recent_handoffs.some((h) => h.task_id === oldTaskId)).toBe(false);

      const server = createCatenextMcpServer({
        version: "test",
        context: async () => ({ ok: true, service: agent, root: repoDir }),
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "claude-code", version: "1.0.0" });
      const transport: McpTransport = {
        async start() {
          a.onmessage = transport.onmessage;
          a.onclose = transport.onclose;
          await a.start();
        },
        close: () => a.close(),
        send: (msg) => a.send("error" in msg ? { ...msg, id: msg.id ?? undefined } : msg),
      };
      await Promise.all([server.connect(transport), client.connect(b)]);
      try {
        const readRes = await client.readResource({ uri: `catenext://handoffs/${oldTaskId}` });
        const parsed = JSON.parse((readRes.contents[0] as { text: string }).text) as {
          task_id: string;
          title: string;
          handoff_summary: { notes_for_next_agent: string };
        };
        expect(parsed.task_id).toBe(oldTaskId);
        expect(parsed.title).toBe("Older completed task");
        expect(parsed.handoff_summary.notes_for_next_agent).not.toContain(fakeKey);
        expect(parsed.handoff_summary.notes_for_next_agent).toContain("[REDACTED:llm_api_key]");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("enables CRUD only on opted-in non-worker/non-reviewer launches and keeps approvals human-only", async () => {
    const blockedProfiles: Array<{
      role?: "orchestrator" | "worker" | "reviewer";
      allowCrud?: boolean;
    }> = [
      { role: undefined, allowCrud: false },
      { role: "orchestrator", allowCrud: false },
      { role: "worker", allowCrud: true },
      { role: "reviewer", allowCrud: true },
    ];
    for (const profile of blockedProfiles) {
      const { client } = await setup(undefined, undefined, profile.role, profile.allowCrud);
      const { tools } = await client.listTools();
      for (const name of MCP_CRUD_TOOLS) {
        expect(tools.some((tool) => tool.name === name)).toBe(false);
        await expect(
          client.callTool({
            name,
            arguments: {
              task_id: TASK,
              epic_id: TASK,
              title: "Denied edit",
              depends_on: [],
              allowCrud: true,
              caller: "human",
              role: "orchestrator",
            },
          }),
        ).rejects.toThrow(`Tool ${name} not found`);
      }
      await close?.();
      close = undefined;
      if (root) {
        await rm(root, { recursive: true, force: true });
        root = undefined;
      }
    }

    const defaultCrud = await setup(undefined, undefined, undefined, true);
    expect((await defaultCrud.client.listTools()).tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining([...MCP_CRUD_TOOLS]),
    );
    await close?.();
    close = undefined;
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }

    const repoDir = await mkdtemp(join(tmpdir(), "catenext-mcp-crud-"));
    try {
      await mkdir(join(repoDir, ".catenext"), { recursive: true });
      const config = CatenextConfigSchema.parse({
        schema_version: 1,
        project_id: randomUUID(),
        repo_name: "app",
        state_file: ".catenext/catenext.sqlite",
      });
      await writeFile(
        join(repoDir, ".catenext/config.yaml"),
        `schema_version: 1\nproject_id: ${config.project_id}\nrepo_name: app\nstate_file: .catenext/catenext.sqlite\n`,
        "utf8",
      );
      const human = new LocalService(repoDir, config, "human");
      await human.ensureSeed();
      const service = new LocalService(repoDir, config, "agent", { allowCrud: true });

      const server = createCatenextMcpServer({
        version: "test",
        context: async () => ({ ok: true, service, root: repoDir }),
        role: "orchestrator",
        allowCrud: true,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "claude-code", version: "1.0.0" });
      const transport: McpTransport = {
        async start() {
          a.onmessage = transport.onmessage;
          a.onclose = transport.onclose;
          await a.start();
        },
        close: () => a.close(),
        send: (msg) => a.send("error" in msg ? { ...msg, id: msg.id ?? undefined } : msg),
      };
      await Promise.all([server.connect(transport), client.connect(b)]);
      const callJson = async <T>(name: McpToolName, args: Record<string, unknown>): Promise<T> => {
        const res = await client.callTool({ name, arguments: args });
        if (res.isError) throw new Error(textOf(res));
        return JSON.parse(textOf(res)) as T;
      };
      try {
        expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(
          expect.arrayContaining([...MCP_CRUD_TOOLS]),
        );

        const { epic } = await callJson<{ epic: { id: string } }>("create_epic", {
          title: "Fixture epic",
        });
        const { created } = await callJson<{ created: Array<{ task_id: string }> }>(
          "create_tasks",
          {
            epic_id: epic.id,
            tasks: [
              { ref: "a", title: "Fixture A", prompt_instruction: "Build fixture A" },
              { ref: "b", title: "Fixture B", prompt_instruction: "Build fixture B" },
            ],
          },
        );
        const [taskA, taskB] = created;
        if (!taskA || !taskB) throw new Error("Fixture tasks missing");

        const updatedEpic = await callJson<{ epic: { title: string } }>("update_epic", {
          epic_id: epic.id,
          title: "Updated epic",
        });
        expect(updatedEpic.epic.title).toBe("Updated epic");

        expect(
          await callJson("update_task", {
            task_id: taskA.task_id,
            title: "Updated task",
            requires_approval: false,
            status: "DONE",
          }),
        ).toMatchObject({ task_id: taskA.task_id, title: "Updated task", status: "DRAFT" });

        expect(
          await callJson("set_dependencies", {
            task_id: taskB.task_id,
            depends_on: [taskA.task_id],
          }),
        ).toEqual({
          task_id: taskB.task_id,
          depends_on: [taskA.task_id],
        });

        const cycleRes = await client.callTool({
          name: "set_dependencies",
          arguments: { task_id: taskA.task_id, depends_on: [taskB.task_id] },
        });
        expect(cycleRes.isError).toBe(true);
        expect(textOf(cycleRes)).toMatch(/melingkar/);

        const blockedCancel = await client.callTool({
          name: "cancel_task",
          arguments: { task_id: taskA.task_id },
        });
        expect(blockedCancel.isError).toBe(true);
        expect(textOf(blockedCancel)).toMatch(/dependensi/);

        for (const action of ["approve_plan", "approve"]) {
          const denied = await client.callTool({
            name: "manage_task",
            arguments: { task_id: taskA.task_id, action, caller: "human" },
          });
          expect(denied.isError).toBe(true);
          expect(textOf(denied)).toMatch(/catenext (task|review) approve/);
        }

        expect(await callJson("cancel_task", { task_id: taskB.task_id })).toMatchObject({
          task_id: taskB.task_id,
          cancelled: true,
        });

        const store = new LocalStore(stateFilePath(repoDir, config));
        const events = await store.readTaskEvents(config.project_id, { actor: "agent" });
        expect(events.map((e) => ({ event: e.event, actor: e.actor }))).toEqual(
          expect.arrayContaining(
            ["update", "set_dependencies", "cancel"].map((event) => ({ event, actor: "agent" })),
          ),
        );
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
