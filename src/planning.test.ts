import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatenextConfigSchema, EPIC_TEMPLATES } from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LocalService } from "./local-service.js";
import {
  boardShow,
  docArchive,
  docGet,
  docList,
  docRestore,
  docSave,
  epicCreate,
  epicList,
  epicTemplates,
  epicUpdate,
  PlanningInputError,
  personaList,
  personaRemove,
  personaSet,
  prepare,
  readJsonInput,
  regenPersonaSubagents,
  searchShow,
  taskCancel,
  taskCreate,
  taskDeps,
  taskUpdate,
} from "./planning.js";
import { SUBAGENT_MARKER } from "./subagents.js";

let root: string;
let service: LocalService;

function parseLastLog<T>(logs: string[]): T {
  const last = logs.at(-1);
  if (last === undefined) throw new Error("Expected console.log output");
  return JSON.parse(last) as T;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-planning-"));
  const config = CatenextConfigSchema.parse({
    schema_version: 1,
    project_id: randomUUID(),
    project_name: "PlanningTest",
    repo_name: "be",
    platforms: ["cursor"],
  });
  await mkdir(join(root, ".catenext"), { recursive: true });
  await writeFile(join(root, ".catenext", "config.yaml"), JSON.stringify(config));
  service = new LocalService(root, config);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("readJsonInput & prepare", () => {
  it("reads JSON from file and stdin ('-') and rejects missing/invalid JSON", async () => {
    const filePath = join(root, "input.json");
    await writeFile(filePath, '{"ok":true,"n":1}');
    await expect(readJsonInput(filePath)).resolves.toEqual({ ok: true, n: 1 });

    await expect(readJsonInput(join(root, "missing.json"))).rejects.toThrow(
      /Tidak bisa membaca .*missing\.json/,
    );

    const badPath = join(root, "bad.json");
    await writeFile(badPath, "{not-json");
    await expect(readJsonInput(badPath)).rejects.toThrow(/bukan JSON yang valid/);

    // Simulate stdin ('-')
    const emitter = new EventEmitter() as EventEmitter & { setEncoding: (enc: string) => void };
    emitter.setEncoding = vi.fn();
    vi.spyOn(process, "stdin", "get").mockReturnValue(emitter as unknown as typeof process.stdin);
    const pending = readJsonInput("-");
    emitter.emit("data", '{"tasks":[');
    emitter.emit("data", "]}");
    emitter.emit("end");
    await expect(pending).resolves.toEqual({ tasks: [] });
  });

  it("prepare scrubs secrets and formats validation errors cleanly", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const schema = z.object({
      title: z.string().min(2),
      lease_id: z.string().uuid(),
    });

    const valid = prepare(
      schema,
      {
        title: "Use Bearer ghp_1234567890abcdefghijklmnopqrstuvwxyz token",
        lease_id: randomUUID(),
      },
      ["lease_id"],
    );
    expect(valid.title).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(errSpy).toHaveBeenCalledTimes(1);

    expect(() => prepare(schema, { title: "x", lease_id: "bad" }, [])).toThrowError(
      PlanningInputError,
    );
    try {
      prepare(schema, { title: "x", lease_id: "bad" }, []);
    } catch (err) {
      expect((err as Error).message).toContain("--lease wajib");
      expect((err as Error).message).toContain("title:");
    }
  });
});

