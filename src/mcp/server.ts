import {
  type CatenextConfig,
  CompleteHandoffInput,
  CreateEpicToolInput,
  CreateTasksInput,
  MCP_TOOLS,
  ReportBlockerInput,
  SaveRepoSkillInput,
  UpsertPersonaInput,
} from "@catenext/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { type AgentApi, ApiRequestError } from "../api-client.js";
import { describeRedactions, scrubDeep } from "../scrubber.js";
import { listSkills, loadSkill, SkillError, saveSkill, skillIndex } from "../skills.js";

/** Semua tool yang diekspos server MCP lokal. */
export const LOCAL_TOOLS = [
  "get_project_context",
  "get_ready_tasks",
  "claim_task",
  "complete_handoff",
  "report_blocker",
  "list_epics",
  "create_epic",
  "create_tasks",
  "list_personas",
  "upsert_persona",
  "load_skill",
  "save_repo_skill",
] as const;

export const SERVER_INSTRUCTIONS = [
  "Catenext mengatur estafet task antar-agen AI untuk repo ini.",
  "Alur: get_project_context -> get_ready_tasks -> claim_task -> kerjakan & tes -> complete_handoff.",
  "Merencanakan: list_epics/create_epic -> create_tasks (masuk DRAFT, disetujui manusia di Web sebelum bisa dikerjakan).",
  "Persona: list_personas/upsert_persona untuk alias, role, dan aturan agen di proyek ini.",
  "Skill repo: indeksnya ada di get_project_context; panggil load_skill hanya bila relevan, dan save_repo_skill untuk mencatat konvensi/pitfall yang ditemukan (maks. 500 kata, tanpa code dump).",
  "Bila buntu, panggil report_blocker. Jangan menyalin kode atau secret ke handoff; rujuk path file.",
  "Jangan mengedit .catenext/config.yaml atau file konfigurasi MCP IDE.",
].join(" ");

/** Konteks yang dibutuhkan tool. `ready` = null bila config/kredensial belum siap. */
export type ServerContext =
  | { ok: true; api: AgentApi; config: CatenextConfig; root: string }
  | { ok: false; error: string };

export interface ServerOptions {
  version: string;
  /** Dipanggil lazily agar server tetap hidup dan memberi pesan jelas meski belum login/init. */
  context: () => Promise<ServerContext>;
  log?: (message: string) => void;
}

const text = (body: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true } : {}),
});

const json = (data: unknown, notes: string[] = []): CallToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(data, null, 2) },
    ...notes.map((n) => ({ type: "text" as const, text: n })),
  ],
});

function errorResult(err: unknown): CallToolResult {
  if (err instanceof SkillError) return text(`Catenext: ${err.message}`, true);
  if (err instanceof ApiRequestError) {
    const detail = err.details ? `\nDetail: ${JSON.stringify(err.details)}` : "";
    return text(`Catenext: ${err.message} [${err.code}]${detail}`, true);
  }
  return text(`Catenext: ${(err as Error).message ?? String(err)}`, true);
}

function zodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function createCatenextMcpServer(opts: ServerOptions): McpServer {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[catenext] ${m}\n`));
  const server = new McpServer(
    { name: "catenext", version: opts.version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /** Setiap panggilan diteruskan ke API; API memperpanjang lease task repo ini (heartbeat). */
  const call = async (
    run: (ctx: Extract<ServerContext, { ok: true }>) => Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    const ctx = await opts.context();
    if (!ctx.ok) return text(`Catenext belum siap: ${ctx.error}`, true);
    let result: CallToolResult;
    try {
      result = await run(ctx);
    } catch (err) {
      result = errorResult(err);
    }
    const warning = ctx.api.takeWarning();
    if (warning) {
      result.content.push({
        type: "text",
        text: `Peringatan kuota Catenext: ${warning} Beri tahu pengguna; board tetap bisa dibaca bila kuota habis.`,
      });
    }
    return result;
  };

  server.registerTool(
    "get_project_context",
    {
      description: MCP_TOOLS.get_project_context.description,
      inputSchema: MCP_TOOLS.get_project_context.input,
    },
    (input) =>
      call(async ({ api, config }) =>
        json(
          await api.post("context", {
            agent_alias: input.agent_alias ?? config.overrides?.default_agent_alias,
            role: input.role ?? config.overrides?.default_role,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_ready_tasks",
    {
      description: MCP_TOOLS.get_ready_tasks.description,
      inputSchema: MCP_TOOLS.get_ready_tasks.input,
    },
    (input) =>
      call(async ({ api, config }) =>
        json(
          await api.post("ready-tasks", {
            agent_alias: input.agent_alias ?? config.overrides?.default_agent_alias,
            role: input.role ?? config.overrides?.default_role,
            limit: input.limit,
          }),
        ),
      ),
  );

  server.registerTool(
    "claim_task",
    { description: MCP_TOOLS.claim_task.description, inputSchema: MCP_TOOLS.claim_task.input },
    (input) => call(async ({ api }) => json(await api.post("claim", { task_id: input.task_id }))),
  );

  server.registerTool(
    "complete_handoff",
    {
      description: `${MCP_TOOLS.complete_handoff.description} Teks disensor secret-scrubber lokal sebelum dikirim.`,
      inputSchema: MCP_TOOLS.complete_handoff.input,
    },
    (input) =>
      call(async ({ api }) => {
        const scrubbed = scrubDeep(input, new Set(["task_id", "last_commit_hash"]));
        // Validasi ulang setelah sensor: batas ukuran Zod tetap berlaku pada payload final.
        const parsed = CompleteHandoffInput.safeParse(scrubbed.value);
        if (!parsed.success) {
          return text(
            `Handoff ditolak sebelum dikirim (batas ukuran/format):\n${zodIssues(parsed.error)}\nRingkas lalu panggil complete_handoff lagi.`,
            true,
          );
        }
        const notes: string[] = [];
        if (scrubbed.total > 0) {
          const note = describeRedactions(scrubbed);
          log(note);
          notes.push(note);
        }
        return json(await api.post("complete", parsed.data), notes);
      }),
  );

  server.registerTool(
    "report_blocker",
    {
      description: MCP_TOOLS.report_blocker.description,
      inputSchema: MCP_TOOLS.report_blocker.input,
    },
    (input) =>
      call(async ({ api }) => {
        const scrubbed = scrubDeep(input, new Set(["task_id", "category"]));
        const parsed = ReportBlockerInput.safeParse(scrubbed.value);
        if (!parsed.success) {
          return text(`Laporan blocker tidak valid:\n${zodIssues(parsed.error)}`, true);
        }
        const notes: string[] = [];
        if (scrubbed.total > 0) {
          const note = describeRedactions(scrubbed);
          log(note);
          notes.push(note);
        }
        return json(await api.post("blocker", parsed.data), notes);
      }),
  );

  /**
   * Tool yang menulis teks bebas ke Cloud (epic, rencana task, aturan persona): sensor secret
   * lokal dulu, lalu validasi ulang batas Zod pada payload final sebelum dikirim.
   */
  const scrubbedWrite =
    <S extends z.ZodType>(
      schema: S,
      keep: string[],
      send: (api: AgentApi, payload: z.output<S>) => Promise<unknown>,
    ) =>
    (input: unknown) =>
      call(async ({ api }) => {
        const scrubbed = scrubDeep(input, new Set(keep));
        const parsed = schema.safeParse(scrubbed.value);
        if (!parsed.success) {
          return text(`Input ditolak sebelum dikirim:\n${zodIssues(parsed.error)}`, true);
        }
        const notes: string[] = [];
        if (scrubbed.total > 0) {
          const note = describeRedactions(scrubbed);
          log(note);
          notes.push(note);
        }
        return json(await send(api, parsed.data), notes);
      });

  server.registerTool(
    "list_epics",
    { description: MCP_TOOLS.list_epics.description, inputSchema: MCP_TOOLS.list_epics.input },
    () => call(async ({ api }) => json(await api.post("epics/list"))),
  );

  server.registerTool(
    "create_epic",
    { description: MCP_TOOLS.create_epic.description, inputSchema: MCP_TOOLS.create_epic.input },
    scrubbedWrite(CreateEpicToolInput, [], (api, body) => api.post("epics", body)),
  );

  server.registerTool(
    "create_tasks",
    {
      description: `${MCP_TOOLS.create_tasks.description} Task baru tidak bisa diklaim sebelum disetujui.`,
      inputSchema: MCP_TOOLS.create_tasks.input,
    },
    scrubbedWrite(
      CreateTasksInput,
      ["epic_id", "ref", "depends_on", "target_repo", "role"],
      (api, body) => api.post("tasks", body),
    ),
  );

  server.registerTool(
    "list_personas",
    {
      description: MCP_TOOLS.list_personas.description,
      inputSchema: MCP_TOOLS.list_personas.input,
    },
    () => call(async ({ api }) => json(await api.post("personas/list"))),
  );

  server.registerTool(
    "upsert_persona",
    {
      description: MCP_TOOLS.upsert_persona.description,
      inputSchema: MCP_TOOLS.upsert_persona.input,
    },
    scrubbedWrite(UpsertPersonaInput, ["alias", "role"], (api, body) => api.put("personas", body)),
  );

  server.registerTool(
    "load_skill",
    { description: MCP_TOOLS.load_skill.description, inputSchema: MCP_TOOLS.load_skill.input },
    (input) =>
      call(async ({ root }) => {
        const skill = await loadSkill(root, input.name);
        return json({ name: skill.name, when_to_use: skill.when_to_use, content: skill.content });
      }),
  );

  server.registerTool(
    "save_repo_skill",
    {
      description: `${MCP_TOOLS.save_repo_skill.description} Isi tetap di repo; hanya indeks (nama + when_to_use) yang dikirim ke Cloud.`,
      inputSchema: MCP_TOOLS.save_repo_skill.input,
    },
    (input) =>
      call(async ({ api, root }) => {
        const scrubbed = scrubDeep(input, new Set(["name"]));
        const parsed = SaveRepoSkillInput.safeParse(scrubbed.value);
        if (!parsed.success) {
          return text(
            `Skill ditolak:\n${zodIssues(parsed.error)}\nRingkas (rujuk path file, jangan menyalin kode) lalu coba lagi.`,
            true,
          );
        }
        const notes: string[] = [];
        if (scrubbed.total > 0) {
          const note = describeRedactions(scrubbed);
          log(note);
          notes.push(note);
        }
        const saved = await saveSkill(root, parsed.data);
        // Indeks Tier 1 ke Cloud. Gagal sinkron tidak membatalkan file lokal.
        try {
          const { skills } = await listSkills(root);
          await api.put("skills", { skills: skillIndex(skills) });
        } catch (err) {
          notes.push(
            `Skill tersimpan lokal, tetapi indeks belum tersinkron ke Cloud (${(err as Error).message}). Jalankan \`catenext sync\` nanti.`,
          );
        }
        return json({ path: saved.path, created: saved.created }, notes);
      }),
  );

  return server;
}
