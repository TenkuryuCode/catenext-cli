import { readFile } from "node:fs/promises";
import {
  ArchiveDocumentInput,
  CreateEpicToolInput,
  CreateTasksInput,
  EPIC_TEMPLATES,
  findEpicTemplate,
  GetDocumentInput,
  GetProjectBoardInput,
  GetProjectContextInput,
  type PlatformId,
  RemovePersonaInput,
  RestoreDocumentInput,
  SaveDocumentInput,
  SEARCH_SOURCES,
  SearchContextInput,
  SetDependenciesInput,
  UpdateEpicInput,
  UpdateTaskInput,
  UpsertPersonaInput,
} from "@catenext/shared";
import type { z } from "zod";
import { ConfigError, configuredPlatforms, findProjectRoot, readConfig } from "./config.js";
import { LocalService } from "./local-service.js";
import { applyFileEdits, summarize } from "./maintenance.js";
import { describeRedactions, scrubDeep } from "./scrubber.js";
import { planSubagents } from "./subagents.js";

export class PlanningInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningInputError";
  }
}

export async function requireRoot(managedWorktree = false): Promise<string> {
  const root = await findProjectRoot(undefined, { managedWorktree });
  if (!root) {
    throw new ConfigError(
      "Tidak ada .catenext/config.yaml di folder ini atau induknya. Jalankan `catenext init` dulu.",
    );
  }
  return root;
}