describe("planning epic handlers", () => {
  it("epicTemplates lists EPIC_TEMPLATES as JSON and text", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(String(msg)));

    epicTemplates(true);
    const parsed = parseLastLog<{ templates: typeof EPIC_TEMPLATES }>(logs);
    expect(parsed.templates.map((t) => t.id)).toEqual(EPIC_TEMPLATES.map((t) => t.id));

    logs.length = 0;
    epicTemplates(false);
    expect(logs.join("\n")).toContain("fitur-login");
    expect(logs.join("\n")).toContain("crud-api");
  });

  it("epicList handles empty and populated states in text and JSON", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(String(msg)));

    await epicList(service, false);
    expect(logs.at(-1)).toContain("Belum ada epic");

    await epicCreate(service, "Core API", { description: "Init", json: false });
    expect(logs.join("\n")).toContain('✓ Epic "Core API" dibuat');

    logs.length = 0;
    await epicList(service, false);
    expect(logs.at(-1)).toContain("Core API  (belum ada task)");

    logs.length = 0;
    await epicList(service, true);
    const listJson = parseLastLog<{ epics: Array<{ title: string }> }>(logs);
    expect(listJson.epics.map((e) => e.title)).toContain("Core API");
  });

  it("epicCreate --template creates epic + draft tasks and epicUpdate edits it (JSON and text)", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(String(msg)));

    await epicCreate(service, undefined, { template: "fitur-login", json: true });
    const created = parseLastLog<{
      epic: { id: string; title: string };
      created: Array<{ ref: string; task_id: string; status: string }>;
    }>(logs);
    expect(created.epic.title).toBe("Fitur login email + password");
    expect(created.created).toHaveLength(3);
    expect(created.created.every((t) => t.status === "DRAFT")).toBe(true);

    // Custom title/description with --template in text mode
    logs.length = 0;
    await epicCreate(service, "Custom CRUD", {
      template: "crud-api",
      description: "Custom crud desc",
      json: false,
    });
    expect(logs.join("\n")).toContain('Epic "Custom CRUD" dibuat dari template "crud-api"');

    await epicUpdate(service, created.epic.id, {
      title: "Login v2",
      description: "Updated desc",
      json: true,
    });
    const updated = parseLastLog<{ epic: { title: string; description: string } }>(logs);
    expect(updated.epic.title).toBe("Login v2");
    expect(updated.epic.description).toBe("Updated desc");

    logs.length = 0;
    await epicUpdate(service, created.epic.id, { title: "Login v3", json: false });
    expect(logs.at(-1)).toContain('✓ Epic "Login v3" diperbarui');
  });

  it("epicCreate and epicUpdate reject invalid inputs", async () => {
    await expect(epicCreate(service, undefined, { template: "nonexistent" })).rejects.toThrow(
      /Template epic tidak ditemukan/,
    );
    await expect(epicCreate(service, undefined, {})).rejects.toThrow(/Judul epic wajib diisi/);
    await expect(epicUpdate(service, randomUUID(), {})).rejects.toThrow(
      /Berikan minimal --title atau --description/,
    );
  });
});

