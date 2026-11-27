import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema, type McpToolName } from "@catenext/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { indexProjectGraph } from "../db/graph-index.js";
import { LocalService } from "../local-service.js";
import { ROLE_TOOLS } from "./catalog.js";
import { createCatenextMcpServer, LOCAL_TOOLS, type ServerContext } from "./server.js";
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
  role?: "orchestrator" | "worker",
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
    expect(tools).toHaveLength(29);
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
});
