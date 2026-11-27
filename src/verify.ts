import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CatenextConfig, type PlatformId, TASK_EVENT_ACTOR } from "@catenext/shared";
import {
  ENTRY_MARKER,
  MASTER_MARKER,
  MASTER_PROMPT_FILE,
  PLATFORM_ENTRY_FILES,
} from "./agents/entry-pointers.js";
import type { HUMAN_APPROVAL_COMMANDS } from "./approval-policy.js";
import { configuredPlatforms, isMissingFile, stateFilePath } from "./config.js";
import { openDatabaseAt } from "./db/open.js";
import { AGENTS_MD, BLOCK_START } from "./init/agents-md.js";
import {
  entryMatchesRoot,
  inspectMcp,
  McpConfigError,
  selectedAdapters,
  WINDSURF_UNSUPPORTED,
} from "./init/mcp-config.js";
import { readRepoFile } from "./init/repo-files.js";
import { PERMISSION_ACTIONS } from "./local-state.js";
import { entryIsStale } from "./maintenance.js";
import { listSkills, SKILLS_DIR } from "./skills.js";
import {
  ORCHESTRATOR_MARKER,
  SUBAGENT_DIRS,
  SUBAGENT_MARKER,
  subagentExtension,
} from "./subagents.js";

export interface CheckLine {
  ok: boolean;
  label: string;
  hint?: string;
  /** Stable id for doctor JSON reports. */
  id?: string;
  /** Drives numbered `next-fix` suggestions in doctor / verify output. */
  fixKey?: "init" | "sync" | "sync-force" | "sync-fix" | "skills" | "verify";
}

export const NEXT_FIX_TIPS: Record<NonNullable<CheckLine["fixKey"]>, string> = {
  init: "Run `catenext init` (or `catenext init --platform <id>`) if this repo is not set up yet.",
  sync: "Run `catenext sync` to align MCP entries, `.gitignore`, and the AGENTS.md Catenext block.",
  "sync-force":
    "Run `catenext sync --force` to refresh CATENEXT.md, platform entry pointers, AGENTS.md block, and agent stubs.",
  "sync-fix": "Run `catenext sync --fix` for duplicate, stale, or repo-mismatched MCP entries.",
  skills:
    "Fix invalid files under `.catenext/skills/` (frontmatter, name=file, content rules); inspect with `catenext skill list`.",
  verify: "Run `catenext verify` after syncing, then restart your IDE.",
};

/** Ordered, de-duplicated numbered tips for artifact/MCP/skill hygiene failures. */
export function formatNextFixTips(lines: CheckLine[]): string {
  const order: NonNullable<CheckLine["fixKey"]>[] = [
    "init",
    "sync-fix",
    "sync",
    "sync-force",
    "skills",
    "verify",
  ];
  const wanted = new Set(
    lines
      .filter((line) => !line.ok && line.fixKey)
      .map((line) => line.fixKey as NonNullable<CheckLine["fixKey"]>),
  );
  if (wanted.size > 0 && lines.some((line) => !line.ok)) wanted.add("verify");
  if (wanted.size === 0) return "";
  const tips = order
    .filter((key) => wanted.has(key))
    .map((key, index) => `${index + 1}. ${NEXT_FIX_TIPS[key]}`);
  return ["Next steps:", ...tips].join("\n");
}

