import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatenextConfig } from "@catenext/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentApi } from "../api-client.js";
import { createCatenextMcpServer, LOCAL_TOOLS, type ServerContext } from "./server.js";

const CONFIG: CatenextConfig = {
  schema_version: 1,
  project_id: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  repo_name: "backend",
  stack: [],
  overrides: { default_role: "backend" },
};
const TASK = "11111111-2222-4333-8444-555555555555";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let close: (() => Promise<void>) | undefined;
let root: string | undefined;
afterEach(async () => {
  await close?.();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup(
  respond: (c: Captured) => {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  } = () => ({
    status: 200,
    body: { ok: 1 },
  }),
  ctxOverride?: ServerContext,
) {
  const calls: Captured[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const c: Captured = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    };
    calls.push(c);
    const r = respond(c);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;

  let agentName: string | undefined;
  const api = new AgentApi({
    baseUrl: "http://api.test",
    apiKey: "ctnx_testtesttesttesttest",
    projectId: CONFIG.project_id,
    repoName: CONFIG.repo_name,
    agentName: () => agentName,
    fetch: fakeFetch,
  });
  const logs: string[] = [];
  root = await mkdtemp(join(tmpdir(), "catenext-mcp-"));
  const repoRoot = root;
  const server = createCatenextMcpServer({
    version: "test",
    context: async () => ctxOverride ?? { ok: true, api, config: CONFIG, root: repoRoot },
    log: (m) => logs.push(m),
  });
  server.server.oninitialized = () => {
    agentName = server.server.getClientVersion()?.name;
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  close = async () => {
    await client.close();
    await server.close();
  };
  return { client, calls, logs, root: repoRoot };
}

const textOf = (r: unknown) =>
  ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");

const HANDOFF = {
  files_modified: ["apps/api/src/app.ts"],
  key_decisions: ["Pakai Hono"],
  verification_command: "pnpm test",
  notes_for_next_agent: "Endpoint siap dipakai frontend.",
  git_branch: "feat/x",
  last_commit_hash: "abcdef1",
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

  it("meneruskan ke /api/v1/agent dengan header dari config dan nama klien", async () => {
    const { client, calls } = await setup();
    await client.callTool({ name: "get_ready_tasks", arguments: {} });
    expect(calls[0]?.url).toBe("http://api.test/api/v1/agent/ready-tasks");
    expect(calls[0]?.headers).toMatchObject({
      authorization: "Bearer ctnx_testtesttesttesttest",
      "x-catenext-project": CONFIG.project_id,
      "x-catenext-repo": "backend",
      "x-catenext-agent": "claude-code",
    });
    // default_role dari overrides dipakai bila agen tidak mengisi role
    expect(calls[0]?.body).toEqual({ role: "backend", limit: 10 });
  });

  it("menolak input project_id dari agen (tidak diteruskan)", async () => {
    const { client, calls } = await setup();
    await client.callTool({
      name: "claim_task",
      arguments: { task_id: TASK, project_id: "00000000-0000-4000-8000-000000000000" },
    });
    expect(calls[0]?.body).toEqual({ task_id: TASK });
    expect(calls[0]?.headers["x-catenext-project"]).toBe(CONFIG.project_id);
  });

  it("menyensor secret di handoff sebelum dikirim dan memberi tahu agen", async () => {
    const { client, calls, logs } = await setup();
    const res = await client.callTool({
      name: "complete_handoff",
      arguments: {
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
    expect(textOf(res)).toContain("secret-scrubber lokal menyensor");
    expect(logs).toHaveLength(1);
  });

  it("menolak handoff yang melebihi batas ukuran tanpa memanggil API", async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({
      name: "complete_handoff",
      arguments: {
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

  it("menampilkan pesan error API yang ramah manusia", async () => {
    const { client } = await setup(() => ({
      status: 409,
      body: {
        error: { code: "repo_locked", message: "Repo backend sedang mengerjakan task lain." },
      },
    }));
    const res = await client.callTool({ name: "claim_task", arguments: { task_id: TASK } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Repo backend sedang mengerjakan task lain. [repo_locked]");
  });

  it("memberi langkah perbaikan bila belum init/login", async () => {
    const { client, calls } = await setup(undefined, {
      ok: false,
      error: "Belum login. Jalankan `catenext login`.",
    });
    const res = await client.callTool({ name: "get_project_context", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("catenext login");
    expect(calls).toHaveLength(0);
  });

  it("create_epic & list_epics meneruskan ke endpoint epic", async () => {
    const { client, calls } = await setup();
    await client.callTool({ name: "create_epic", arguments: { title: "Fitur login" } });
    await client.callTool({ name: "list_epics", arguments: {} });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST http://api.test/api/v1/agent/epics",
      "POST http://api.test/api/v1/agent/epics/list",
    ]);
    expect(calls[0]?.body).toEqual({ title: "Fitur login" });
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
    expect(calls[0]?.url).toBe("http://api.test/api/v1/agent/tasks");
    const sent = JSON.stringify(calls[0]?.body);
    expect(sent).not.toContain("supersecretvalue123");
    expect(calls[0]?.body).toMatchObject({
      epic_id: TASK,
      tasks: [{ ref: "db" }, { ref: "api", depends_on: ["db"] }],
    });
  });

  it("create_tasks menolak dependensi melingkar tanpa memanggil API", async () => {
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

  it("upsert_persona memakai PUT dan tidak meneruskan project_id dari agen", async () => {
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
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("http://api.test/api/v1/agent/personas");
    expect(calls[0]?.body).toEqual({
      alias: "bambang",
      role: "backend",
      rules: ["Selalu tulis tes"],
    });
  });

  it("save_repo_skill menulis file lokal dan menyensor secret tanpa mengubah indeks Cloud", async () => {
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
    expect(JSON.parse(first)).toEqual({ path: ".catenext/skills/db-migrations.md", created: true });
    expect(textOf(res)).toMatch(/disensor|REDACTED|secret/i);
    const file = await readFile(join(dir, ".catenext/skills/db-migrations.md"), "utf8");
    expect(file).toContain("name: db-migrations");
    expect(file).not.toContain("sk_live_abcdefghijklmnop1234");
    expect(calls).toHaveLength(0);
    expect(textOf(res)).toContain("catenext sync");

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

  it("meneruskan peringatan kuota dari API ke agen", async () => {
    const { client } = await setup(() => ({
      status: 200,
      body: { tasks: [] },
      headers: {
        "x-catenext-quota-warning": "Panggilan agen (tulis) bulan ini: 410/500 (82% kuota).",
      },
    }));
    const res = await client.callTool({ name: "get_ready_tasks", arguments: {} });
    expect(textOf(res)).toContain(
      "Peringatan kuota Catenext: Panggilan agen (tulis) bulan ini: 410/500",
    );
  });
});