describe("planning task handlers", () => {
  it("taskCreate supports inline flags, { tasks: [...] } file, array file, taskUpdate, taskDeps, and taskCancel", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(String(msg)));

    await service.callTool("upsert_persona", { alias: "be", role: "backend", repos: ["be"] });
    const { epic } = await service.callTool("create_epic", { title: "API" });

    // Inline create #1 with explicit flags
    await taskCreate(service, {
      epic: epic.id,
      title: "Setup DB",
      prompt: "Create schema",
      ref: "db",
      persona: "be",
      role: "backend",
      repo: "be",
      requiresApproval: true,
      json: true,
    });
    const t1Res = parseLastLog<{ created: Array<{ ref: string; task_id: string }> }>(logs);
    const t1 = t1Res.created[0];
    expect(t1?.ref).toBe("db");
    const t1Id = t1?.task_id ?? "";

    // Inline create #2 with default ref ("t1") and dependsOn, text mode
    logs.length = 0;
    await taskCreate(service, {
      epic: epic.id,
      title: "Add route",
      prompt: "Create /items",
      dependsOn: [t1Id],
      json: false,
    });
    expect(logs.join("\n")).toContain("+ t1");
    expect(logs.join("\n")).toContain("1 task diajukan sebagai DRAFT");
    const boardAfter2 = await service.callTool("get_project_board", { epic_id: epic.id });
    const t2Id = boardAfter2.tasks.find((t) => t.title === "Add route")?.id ?? "";

    // --file with array payload
    const arrayFile = join(root, "plan-array.json");
    await writeFile(
      arrayFile,
      JSON.stringify([{ ref: "tests", title: "Tests", prompt_instruction: "Write tests" }]),
    );
    await taskCreate(service, { epic: epic.id, file: arrayFile, json: true });
    const t3Res = parseLastLog<{ created: Array<{ ref: string; task_id: string }> }>(logs);
    const t3Id = t3Res.created[0]?.task_id ?? "";

    // --file with { tasks: [...] } object payload
    const objFile = join(root, "plan-obj.json");
    await writeFile(
      objFile,
      JSON.stringify({
        tasks: [{ ref: "docs", title: "Docs", prompt_instruction: "Write API docs" }],
      }),
    );
    await taskCreate(service, { epic: epic.id, file: objFile, json: true });
    const t4Res = parseLastLog<{ created: Array<{ ref: string; task_id: string }> }>(logs);
    expect(t4Res.created[0]?.ref).toBe("docs");

    // taskUpdate JSON + clearStale
    const updateSpy = vi.spyOn(service, "updateTask");
    await taskUpdate(service, t2Id, {
      title: "Add CRUD route",
      prompt: "Create /items CRUD",
      persona: "be",
      role: "backend",
      repo: "be",
      clearStale: true,
      json: true,
    });
    expect(updateSpy).toHaveBeenCalledWith(
      t2Id,
      expect.objectContaining({ is_stale: false, role: "backend", target_repo: "be" }),
    );
    const upd = parseLastLog<{ task: { title: string; persona: string; stale?: boolean } }>(logs);
    expect(upd.task.title).toBe("Add CRUD route");
    expect(upd.task.persona).toBe("be");
    expect(upd.task.stale).toBeFalsy();

    // taskUpdate text mode
    logs.length = 0;
    await taskUpdate(service, t2Id, { title: "Add CRUD route v2", json: false });
    expect(logs.at(-1)).toContain('✓ Task "Add CRUD route v2" diperbarui');

    // taskDeps JSON + text + clear deps
    await taskDeps(service, t3Id, [t2Id], { json: true });
    const deps = parseLastLog<{ task_id: string; depends_on: string[] }>(logs);
    expect(deps.depends_on).toEqual([t2Id]);

    logs.length = 0;
    await taskDeps(service, t3Id, [], { json: false });
    expect(logs.at(-1)).toContain(`✓ Dependensi task ${t3Id} diperbarui (0 dependensi).`);

    // taskCancel JSON + text
    await taskCancel(service, t3Id, { json: true });
    const cancelled = parseLastLog<{ task_id: string; cancelled: boolean }>(logs);
    expect(cancelled).toEqual({
      task_id: t3Id,
      title: "Tests",
      previous_status: "DRAFT",
      cancelled: true,
    });

    const t4Id = t4Res.created[0]?.task_id ?? "";
    logs.length = 0;
    await taskCancel(service, t4Id, { json: false });
    expect(logs.at(-1)).toContain('✓ Task "Docs"');
    expect(logs.at(-1)).toContain("dibatalkan (status sebelumnya: DRAFT)");
  });

  it("taskCreate and taskUpdate reject invalid option combinations and missing fields", async () => {
    const epicId = randomUUID();
    const taskId = randomUUID();

    await expect(
      taskCreate(service, { epic: epicId, file: "plan.json", title: "Mix" }),
    ).rejects.toThrow(/Jangan gabungkan --file dengan flag inline/);

    await expect(
      taskCreate(service, { epic: epicId, file: "plan.json", dependsOn: [randomUUID()] }),
    ).rejects.toThrow(/Jangan gabungkan --file dengan flag inline/);

    await expect(taskCreate(service, { epic: epicId, title: "Only title" })).rejects.toThrow(
      /Wajib isi --file <path> atau mode inline/,
    );

    await expect(taskCreate(service, { epic: epicId })).rejects.toThrow(
      /Wajib isi --file <path> atau mode inline/,
    );

    await expect(taskUpdate(service, taskId, {})).rejects.toThrow(
      /Berikan minimal satu field untuk diperbarui/,
    );

    await expect(taskDeps(service, taskId, ["not-a-uuid"], {})).rejects.toThrowError(
      PlanningInputError,
    );
  });
});