async function sqliteHeaderValid(state: string): Promise<boolean> {
  try {
    const handle = await open(state, "r");
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, 0);
      return bytesRead === 16 && header.toString("ascii", 0, 16) === SQLITE_MAGIC;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

const MAX_PERSONA_SNAPSHOT_BYTES = 64 * 1024 * 1024;

function supportsDeserialize(db: DatabaseSync): db is DatabaseSync & {
  deserialize(snapshot: Uint8Array): void;
} {
  return "deserialize" in db && typeof db.deserialize === "function";
}

function aliasesFromDb(db: DatabaseSync, projectId: string): string[] {
  const hasPersonas = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'personas'")
    .get();
  if (!hasPersonas) return [];
  return (
    db.prepare("SELECT alias FROM personas WHERE project_id = ? ORDER BY alias").all(projectId) as {
      alias: string;
    }[]
  ).map(({ alias }) => alias);
}

function listPersonaAliases(state: string, projectId: string): string[] {
  try {
    const db = openDatabaseAt(state, { readOnly: true });
    try {
      return aliasesFromDb(db, projectId);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Read persona aliases from a journal-free file via in-memory deserialize.
 * Never opens the live SQLite path (avoids creating -shm during doctor).
 */
async function listPersonaAliasesSnapshot(state: string, projectId: string): Promise<string[]> {
  try {
    const handle = await open(state, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_PERSONA_SNAPSHOT_BYTES) {
        return [];
      }
      const snapshot = Buffer.alloc(Number(before.size));
      for (let offset = 0; offset < snapshot.length; ) {
        const { bytesRead } = await handle.read(snapshot, offset, snapshot.length - offset, offset);
        if (!bytesRead) return [];
        offset += bytesRead;
      }
      const db = new DatabaseSync(":memory:");
      try {
        if (!supportsDeserialize(db)) return [];
        if (snapshot[18] === 2 && snapshot[19] === 2) {
          snapshot[18] = 1;
          snapshot[19] = 1;
        }
        db.deserialize(snapshot);
        return aliasesFromDb(db, projectId);
      } finally {
        db.close();
      }
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

async function stubPath(_root: string, platform: PlatformId, name: string): Promise<string | null> {
  const dir = SUBAGENT_DIRS[platform];
  if (!dir) return null;
  return join(dir, `${name}.${subagentExtension(platform)}`);
}

/** Read-only inventory of `.catenext/skills` with numbered next-fix tips for invalid files. */
export async function inspectLocalSkills(root: string): Promise<CheckLine[]> {
  const { skills, invalid } = await listSkills(root);
  if (invalid.length === 0) {
    return [{ id: "skills.valid", ok: true, label: `Skill lokal valid: ${skills.length}` }];
  }
  return invalid.map(({ file, error }) => {
    const path = file === SKILLS_DIR ? file : join(SKILLS_DIR, file);
    const slug = file === SKILLS_DIR ? "dir" : file.replace(/\.md$/i, "");
    return {
      id: `skills.invalid.${slug}`,
      ok: false,
      label: `Skill lokal: ${path}`,
      hint: error,
      fixKey: "skills" as const,
    };
  });
}

/** Read-only onboarding artifact inventory (CATENEXT.md, entry pointers, AGENTS block, stubs). */
export async function inspectOnboardingArtifacts(
  root: string,
  config: CatenextConfig,
  platforms: readonly PlatformId[],
  opts: { personaStubs?: boolean | "snapshot" } = {},
): Promise<CheckLine[]> {
  const checkPersonaStubs = opts.personaStubs !== false;
  const personaViaSnapshot = opts.personaStubs === "snapshot";
  const lines: CheckLine[] = [];
  const syncForce = {
    fixKey: "sync-force" as const,
    hint: "Jalankan `catenext sync --force` untuk menulis ulang file yang dikelola Catenext.",
  };

  const master = await readRepoFile(root, MASTER_PROMPT_FILE);
  if (master === null) {
    lines.push({
      id: "artifacts.master",
      ok: false,
      label: `Master prompt: ${MASTER_PROMPT_FILE}`,
      hint: "File belum ada. Jalankan `catenext init` atau `catenext sync --force`.",
      fixKey: "init",
    });
  } else if (!master.includes(MASTER_MARKER)) {
    lines.push({
      id: "artifacts.master",
      ok: false,
      label: `Master prompt: ${MASTER_PROMPT_FILE}`,
      ...syncForce,
      hint: "File ada tetapi bukan stub Catenext. Jalankan `catenext sync --force` atau gabungkan manual.",
    });
  } else {
    lines.push({ id: "artifacts.master", ok: true, label: `Master prompt: ${MASTER_PROMPT_FILE}` });
  }

  const agents = await readRepoFile(root, AGENTS_MD);
  if (agents === null || !agents.includes(BLOCK_START)) {
    lines.push({
      id: "artifacts.agents",
      ok: false,
      label: `Blok orchestrator: ${AGENTS_MD}`,
      hint:
        agents === null
          ? "AGENTS.md belum ada atau tanpa blok Catenext. Jalankan `catenext init` atau `catenext sync --force`."
          : "AGENTS.md ada tetapi tanpa blok `<!-- catenext:start -->`. Jalankan `catenext sync --force`.",
      fixKey: agents === null ? "init" : "sync-force",
    });
  } else {
    lines.push({ id: "artifacts.agents", ok: true, label: `Blok orchestrator: ${AGENTS_MD}` });
  }

  for (const platform of platforms) {
    const entryPath = PLATFORM_ENTRY_FILES[platform];
    if (!entryPath) continue;
    const entry = await readRepoFile(root, entryPath);
    const label = `Entry pointer (${platform}): ${entryPath}`;
    if (entry === null) {
      lines.push({
        id: `artifacts.entry.${platform}`,
        ok: false,
        label,
        ...syncForce,
        hint: "Pointer platform belum ada. Jalankan `catenext sync --force`.",
      });
    } else if (!entry.includes(ENTRY_MARKER)) {
      lines.push({
        id: `artifacts.entry.${platform}`,
        ok: false,
        label,
        ...syncForce,
        hint: "File ada tetapi bukan pointer Catenext. Jalankan `catenext sync --force` atau edit manual.",
      });
    } else {
      lines.push({ id: `artifacts.entry.${platform}`, ok: true, label });
    }
  }

  for (const platform of platforms) {
    const dir = SUBAGENT_DIRS[platform];
    if (!dir) continue;
    const orchPath = await stubPath(root, platform, "orchestrator");
    if (!orchPath) continue;
    const orch = await readRepoFile(root, orchPath);
    const label = `Stub orchestrator (${platform}): ${orchPath}`;
    if (orch === null || !orch.includes(ORCHESTRATOR_MARKER)) {
      lines.push({
        id: `artifacts.stub.orchestrator.${platform}`,
        ok: false,
        label,
        ...syncForce,
        hint: "Stub orchestrator belum ada atau tidak dikelola Catenext. Jalankan `catenext sync --force`.",
      });
    } else {
      lines.push({ id: `artifacts.stub.orchestrator.${platform}`, ok: true, label });
    }
  }

  let aliases: string[] = [];
  if (checkPersonaStubs) {
    const state = stateFilePath(root, config);
    try {
      const stat = await lstat(state);
      const sidecars = await Promise.all(
        ["-wal", "-shm", "-journal", ".lock"].map(async (suffix) => {
          try {
            await lstat(state + suffix);
            return true;
          } catch (error) {
            return isMissingFile(error) ? false : Promise.reject(error);
          }
        }),
      );
      const journalFree = stat.isFile() && stat.nlink === 1 && !sidecars.some(Boolean);
      if (journalFree && (await sqliteHeaderValid(state))) {
        aliases = personaViaSnapshot
          ? await listPersonaAliasesSnapshot(state, config.project_id)
          : listPersonaAliases(state, config.project_id);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  for (const alias of aliases) {
    for (const platform of platforms) {
      const path = await stubPath(root, platform, alias);
      if (!path) continue;
      const body = await readRepoFile(root, path);
      const label = `Stub persona ${alias} (${platform}): ${path}`;
      if (body === null || !body.includes(SUBAGENT_MARKER)) {
        lines.push({
          id: `artifacts.stub.persona.${alias}.${platform}`,
          ok: false,
          label,
          ...syncForce,
          hint: "Stub persona belum ada atau bukan file Catenext. Jalankan `catenext sync --force`.",
        });
      } else {
        lines.push({ id: `artifacts.stub.persona.${alias}.${platform}`, ok: true, label });
      }
    }
  }

  return lines;
}

const SQLITE_MAGIC = "SQLite format 3\0";

const APPROVAL_EVENTS = [
  "approve_plan",
  "approve",
] as const satisfies readonly (keyof typeof HUMAN_APPROVAL_COMMANDS)[];

function verifyApprovalState(state: string, projectId: string): CheckLine[] {
  const label = "Matriks izin dan aktor persetujuan";
  try {
    // No migrations or repairs during verify. Only look at this project in shared state.
    const db = openDatabaseAt(state, { readOnly: true });
    try {
      const placeholders = PERMISSION_ACTIONS.map(() => "?").join(", ");
      const invalidPermission = db
        .prepare(
          `SELECT 1 FROM permissions WHERE project_id = ? AND
          (action NOT IN (${placeholders}) OR trim(principal) = '' OR
           (action = 'approve_plan' AND principal <> 'human')) LIMIT 1`,
        )
        .get(projectId, ...PERMISSION_ACTIONS);
      const hasEvents = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_events'")
        .get();
      const invalidActor =
        hasEvents &&
        db
          .prepare(
            "SELECT 1 FROM task_events WHERE project_id = ? AND event IN (?, ?) AND actor <> 'human' LIMIT 1",
          )
          .get(projectId, ...APPROVAL_EVENTS);
      const lines: CheckLine[] = [];
      if (invalidPermission) {
        lines.push({
          ok: false,
          label,
          hint: "Aturan izin tidak valid. Periksa `catenext permission list`; approve_plan hanya menerima principal human.",
        });
      }
      if (invalidActor) {
        lines.push({
          ok: false,
          label,
          hint: "Audit berisi persetujuan dengan aktor selain human. Periksa event approve_plan dan approve.",
        });
      }
      return lines.length ? lines : [{ ok: true, label }];
    } finally {
      db.close();
    }
  } catch {
    return [
      {
        ok: false,
        label,
        hint: "Tidak dapat membaca matriks izin dan audit SQLite tanpa mengubah state.",
      },
    ];
  }
}

/** Verify local configuration and server launch mapping without starting any process. */
export async function verifySetup(
  root: string,
  config: CatenextConfig,
  selected?: readonly PlatformId[],
): Promise<CheckLine[]> {
  const platforms = selected ?? configuredPlatforms(config);
  const lines: CheckLine[] = [{ ok: true, label: `Config lokal valid: ${config.repo_name}` }];
  const state = stateFilePath(root, config);
  // Persona stub inventory must run before any live SQLite open (approval checks create -wal/-shm).
  const artifactLines = await inspectOnboardingArtifacts(root, config, platforms);
  try {
    const stat = await lstat(state);
    const regular = stat.isFile() && stat.nlink === 1;
    const modeOk = process.platform === "win32" || (stat.mode & 0o777) === 0o600;
    const hint = !regular
      ? "State harus file biasa, bukan symlink atau hardlink."
      : !modeOk
        ? `Izin file state harus 0600 (chmod 600 ${state}).`
        : undefined;
    lines.push({
      ok: hint === undefined,
      label: `File state lokal: ${state}`,
      hint,
    });
    if (regular && modeOk) lines.push(...verifyApprovalState(state, config.project_id));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    lines.push({ ok: true, label: `State belum dibuat: ${state}` });
  }
  const humanActors = APPROVAL_EVENTS.every((event) => TASK_EVENT_ACTOR[event] === "human");
  lines.push({
    ok: humanActors,
    label: "Batas aktor persetujuan: CLI manusia",
    hint: humanActors ? undefined : "approve_plan dan approve harus memakai aktor human.",
  });
  lines.push(...(await inspectLocalSkills(root)));
  if (platforms.includes("windsurf"))
    lines.push({ ok: false, label: "Windsurf", hint: WINDSURF_UNSUPPORTED });
  for (const adapter of await selectedAdapters(root, platforms)) {
    let hint: string | undefined;
    let fixKey: CheckLine["fixKey"];
    try {
      const source = await readRepoFile(root, adapter.path);
      const { count, entry, managed, compatible } = inspectMcp(source, adapter);
      if (!count) {
        hint = "Entri catenext belum ada. Jalankan `catenext init` atau `catenext sync`.";
        fixKey = "init";
      } else if (!managed || !entry)
        hint = "Nama catenext dipakai oleh entri yang tidak dikelola. Periksa secara manual.";
      else if (
        count !== 1 ||
        !compatible ||
        !entryMatchesRoot(entry, root, adapter) ||
        entryIsStale(entry)
      ) {
        hint = "Entri ganda, basi, atau tidak sesuai repo. Jalankan `catenext sync --fix`.";
        fixKey = "sync-fix";
      }
    } catch (error) {
      if (!(error instanceof McpConfigError)) throw error;
      hint = error.message;
    }
    lines.push({
      ok: hint === undefined,
      label: `${adapter.label}: ${adapter.path}`,
      hint,
      fixKey,
    });
  }
  if (!platforms.length) lines.push({ ok: true, label: "Tidak ada platform MCP yang dipilih." });

  lines.push(...artifactLines);

  return lines;
}

export function formatChecks(lines: CheckLine[]): string {
  const body = lines
    .map(
      ({ ok, label, hint }) => `${ok ? "✓" : "✗"} ${label}${hint && !ok ? `\n    → ${hint}` : ""}`,
    )
    .join("\n");
  const nextFix = formatNextFixTips(lines);
  return nextFix ? `${body}\n\n${nextFix}` : body;
}
