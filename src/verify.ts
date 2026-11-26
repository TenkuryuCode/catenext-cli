import { lstat } from "node:fs/promises";
import { type CatenextConfig, type PlatformId, TASK_EVENT_ACTOR } from "@catenext/shared";
import type { HUMAN_APPROVAL_COMMANDS } from "./approval-policy.js";
import { configuredPlatforms, isMissingFile, stateFilePath } from "./config.js";
import { openDatabaseAt } from "./db/open.js";
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

export interface CheckLine {
  ok: boolean;
  label: string;
  hint?: string;
}

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
  const { skills, invalid } = await listSkills(root);
  if (invalid.length === 0) {
    lines.push({ ok: true, label: `Skill lokal valid: ${skills.length}` });
  } else {
    for (const { file, error } of invalid) {
      const path = file === SKILLS_DIR ? file : `${SKILLS_DIR}/${file}`;
      lines.push({ ok: false, label: `Skill lokal: ${path}`, hint: error });
    }
  }
  if (platforms.includes("windsurf"))
    lines.push({ ok: false, label: "Windsurf", hint: WINDSURF_UNSUPPORTED });
  for (const adapter of await selectedAdapters(root, platforms)) {
    let hint: string | undefined;
    try {
      const source = await readRepoFile(root, adapter.path);
      const { count, entry, managed, compatible } = inspectMcp(source, adapter);
      if (!count) hint = "Entri catenext belum ada. Jalankan `catenext init` atau `catenext sync`.";
      else if (!managed || !entry)
        hint = "Nama catenext dipakai oleh entri yang tidak dikelola. Periksa secara manual.";
      else if (
        count !== 1 ||
        !compatible ||
        !entryMatchesRoot(entry, root, adapter) ||
        entryIsStale(entry)
      ) {
        hint = "Entri ganda, basi, atau tidak sesuai repo. Jalankan `catenext sync --fix`.";
      }
    } catch (error) {
      if (!(error instanceof McpConfigError)) throw error;
      hint = error.message;
    }
    lines.push({ ok: hint === undefined, label: `${adapter.label}: ${adapter.path}`, hint });
  }
  if (!platforms.length) lines.push({ ok: true, label: "Tidak ada platform MCP yang dipilih." });
  return lines;
}

export function formatChecks(lines: CheckLine[]): string {
  return lines
    .map(
      ({ ok, label, hint }) => `${ok ? "✓" : "✗"} ${label}${hint && !ok ? `\n    → ${hint}` : ""}`,
    )
    .join("\n");
}
