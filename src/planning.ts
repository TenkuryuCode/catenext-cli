import { readFile } from "node:fs/promises";
import {
  CreateEpicToolInput,
  CreateTasksInput,
  type McpToolOutput,
  UpsertPersonaInput,
} from "@catenext/shared";
import type { z } from "zod";
import { AgentApi } from "./api-client.js";
import { ConfigError, findProjectRoot, readConfig } from "./config.js";
import { loadCredentials, resolveApiUrl } from "./credentials.js";
import { describeRedactions, scrubDeep } from "./scrubber.js";

/**
 * Perintah CLI untuk merencanakan tanpa Web UI (fallback non-MCP, blueprint §4.3).
 * Memakai endpoint /api/v1/agent yang sama dengan tool MCP, jadi aturannya identik:
 * proyek & repo dari .catenext/config.yaml, teks disensor secret-scrubber lokal,
 * dan task baru selalu DRAFT sampai disetujui manusia di Web.
 */

export class PlanningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningInputError";
  }
}

export async function cliApi(agentName = "catenext-cli"): Promise<AgentApi> {
  const root = await findProjectRoot();
  if (!root) {
    throw new ConfigError(
      "Tidak ada .catenext/config.yaml di folder ini atau induknya. Jalankan `catenext init --project <project_id>` dulu.",
    );
  }
  const config = await readConfig(root);
  const creds = await loadCredentials();
  return new AgentApi({
    baseUrl: resolveApiUrl(config.api_url, creds.api_url),
    apiKey: creds.api_key,
    projectId: config.project_id,
    repoName: config.repo_name,
    agentName: () => agentName,
    onWarning: (m) => console.error(`! Kuota: ${m}`),
  });
}

/** Sensor secret lalu validasi ulang dengan skema yang sama seperti tool MCP. */
export function prepare<S extends z.ZodType>(
  schema: S,
  input: unknown,
  keep: string[],
): z.output<S> {
  const scrubbed = scrubDeep(input, new Set(keep));
  if (scrubbed.total > 0) console.error(`! ${describeRedactions(scrubbed)}`);
  const parsed = schema.safeParse(scrubbed.value);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new PlanningInputError(`Input tidak valid:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ") || "belum ada task";

export async function epicList(api: AgentApi, asJson: boolean) {
  const res = await api.post<McpToolOutput<"list_epics">>("epics/list");
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  if (res.epics.length === 0) {
    return console.log('Belum ada epic. Buat dengan: catenext epic create "<judul>"');
  }
  for (const e of res.epics) console.log(`${e.id}  ${e.title}  (${counts(e.task_counts)})`);
}

export async function epicCreate(
  api: AgentApi,
  title: string,
  description: string | undefined,
  asJson: boolean,
) {
  const body = prepare(CreateEpicToolInput, { title, description }, []);
  const res = await api.post<McpToolOutput<"create_epic">>("epics", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  console.log(`✓ Epic "${res.epic.title}" dibuat: ${res.epic.id}`);
  console.log(`  Lanjut: catenext task create --epic ${res.epic.id} --file rencana.json`);
}

export async function readJsonInput(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw =
      file === "-"
        ? await new Promise<string>((res, rej) => {
            let data = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (c) => {
              data += c;
            });
            process.stdin.on("end", () => res(data));
            process.stdin.on("error", rej);
          })
        : await readFile(file, "utf8");
  } catch (err) {
    throw new PlanningInputError(`Tidak bisa membaca ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new PlanningInputError(`${file} bukan JSON yang valid.`);
  }
}

/** File rencana boleh berupa array task, atau objek { tasks: [...] }. */
export async function taskCreate(api: AgentApi, epicId: string, file: string, asJson: boolean) {
  const plan = await readJsonInput(file);
  const tasks = Array.isArray(plan) ? plan : (plan as { tasks?: unknown })?.tasks;
  const body = prepare(CreateTasksInput, { epic_id: epicId, tasks }, [
    "epic_id",
    "ref",
    "depends_on",
    "target_repo",
    "role",
  ]);
  const res = await api.post<McpToolOutput<"create_tasks">>("tasks", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  for (const t of res.created) console.log(`+ ${t.ref.padEnd(16)} ${t.task_id}  ${t.status}`);
  console.log(
    `\n✓ ${res.created.length} task diajukan sebagai DRAFT. Tinjau & setujui rencananya di Web sebelum agen bisa mengambilnya.`,
  );
}

export async function personaList(api: AgentApi, asJson: boolean) {
  const res = await api.post<McpToolOutput<"list_personas">>("personas/list");
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  if (res.personas.length === 0) {
    return console.log(
      'Belum ada persona. Buat dengan: catenext persona set <alias> --role <role> --rule "..."',
    );
  }
  for (const p of res.personas) {
    console.log(`${p.alias} (${p.role}, ${p.scope === "project" ? "proyek" : "workspace"})`);
    for (const r of p.rules) console.log(`  - ${r}`);
  }
}

export async function personaSet(
  api: AgentApi,
  alias: string,
  role: string,
  rules: string[],
  asJson: boolean,
) {
  const body = prepare(UpsertPersonaInput, { alias, role, rules }, ["alias", "role"]);
  const res = await api.put<McpToolOutput<"upsert_persona">>("personas", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  console.log(
    `✓ Persona "${res.persona.alias}" (${res.persona.role}) ${res.created ? "dibuat" : "diperbarui"} untuk proyek ini, ${res.persona.rules.length} aturan.`,
  );
}