describe("persona, board, doc, and search handlers", () => {
  it("handles personaList, personaSet, boardShow, docList, docGet, docSave, and searchShow errors", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: string) => logs.push(String(msg)));

    await personaList(service, false);
    expect(logs.at(-1)).toContain("Belum ada persona");

    await personaSet(service, "be", "backend", ["Write tests"], false, ["be"]);
    expect(logs.at(-1)).toContain('✓ Persona "be" (backend) dibuat');

    logs.length = 0;
    await regenPersonaSubagents(root, service, { platforms: ["cursor"] });
    const stubPath = join(root, ".cursor", "agents", "be.md");
    expect(existsSync(stubPath)).toBe(true);
    await expect(readFile(stubPath, "utf8")).resolves.toContain(SUBAGENT_MARKER);
    expect(logs.join("\n")).toContain("Mulai ulang klien MCP/IDE");

    logs.length = 0;
    await personaRemove(service, "be", false);
    expect(logs.at(-1)).toContain('✓ Persona "be" dihapus');

    logs.length = 0;
    await regenPersonaSubagents(root, service, { platforms: ["cursor"] });
    expect(existsSync(stubPath)).toBe(false);

    await personaSet(service, "be", "backend", ["Write tests"], false, ["be"]);

    logs.length = 0;
    await personaList(service, false);
    expect(logs.join("\n")).toContain("be (backend, repo be, proyek)");
    expect(logs.join("\n")).toContain("- Write tests");

    const { epic } = await service.callTool("create_epic", { title: "BoardEpic" });
    await taskCreate(service, {
      epic: epic.id,
      title: "BoardTask",
      prompt: "Do work",
      persona: "be",
    });

    logs.length = 0;
    await boardShow(service, { epic: epic.id, status: ["DRAFT"], json: false });
    expect(logs.join("\n")).toContain("# BoardEpic");
    expect(logs.join("\n")).toContain("BoardTask");

    logs.length = 0;
    await docList(service, { json: false });
    expect(logs.at(-1)).toContain("Belum ada dokumen proyek");

    const docFile = join(root, "blueprint.md");
    await writeFile(docFile, "# Blueprint\nDetails\n\n## Scope\n\nNarrow.\n");
    await docSave(service, "blueprint", {
      file: docFile,
      title: "Blueprint",
      kind: "blueprint",
      json: false,
    });
    expect(logs.at(-1)).toContain('✓ Dokumen "blueprint" dibuat (v1)');

    logs.length = 0;
    await docGet(service, "blueprint", { json: false });
    expect(logs.join("\n")).toContain("<!-- blueprint v1 (blueprint) -->");
    expect(logs.join("\n")).toContain("# Blueprint");

    logs.length = 0;
    await docGet(service, "blueprint", { json: false, outline: true });
    expect(logs.join("\n")).toContain("· outline");
    expect(logs.join("\n")).toContain("# Blueprint");
    expect(logs.join("\n")).toContain("## Scope");

    logs.length = 0;
    await docGet(service, "blueprint", { json: false, section: "Scope" });
    expect(logs.join("\n")).toContain("· bagian: Scope");
    expect(logs.join("\n")).toContain("Narrow.");

    await expect(
      docGet(service, "blueprint", { json: false, outline: true, section: "Scope" }),
    ).rejects.toThrow(/Jangan gabungkan --outline dengan --section/);

    await docArchive(service, "blueprint", false);
    expect(logs.at(-1)).toContain('✓ Dokumen "blueprint" diarsipkan');

    logs.length = 0;
    await docList(service, { json: false });
    expect(logs.join("\n")).not.toContain("blueprint");

    await docList(service, { json: false, includeArchived: true });
    expect(logs.join("\n")).toContain("blueprint");
    expect(logs.join("\n")).toContain("[arsip]");

    await docRestore(service, "blueprint", false);
    expect(logs.at(-1)).toContain('✓ Dokumen "blueprint" dipulihkan');

    await expect(searchShow("auth", { source: ["bogus"] })).rejects.toThrow(
      /Sumber pencarian tidak valid: bogus/,
    );
  });
});
