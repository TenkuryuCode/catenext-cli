import { readFile } from "node:fs/promises";
import {
  CreateEpicToolInput,
  CreateTasksInput,
  GetDocumentInput,
  GetProjectBoardInput,
  SaveDocumentInput,
  SEARCH_SOURCES,
  SearchContextInput,
  type SearchContextOutputType,
  UpsertPersonaInput,
} from "@catenext/shared";
import type { z } from "zod";
import { keywordFallback, searchLocalCode } from "./code-search.js";
import { ConfigError, findProjectRoot, readConfig } from "./config.js";
import { LocalService } from "./local-service.js";
import { describeRedactions, scrubDeep } from "./scrubber.js";

export class PlanningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningInputError";
  }
}

export async function requireRoot(): Promise<string> {
  const root = await findProjectRoot();
  if (!root) {
    throw new ConfigError(
      "Tidak ada .catenext/config.yaml di folder ini atau induknya. Jalankan `catenext init` dulu.",
    );
  }
  return root;
}

export async function cliService(root?: string): Promise<LocalService> {
  const repoRoot = root ?? (await requireRoot());
  return new LocalService(repoRoot, await readConfig(repoRoot));
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
    const lines = parsed.error.issues.map((i) =>
      i.path[0] === "lease_id"
        ? "  - --lease wajib: ambil nilai lease_id dari `catenext claim <task_id>`."
        : `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new PlanningInputError(`Input tidak valid:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

const counts = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ") || "belum ada task";

export async function epicList(service: LocalService, asJson: boolean) {
  const res = await service.callTool("list_epics", {});
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  if (res.epics.length === 0) {
    return console.log('Belum ada epic. Buat dengan: catenext epic create "<judul>"');
  }
  for (const e of res.epics) console.log(`${e.id}  ${e.title}  (${counts(e.task_counts)})`);
}

export async function epicCreate(
  service: LocalService,
  title: string,
  description: string | undefined,
  asJson: boolean,
) {
  const body = prepare(CreateEpicToolInput, { title, description }, []);
  const res = await service.callTool("create_epic", body);
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
export async function taskCreate(
  service: LocalService,
  epicId: string,
  file: string,
  asJson: boolean,
) {
  const plan = await readJsonInput(file);
  const tasks = Array.isArray(plan) ? plan : (plan as { tasks?: unknown })?.tasks;
  const body = prepare(CreateTasksInput, { epic_id: epicId, tasks }, [
    "epic_id",
    "ref",
    "depends_on",
    "target_repo",
    "role",
    "persona",
  ]);
  const res = await service.callTool("create_tasks", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  for (const t of res.created) console.log(`+ ${t.ref.padEnd(16)} ${t.task_id}  ${t.status}`);
  console.log(
    `\n✓ ${res.created.length} task diajukan sebagai DRAFT. Tinjau lalu setujui dengan catenext task approve <id> sebelum agen bisa mengambilnya.`,
  );
}

export async function personaList(service: LocalService, asJson: boolean) {
  const res = await service.callTool("list_personas", {});
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  if (res.personas.length === 0) {
    return console.log(
      'Belum ada persona. Buat dengan: catenext persona set <alias> --role <role> --rule "..."',
    );
  }
  for (const p of res.personas) {
    const repos = p.repos.length > 0 ? `, repo ${p.repos.join("/")}` : "";
    console.log(
      `${p.alias} (${p.role}${repos}, ${p.scope === "project" ? "proyek" : "workspace"})`,
    );
    for (const r of p.rules) console.log(`  - ${r}`);
  }
}

export async function personaSet(
  service: LocalService,
  alias: string,
  role: string,
  rules: string[],
  asJson: boolean,
  repos?: string[],
) {
  const body = prepare(
    UpsertPersonaInput,
    {
      alias,
      role,
      // Tanpa --rule: aturan lama dipertahankan (persona baru mewarisi persona master).
      ...(rules.length > 0 ? { rules } : {}),
      ...(repos ? { repos } : {}),
    },
    ["alias", "role", "repos"],
  );
  const res = await service.callTool("upsert_persona", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  console.log(
    `✓ Persona "${res.persona.alias}" (${res.persona.role}) ${res.created ? "dibuat" : "diperbarui"} untuk proyek ini, ${res.persona.rules.length} aturan${res.persona.repos.length > 0 ? `, memegang repo ${res.persona.repos.join(", ")}` : ""}.`,
  );
}

/** Papan proyek lintas repo untuk orchestrator (setara get_project_board). */
export async function boardShow(
  service: LocalService,
  opts: { epic?: string; status?: string[]; json?: boolean },
) {
  const body = prepare(
    GetProjectBoardInput,
    {
      ...(opts.epic ? { epic_id: opts.epic } : {}),
      ...(opts.status?.length ? { status: opts.status } : {}),
    },
    ["epic_id", "status"],
  );
  const res = await service.callTool("get_project_board", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log("Repo:");
  for (const r of res.repos)
    console.log(
      `  ${r.repo}: ${r.personas.length ? r.personas.join(", ") : "(belum ada persona)"}`,
    );
  for (const e of res.epics) {
    console.log(`\n# ${e.title}  ${JSON.stringify(e.counts)}`);
    for (const t of res.tasks.filter((x) => x.epic_id === e.id)) {
      const who = t.persona ? `@${t.persona}` : t.role ? `role ${t.role}` : "-";
      const flags = [t.is_ready ? "siap" : null, t.is_stale ? "stale" : null]
        .filter(Boolean)
        .join(",");
      console.log(
        `  ${t.status.padEnd(18)} ${t.id}  ${t.title}  [${t.target_repo ?? "repo bebas"} · ${who}]${flags ? ` (${flags})` : ""}`,
      );
    }
  }
  if (res.truncated) console.log("\n(daftar dipotong; pakai --epic untuk mempersempit)");
}

export async function docList(service: LocalService, asJson: boolean) {
  const { documents } = await service.callTool("get_project_context", {});
  if (asJson) return console.log(JSON.stringify({ documents }, null, 2));
  if (documents.length === 0)
    return console.log(
      "Belum ada dokumen proyek. Buat dengan: catenext doc save <slug> --file <path.md>",
    );
  for (const d of documents)
    console.log(`${d.slug}  v${d.version}  ${d.kind}  ${d.title}  (${d.size} karakter)`);
}

export async function docGet(service: LocalService, slug: string, asJson: boolean) {
  const body = prepare(GetDocumentInput, { slug }, ["slug"]);
  const res = await service.callTool("get_document", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  console.log(`<!-- ${res.slug} v${res.version} (${res.kind}) -->`);
  console.log(res.content);
}

export async function docSave(
  service: LocalService,
  slug: string,
  opts: { file: string; title?: string; kind: string; version?: string; json?: boolean },
) {
  const content = await readFile(opts.file, "utf8");
  const body = prepare(
    SaveDocumentInput,
    {
      slug,
      title: opts.title ?? slug,
      kind: opts.kind,
      content,
      ...(opts.version !== undefined ? { expected_version: Number(opts.version) } : {}),
    },
    ["slug", "kind", "expected_version"],
  );
  const res = await service.callTool("save_document", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(
    `✓ Dokumen "${res.document.slug}" ${res.created ? "dibuat" : "diperbarui"} (v${res.document.version}).`,
  );
}

const CONTEXT_SOURCES = new Set<string>(SEARCH_SOURCES);

/** `catenext search` — dokumen, skill, task, dan/atau kode lokal. */
export async function searchShow(
  query: string,
  opts: { source?: string[]; limit?: number; json?: boolean },
) {
  const wanted = [...new Set(opts.source?.length ? opts.source : [...SEARCH_SOURCES, "code"])];
  for (const source of wanted) {
    if (source !== "code" && !CONTEXT_SOURCES.has(source)) {
      throw new PlanningInputError(`Sumber pencarian tidak valid: ${source}.`);
    }
  }
  const contextSources = wanted.filter((s): s is (typeof SEARCH_SOURCES)[number] =>
    CONTEXT_SOURCES.has(s),
  );
  const body = prepare(
    SearchContextInput,
    { query, sources: contextSources.length ? contextSources : undefined, limit: opts.limit },
    ["sources", "limit"],
  );
  const root = await requireRoot();
  const context: SearchContextOutputType | undefined = contextSources.length
    ? await (await cliService(root)).callTool("search_context", body)
    : undefined;

  let codeHits: Awaited<ReturnType<typeof searchLocalCode>>["hits"] = [];
  let codeNote: string | undefined;
  if (wanted.includes("code")) {
    try {
      codeHits = (await searchLocalCode(root, body.query, body.limit)).hits;
      if (!codeHits.length) codeHits = await keywordFallback(root, body.query, body.limit);
    } catch {
      codeNote = "Indeks kode gagal; memakai pencarian kata kunci.";
      codeHits = await keywordFallback(root, body.query, body.limit);
    }
  }

  const hits = [...(context?.hits ?? []), ...codeHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, body.limit)
    .map((hit) => ({ ...hit, origin: "local" as const }));
  const payload = {
    hits,
    reranked: context?.reranked ?? false,
    degraded: context?.degraded ?? true,
    ...(codeNote ? { note: codeNote } : {}),
  };
  if (opts.json) return console.log(JSON.stringify(payload, null, 2));
  if (codeNote) console.error(`! ${codeNote}`);
  if (hits.length === 0) return console.log("Tidak ada hasil.");
  for (const h of hits) {
    console.log(
      `${h.score.toFixed(3)}  [${h.source}]  ${h.ref}  ${h.title}\n    ${h.snippet.slice(0, 120)}`,
    );
  }
}