export async function cliService(root?: string): Promise<LocalService> {
  const repoRoot = root ?? (await requireRoot(true));
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

export function epicTemplates(asJson: boolean) {
  if (asJson) return console.log(JSON.stringify({ templates: EPIC_TEMPLATES }, null, 2));
  for (const t of EPIC_TEMPLATES) {
    console.log(`${t.id.padEnd(14)} ${t.name} — ${t.summary} (${t.tasks.length} task)`);
  }
}

export async function epicCreate(
  service: LocalService,
  title: string | undefined,
  opts: { description?: string; template?: string; json?: boolean },
) {
  const asJson = Boolean(opts.json);
  if (opts.template) {
    const tpl = findEpicTemplate(opts.template);
    if (!tpl) {
      throw new PlanningInputError(
        `Template epic tidak ditemukan: ${opts.template}. Jalankan \`catenext epic templates\` untuk daftar template.`,
      );
    }
    const epicBody = prepare(
      CreateEpicToolInput,
      {
        title: title ?? tpl.epic.title,
        description: opts.description ?? tpl.epic.description,
      },
      [],
    );
    const epicRes = await service.callTool("create_epic", epicBody);
    const tasksBody = prepare(
      CreateTasksInput,
      {
        epic_id: epicRes.epic.id,
        tasks: tpl.tasks.map((t) => ({
          ref: t.ref,
          title: t.title,
          prompt_instruction: t.prompt_instruction,
          depends_on: t.depends_on,
          ...(t.role ? { role: t.role } : {}),
        })),
      },
      ["epic_id", "ref", "depends_on", "target_repo", "role", "persona"],
    );
    const tasksRes = await service.callTool("create_tasks", tasksBody);
    if (asJson) {
      return console.log(
        JSON.stringify({ epic: epicRes.epic, created: tasksRes.created }, null, 2),
      );
    }
    console.log(
      `✓ Epic "${epicRes.epic.title}" dibuat dari template "${tpl.id}": ${epicRes.epic.id}`,
    );
    for (const t of tasksRes.created) {
      console.log(`+ ${t.ref.padEnd(16)} ${t.task_id}  ${t.status}`);
    }
    console.log(
      `\n✓ ${tasksRes.created.length} task diajukan sebagai DRAFT. Tinjau lalu setujui dengan catenext task approve <id> sebelum agen bisa mengambilnya.`,
    );
    return;
  }

  if (!title) {
    throw new PlanningInputError("Judul epic wajib diisi jika tidak memakai --template.");
  }
  const body = prepare(CreateEpicToolInput, { title, description: opts.description }, []);
  const res = await service.callTool("create_epic", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  console.log(`✓ Epic "${res.epic.title}" dibuat: ${res.epic.id}`);
  console.log(`  Lanjut: catenext task create --epic ${res.epic.id} --file rencana.json`);
}

export async function epicUpdate(
  service: LocalService,
  epicId: string,
  opts: { title?: string; description?: string; json?: boolean },
) {
  if (opts.title === undefined && opts.description === undefined) {
    throw new PlanningInputError("Berikan minimal --title atau --description.");
  }
  const body = prepare(
    UpdateEpicInput,
    {
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    },
    [],
  );
  const updated = await service.updateEpic(epicId, body);
  if (opts.json) return console.log(JSON.stringify({ epic: updated }, null, 2));
  console.log(`✓ Epic "${updated.title}" diperbarui: ${updated.id}`);
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

export interface TaskCreateOpts {
  epic: string;
  file?: string;
  title?: string;
  prompt?: string;
  ref?: string;
  persona?: string;
  role?: string;
  repo?: string;
  dependsOn?: string[];
  requiresApproval?: boolean;
  json?: boolean;
}

/** File rencana boleh berupa array task, atau objek { tasks: [...] }, atau inline lewat flag CLI. */
export async function taskCreate(service: LocalService, opts: TaskCreateOpts) {
  let tasks: unknown;
  if (opts.file !== undefined) {
    if (
      opts.title !== undefined ||
      opts.prompt !== undefined ||
      opts.ref !== undefined ||
      opts.persona !== undefined ||
      opts.role !== undefined ||
      opts.repo !== undefined ||
      opts.dependsOn?.length ||
      opts.requiresApproval
    ) {
      throw new PlanningInputError(
        "Jangan gabungkan --file dengan flag inline (--title, --prompt, --ref, --persona, --role, --repo, --depends-on, --requires-approval).",
      );
    }
    const plan = await readJsonInput(opts.file);
    tasks = Array.isArray(plan) ? plan : (plan as { tasks?: unknown })?.tasks;
  } else {
    if (!opts.title || !opts.prompt) {
      throw new PlanningInputError(
        "Wajib isi --file <path> atau mode inline (--title dan --prompt).",
      );
    }
    tasks = [
      {
        ref: opts.ref ?? "t1",
        title: opts.title,
        prompt_instruction: opts.prompt,
        ...(opts.repo ? { target_repo: opts.repo } : {}),
        ...(opts.role ? { role: opts.role } : {}),
        ...(opts.persona ? { persona: opts.persona } : {}),
        ...(opts.dependsOn?.length ? { depends_on: opts.dependsOn } : {}),
        ...(opts.requiresApproval ? { requires_approval: true } : {}),
      },
    ];
  }
  const body = prepare(CreateTasksInput, { epic_id: opts.epic, tasks }, [
    "epic_id",
    "ref",
    "depends_on",
    "target_repo",
    "role",
    "persona",
  ]);
  const res = await service.callTool("create_tasks", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  for (const t of res.created) console.log(`+ ${t.ref.padEnd(16)} ${t.task_id}  ${t.status}`);
  console.log(
    `\n✓ ${res.created.length} task diajukan sebagai DRAFT. Tinjau lalu setujui dengan catenext task approve <id> sebelum agen bisa mengambilnya.`,
  );
}

export async function taskUpdate(
  service: LocalService,
  taskId: string,
  opts: {
    title?: string;
    prompt?: string;
    persona?: string;
    role?: string;
    repo?: string;
    clearStale?: boolean;
    json?: boolean;
  },
) {
  if (
    opts.title === undefined &&
    opts.prompt === undefined &&
    opts.persona === undefined &&
    opts.role === undefined &&
    opts.repo === undefined &&
    !opts.clearStale
  ) {
    throw new PlanningInputError(
      "Berikan minimal satu field untuk diperbarui (--title, --prompt, --persona, --role, --repo, atau --clear-stale).",
    );
  }
  const body = prepare(
    UpdateTaskInput,
    {
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.prompt !== undefined ? { prompt_instruction: opts.prompt } : {}),
      ...(opts.persona !== undefined ? { persona: opts.persona } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      ...(opts.repo !== undefined ? { target_repo: opts.repo } : {}),
      ...(opts.clearStale ? { is_stale: false as const } : {}),
    },
    ["persona", "role", "target_repo"],
  );
  const updated = await service.updateTask(taskId, body);
  if (opts.json) return console.log(JSON.stringify({ task: updated }, null, 2));
  console.log(`✓ Task "${updated.title}" diperbarui (${updated.id}).`);
}

export async function taskCancel(service: LocalService, taskId: string, opts: { json?: boolean }) {
  const res = await service.cancelTask(taskId);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(
    `✓ Task "${res.title}" (${res.task_id}) dibatalkan (status sebelumnya: ${res.previous_status}).`,
  );
}

export async function taskDeps(
  service: LocalService,
  taskId: string,
  depIds: string[],
  opts: { json?: boolean },
) {
  const body = prepare(SetDependenciesInput, { depends_on: depIds }, ["depends_on"]);
  const res = await service.setTaskDependencies(taskId, body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  console.log(`✓ Dependensi task ${res.task_id} diperbarui (${res.depends_on.length} dependensi).`);
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

export async function personaRemove(service: LocalService, alias: string, asJson: boolean) {
  const body = prepare(RemovePersonaInput, { alias }, ["alias"]);
  const res = await service.callTool("remove_persona", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  console.log(`✓ Persona "${res.alias}" dihapus dari proyek ini.`);
}

const RESTART_IDE_TIP =
  "Mulai ulang klien MCP/IDE agar stub persona terbaca (sama seperti setelah `catenext sync`).";

/** Regenerate IDE agent stubs after persona set/remove (same path as `catenext sync`). */
export async function regenPersonaSubagents(
  root: string,
  service: LocalService,
  opts: { platforms?: readonly PlatformId[]; force?: boolean; quiet?: boolean } = {},
): Promise<void> {
  const config = await readConfig(root);
  const platforms = opts.platforms?.length ? opts.platforms : configuredPlatforms(config);
  const { personas } = await service.callTool("list_personas", {});
  const sub = await planSubagents(
    root,
    personas,
    platforms,
    {
      stack: config.stack ?? [],
      repoName: config.repo_name,
      layout: config.layout,
    },
    { force: Boolean(opts.force) },
  );
  await applyFileEdits(root, sub.edits);
  if (opts.quiet) return;
  for (const l of summarize(sub.edits)) console.log(l);
  for (const path of sub.skipped) {
    console.log(`! ${path} already exists and is not Catenext-managed; skipped.`);
  }
  if (sub.edits.length === 0 && sub.skipped.length === 0) {
    console.log(
      `✓ Stub agen sudah selaras (${personas.length} persona, ${platforms.join(", ") || "none"}).`,
    );
  } else {
    console.log(
      `✓ Stub agen diperbarui untuk ${personas.length} persona: ${platforms.join(", ") || "none"}.`,
    );
  }
  console.log(RESTART_IDE_TIP);
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

export async function docList(
  service: LocalService,
  opts: { json?: boolean; includeArchived?: boolean },
) {
  const body = prepare(
    GetProjectContextInput,
    opts.includeArchived ? { include_archived: true } : {},
    ["include_archived"],
  );
  const { documents } = await service.callTool("get_project_context", body);
  if (opts.json) return console.log(JSON.stringify({ documents }, null, 2));
  if (documents.length === 0)
    return console.log(
      "Belum ada dokumen proyek. Buat dengan: catenext doc save <slug> --file <path.md>",
    );
  for (const d of documents) {
    const archived = d.archived_at ? "  [arsip]" : "";
    console.log(`${d.slug}  v${d.version}  ${d.kind}  ${d.title}  (${d.size} karakter)${archived}`);
  }
}

export async function docGet(
  service: LocalService,
  slug: string,
  opts: { json?: boolean; outline?: boolean; section?: string },
) {
  if (opts.outline && opts.section !== undefined) {
    throw new PlanningInputError("Jangan gabungkan --outline dengan --section.");
  }
  const body = prepare(
    GetDocumentInput,
    {
      slug,
      ...(opts.outline ? { outline_only: true } : {}),
      ...(opts.section !== undefined ? { section: opts.section } : {}),
    },
    ["slug", "outline_only", "section"],
  );
  const res = await service.callTool("get_document", body);
  if (opts.json) return console.log(JSON.stringify(res, null, 2));
  if (opts.outline) {
    console.log(`<!-- ${res.slug} v${res.version} (${res.kind}) · outline -->`);
    for (const h of res.outline ?? []) {
      const indent = "  ".repeat(Math.max(0, h.level - 1));
      console.log(`${indent}${"#".repeat(h.level)} ${h.title}  (baris ${h.line})`);
    }
    return;
  }
  if (opts.section !== undefined) {
    console.log(
      `<!-- ${res.slug} v${res.version} (${res.kind}) · bagian: ${res.section ?? opts.section} -->`,
    );
    console.log(res.content);
    return;
  }
  console.log(`<!-- ${res.slug} v${res.version} (${res.kind}) -->`);
  console.log(res.content);
}

export async function docArchive(service: LocalService, slug: string, asJson: boolean) {
  const body = prepare(ArchiveDocumentInput, { slug }, ["slug"]);
  const res = await service.callTool("archive_document", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  console.log(`✓ Dokumen "${res.document.slug}" diarsipkan (v${res.document.version}).`);
}

export async function docRestore(service: LocalService, slug: string, asJson: boolean) {
  const body = prepare(RestoreDocumentInput, { slug }, ["slug"]);
  const res = await service.callTool("restore_document", body);
  if (asJson) return console.log(JSON.stringify(res, null, 2));
  console.log(`✓ Dokumen "${res.document.slug}" dipulihkan (v${res.document.version}).`);
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
  const wanted = [...new Set(opts.source?.length ? opts.source : SEARCH_SOURCES)];
  for (const source of wanted) {
    if (!CONTEXT_SOURCES.has(source)) {
      throw new PlanningInputError(`Sumber pencarian tidak valid: ${source}.`);
    }
  }
  const body = prepare(SearchContextInput, { query, sources: wanted, limit: opts.limit }, [
    "sources",
    "limit",
  ]);
  const root = await requireRoot();
  const context = await (await cliService(root)).callTool("search_context", body);
  const hits = context.hits.map((hit) => ({ ...hit, origin: "local" as const }));
  const payload = {
    hits,
    reranked: context.reranked,
    degraded: context.degraded,
  };
  if (opts.json) return console.log(JSON.stringify(payload, null, 2));
  if (hits.length === 0) return console.log("Tidak ada hasil.");
  for (const h of hits) {
    console.log(
      `${h.score.toFixed(3)}  [${h.source}]  ${h.ref}  ${h.title}\n    ${h.snippet.slice(0, 120)}`,
    );
  }
}
