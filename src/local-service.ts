import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, statSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  briefText,
  type CatenextConfig,
  DOCUMENT_LIMITS,
  findCycle,
  GENERAL_RULES,
  IdSchema,
  isMcpCrudTool,
  MCP_TOOLS,
  type McpCrudToolName,
  type McpToolName,
  type McpToolOutput,
  type Persona,
  type ProjectDocument,
  type SearchHit,
  SetDependenciesInput,
  type TaskSummary,
  UpdateEpicInput,
  UpdateTaskInput,
} from "@catenext/shared";
import type { z } from "zod";
import {
  type ApprovalAction,
  ApprovalSnapshotSchema,
  HUMAN_APPROVAL_COMMANDS,
  requireHumanApproval,
} from "./approval-policy.js";
import { keywordFallback, searchLocalCode } from "./code-search.js";
import { checkGraphFreshness, queryGraphNeighbors, symbolSearch } from "./db/graph-index.js";
import {
  analyzeGraphImpact,
  type GraphRootDir,
  summarizeProjectGraph,
} from "./db/graph-summary.js";
import { loadProject } from "./db/project-codec.js";
import { LocalStore, newRootId } from "./db/store.js";
import {
  insertTaskEvents,
  type NewTaskEvent,
  type ReadTaskEventsOptions,
  type TaskEventRecord,
} from "./db/task-events.js";
import {
  acceptedReview,
  assertIntegration,
  assertRunHealthy,
  type EpicRun,
  epicRunAction,
  integrationBranch,
  previewRun,
  readRun,
  runBranch,
  runIssue,
  runPrefix,
  runTaskChanges,
  saveRun,
} from "./epic-run.js";
import { assertDescends, assertRunCheckout, fullSha, localCommit } from "./epic-run-git.js";
import { LocalServiceError } from "./errors.js";
import { buildInterviewSetup } from "./interview.js";
import {
  type ClaimContextSnapshot,
  enrichClaimContext,
  snapshotClaimContext,
} from "./local-claim-context.js";
import { claimResponse, dependencyHandoffs } from "./local-claim-response.js";
import {
  extractMarkdownOutline,
  extractMarkdownSection,
  filterVisibleDocuments,
  isDocumentArchived,
  recordIndex,
} from "./local-documents-markdown.js";
import {
  advance,
  claimable,
  endLease,
  leaseEnd,
  leaseKey,
  leaseMatches,
  returnClaim,
} from "./local-lease.js";
import {
  archiveEpicInProject,
  type EpicArchiveResult,
  type EpicRestoreResult,
  filterVisibleEpics,
  filterVisibleTasks,
  isEpicSummaryStale,
  resolveEpicSummaryText,
  restoreEpicInProject,
  UpsertEpicSummaryInput,
  upsertVersionedEpicSummary,
} from "./local-retention.js";
import { offlineReview, reviewPullRequest, reviseTask } from "./local-review-workflow.js";
import { type LocalSearchItem, searchLocalContext } from "./local-search.js";
import {
  allowsRepo,
  type LocalPermission,
  type LocalProject,
  type LocalTask,
  PERMISSION_ACTIONS,
  type PermissionAction,
  type VersionedEpicSummary,
} from "./local-state.js";
import { DEFAULT_SCRUB_SKIP_KEYS, scrubDeep, scrubText } from "./scrubber.js";
import { applyProjectSeed } from "./seed.js";
import { discoverSkillCatalog, loadCatalogSkill, toSkillIndexEntries } from "./skill-catalog.js";
import { saveSkill } from "./skills.js";
import {
  type ActiveWorktreeLease,
  readWorktreeOverlapHint,
  snapshotWorktreeLeases,
} from "./worktree-status.js";

export type { ReadTaskEventsOptions, TaskEventRecord } from "./db/task-events.js";
export { LocalServiceError } from "./errors.js";

type Parsed<N extends McpToolName> = z.output<(typeof MCP_TOOLS)[N]["input"]>;
type Handlers = {
  [N in Exclude<McpToolName, McpCrudToolName | "claim_task" | "session_brief">]: (
    input: Parsed<N>,
  ) => McpToolOutput<N> | Promise<McpToolOutput<N>>;
};

interface SessionBriefHintSnapshot {
  graphRoots: GraphRootDir[];
  worktreeLeases?: ActiveWorktreeLease[];
}
const directives = [
  ...GENERAL_RULES,
  "Jangan edit file state Catenext langsung; gunakan tool MCP atau CLI.",
  "Satu task per sesi. Claim dengan worktree terpisah bila monorepo atau bila beberapa subagent berjalan paralel.",
  "Commit hanya di worktree/branch kerja; jangan merge default/main sebagai subagent. Serahkan via complete_handoff; orchestrator + manusia pilih PR atau merge.",
  "Selesaikan task lewat persetujuan lokal yang eksplisit. Catenext tidak memverifikasi merge PR.",
];

function fail(code: string, message: string, details?: unknown): never {
  throw new LocalServiceError(code, message, details);
}

/** UUIDv5 with the project UUID as namespace. Alias remains the persisted identity. */
function projectPersonaId(projectId: string, alias: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(projectId.replaceAll("-", ""), "hex"))
    .update(`catenext:persona:${alias}`)
    .digest();
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameStringList(a?: readonly string[], b?: readonly string[]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((item, idx) => item === b[idx]);
}

/** Shared local orchestration boundary for standalone CLI and MCP processes. */
export class LocalService {
  readonly stateFile: string;
  private readonly store: LocalStore;

  /**
   * `human` = CLI lokal (default). `agent` = stdio MCP. Aksi persetujuan manusia (approve,
   * approve_plan) hanya boleh dari `human`; ini ditentukan oleh jalur pemanggil, bukan input.
   */
  constructor(
    private readonly repoRoot: string,
    private readonly config: CatenextConfig,
    private readonly caller: "human" | "agent" = "human",
    private readonly capabilities: { readonly allowCrud?: boolean } = {},
  ) {
    this.stateFile = resolve(repoRoot, config.state_file ?? ".catenext/catenext.sqlite");
    this.store = new LocalStore(this.stateFile);
  }

  /** Local trusted-host boundary. Deliberately not registered as an MCP tool. */
  async epicRun(epic: string, raw: z.input<typeof epicRunAction>) {
    if (this.caller !== "human")
      fail("human_approval_required", "Epic runs require a trusted local host.");
    const parsed = epicRunAction.safeParse(raw);
    if (!IdSchema.safeParse(epic).success || !parsed.success)
      fail("invalid_input", "Invalid epic run input.");
    const options = parsed.data;
    if (
      (options.action === "preview" || options.action === "start") &&
      scrubText(options.check) !== options.check
    ) {
      fail("invalid_input", "Verification command must not contain credentials.");
    }
    if (options.action === "review") options.feedback = scrubText(options.feedback);
    if (options.action === "pause") options.reason = scrubText(options.reason);
    const projectId = this.config.project_id;
    if (options.action === "preview") {
      return this.store.read(projectId, (project, db) =>
        previewRun(this.repoRoot, this.config, project, db, epic, options),
      );
    }
    return this.store.transaction(
      projectId,
      this.config.repo_name,
      (project, dirty, db, afterSave) => {
        const tools = new LocalWorkflow(
          project,
          this.config,
          this.repoRoot,
          db,
          Date.now(),
          dirty,
          this.caller,
        );
        let run = readRun(db, projectId, epic);
        if (run && run.plan.repo !== this.config.repo_name)
          fail("wrong_repo", "Run belongs to another repo.");
        const persist = (state: EpicRun) => {
          const events = tools.drainEvents();
          afterSave((tx) => {
            saveRun(tx, projectId, state);
            insertTaskEvents(tx, projectId, events);
          });
        };
        if (options.action === "start") {
          if (run) {
            if (
              run.snapshot === options.snapshot &&
              run.plan.base === options.base &&
              run.plan.check === options.check &&
              run.status !== "CLOSED"
            )
              return tools.runView(run);
            fail(
              "run_state",
              "Epic already has a local run. Start a new epic for a new authorization.",
            );
          }
          if (
            db
              .prepare("SELECT 1 FROM epic_runs WHERE project_id = ? AND repo = ? AND closed = 0")
              .get(projectId, this.config.repo_name)
          ) {
            fail("run_state", "Close the existing local run before starting another in this repo.");
          }
          const preview = previewRun(this.repoRoot, this.config, project, db, epic, options);
          if (options.snapshot !== preview.snapshot)
            fail("stale_approval", "Plan changed since preview. Request fresh confirmation.");
          run = tools.startRun(preview.plan, preview.snapshot);
          persist(run);
          return tools.runView(run);
        }
        if (!run) fail("not_found", "No local run for this epic.");
        const before = JSON.stringify(run);
        tools.advanceRun(run, options);
        if (before !== JSON.stringify(run)) persist(run);
        return tools.runView(run);
      },
    );
  }

  /** Seed default personas/docs/permissions once (idempotent). */
  async ensureSeed(
    options: {
      platforms?: string[];
      locale?: string;
      personaSeed?: "matched" | "all" | "minimal" | "none" | "default";
      stack?: string[];
    } = {},
  ): Promise<void> {
    if (this.caller === "agent") {
      fail("permission_denied", "Inisialisasi proyek hanya lewat CLI manusia.");
    }
    await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty) => {
        const beforePersonas = project.personas.length;
        const beforeDocs = project.documents.length;
        const beforePerms = project.permissions.length;
        applyProjectSeed(project, {
          ...options,
          stack: options.stack ?? this.config.stack ?? [],
        });
        if (
          project.personas.length !== beforePersonas ||
          project.documents.length !== beforeDocs ||
          project.permissions.length !== beforePerms ||
          options.platforms?.length ||
          options.locale
        ) {
          dirty();
        }
      },
    );
    if (process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    const { ensureDefaultSkills } = await import("./seed-skills.js");
    await ensureDefaultSkills(this.repoRoot);
  }

  /** Read task audit log entries via read-only SQLite query. */
  async readTaskEvents(options: ReadTaskEventsOptions = {}): Promise<TaskEventRecord[]> {
    return this.store.readTaskEvents(this.config.project_id, options);
  }

  async listPermissions(): Promise<LocalPermission[]> {
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project) =>
        [...(project.permissions ?? [])].sort(
          (a, b) => a.action.localeCompare(b.action) || a.principal.localeCompare(b.principal),
        ),
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  async setPermissions(action: string, principals: string[]): Promise<LocalPermission[]> {
    if (this.caller === "agent") {
      fail("permission_denied", "Pengaturan permission hanya lewat CLI manusia.");
    }
    if (!PERMISSION_ACTIONS.includes(action as PermissionAction)) {
      fail(
        "invalid_input",
        `Aksi permission tidak valid: ${action}. Pilih: ${PERMISSION_ACTIONS.join(", ")}.`,
      );
    }
    const validAction = action as PermissionAction;
    const normalized = [...new Set(principals.map((p) => p.trim()).filter(Boolean))];
    if (normalized.length === 0) {
      fail("invalid_input", "Minimal satu principal wajib diberikan (mis. human, orchestrator).");
    }
    if (validAction === "approve_plan" && normalized.some((p) => p !== "human")) {
      fail("invalid_input", "Aksi approve_plan hanya boleh untuk principal human.");
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty) => {
        const rest = (project.permissions ?? []).filter((row) => row.action !== validAction);
        const updated = normalized.map((principal) => ({ action: validAction, principal }));
        project.permissions = [...rest, ...updated];
        dirty();
        return [...project.permissions].sort(
          (a, b) => a.action.localeCompare(b.action) || a.principal.localeCompare(b.principal),
        );
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  async grantPermission(action: string, principal: string): Promise<LocalPermission[]> {
    if (this.caller === "agent") {
      fail("permission_denied", "Pengaturan permission hanya lewat CLI manusia.");
    }
    if (!PERMISSION_ACTIONS.includes(action as PermissionAction)) {
      fail(
        "invalid_input",
        `Aksi permission tidak valid: ${action}. Pilih: ${PERMISSION_ACTIONS.join(", ")}.`,
      );
    }
    const validAction = action as PermissionAction;
    const clean = principal.trim();
    if (!clean) fail("invalid_input", "Principal wajib diisi.");
    if (validAction === "approve_plan" && clean !== "human") {
      fail("invalid_input", "Aksi approve_plan hanya boleh untuk principal human.");
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty) => {
        project.permissions ??= [];
        if (
          !project.permissions.some((row) => row.action === validAction && row.principal === clean)
        ) {
          project.permissions.push({ action: validAction, principal: clean });
          dirty();
        }
        return [...project.permissions].sort(
          (a, b) => a.action.localeCompare(b.action) || a.principal.localeCompare(b.principal),
        );
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  async revokePermission(action: string, principal: string): Promise<LocalPermission[]> {
    if (this.caller === "agent") {
      fail("permission_denied", "Pengaturan permission hanya lewat CLI manusia.");
    }
    if (!PERMISSION_ACTIONS.includes(action as PermissionAction)) {
      fail(
        "invalid_input",
        `Aksi permission tidak valid: ${action}. Pilih: ${PERMISSION_ACTIONS.join(", ")}.`,
      );
    }
    const validAction = action as PermissionAction;
    const clean = principal.trim();
    if (!clean) fail("invalid_input", "Principal wajib diisi.");
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty) => {
        const before = project.permissions?.length ?? 0;
        project.permissions = (project.permissions ?? []).filter(
          (row) => !(row.action === validAction && row.principal === clean),
        );
        if (project.permissions.length !== before) dirty();
        return [...project.permissions].sort(
          (a, b) => a.action.localeCompare(b.action) || a.principal.localeCompare(b.principal),
        );
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  /** Agent callers remain agents even when their local server launch grants CRUD. */
  private requireCrudPermission(): void {
    if (this.caller === "agent" && this.capabilities.allowCrud !== true) {
      fail(
        "permission_denied",
        "Perubahan CRUD memerlukan CLI manusia atau peluncuran MCP dengan --allow-crud (bukan worker).",
      );
    }
  }

  async updateEpic(
    epicId: string,
    input: z.input<typeof UpdateEpicInput>,
  ): Promise<{
    id: string;
    title: string;
    description: string | null;
    task_counts: Record<string, number>;
  }> {
    this.requireCrudPermission();
    if (!IdSchema.safeParse(epicId).success) {
      fail("invalid_input", "epic_id harus UUID yang valid.");
    }
    const parsed = UpdateEpicInput.safeParse(scrubDeep(input, DEFAULT_SCRUB_SKIP_KEYS).value);
    if (!parsed.success) {
      const paths = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
      ];
      fail("invalid_input", `Input updateEpic tidak valid: ${paths.join(", ")}.`, {
        fields: paths,
      });
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty) => {
        const epic = project.epics.find((e) => e.id === epicId);
        if (!epic) fail("not_found", "Epic tidak ditemukan di proyek ini.");
        let changed = false;
        if (parsed.data.title !== undefined && parsed.data.title !== epic.title) {
          epic.title = parsed.data.title;
          changed = true;
        }
        if (parsed.data.description !== undefined) {
          const nextDesc = parsed.data.description ?? null;
          if (nextDesc !== epic.description) {
            epic.description = nextDesc;
            changed = true;
          }
        }
        if (changed) dirty();
        const counts = new Map<string, number>();
        for (const t of project.tasks) {
          if (t.epicId === epic.id) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
        }
        return { ...epic, task_counts: Object.fromEntries(counts) };
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  /** Read-only retrieval of an epic's versioned summary (with staleness flag and safe fallback excerpt). */
  async getEpicSummary(epicId: string): Promise<{
    epic_id: string;
    title: string;
    archived_at: string | null;
    stale: boolean;
    summary: VersionedEpicSummary | null;
    excerpt: string;
  }> {
    if (!IdSchema.safeParse(epicId).success) {
      fail("invalid_input", "epic_id harus UUID yang valid.");
    }
    return await this.store.query((db) => {
      const project = loadProject(db, this.config.project_id);
      const epic = project.epics.find((e) => e.id === epicId);
      if (!epic) fail("not_found", "Epic tidak ditemukan di proyek ini.");
      return {
        epic_id: epic.id,
        title: epic.title,
        archived_at: epic.archived_at ?? null,
        stale: isEpicSummaryStale(epic, project.tasks),
        summary: epic.summary ?? null,
        excerpt: resolveEpicSummaryText(epic, project.tasks, 1000),
      };
    });
  }

  /** Build, refresh, or update a versioned epic summary (bounded UTF-8 size, optimistic version check). */
  async saveEpicSummary(
    epicId: string,
    input: Omit<z.input<typeof UpsertEpicSummaryInput>, "epic_id"> = {},
  ): Promise<{
    epic_id: string;
    title: string;
    archived_at: string | null;
    summary: VersionedEpicSummary;
    excerpt: string;
  }> {
    this.requireCrudPermission();
    const skipKeys = new Set([...DEFAULT_SCRUB_SKIP_KEYS, "epic_id", "expected_version"]);
    const parsed = UpsertEpicSummaryInput.safeParse(
      scrubDeep({ ...input, epic_id: epicId }, skipKeys).value,
    );
    if (!parsed.success) {
      const paths = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
      ];
      fail("invalid_input", `Input saveEpicSummary tidak valid: ${paths.join(", ")}.`, {
        fields: paths,
      });
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty) => {
        const epic = project.epics.find((e) => e.id === parsed.data.epic_id);
        if (!epic) fail("not_found", "Epic tidak ditemukan di proyek ini.");
        const summary = upsertVersionedEpicSummary(epic, project.tasks, {
          overview: parsed.data.overview,
          key_decisions: parsed.data.key_decisions,
          outcomes: parsed.data.outcomes,
          unresolved_risks: parsed.data.unresolved_risks,
          expected_version: parsed.data.expected_version,
        });
        dirty();
        return {
          epic_id: epic.id,
          title: epic.title,
          archived_at: epic.archived_at ?? null,
          summary,
          excerpt: resolveEpicSummaryText(epic, project.tasks, 1000),
        };
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  /**
   * Archive a completed/inactive epic (or perform a strictly read-only dry-run estimation).
   */
  async archiveEpic(
    epicId: string,
    options: { dry_run?: boolean } = {},
  ): Promise<EpicArchiveResult> {
    this.requireCrudPermission();
    if (!IdSchema.safeParse(epicId).success) {
      fail("invalid_input", "epic_id harus UUID yang valid.");
    }
    if (options.dry_run) {
      const preview = await this.store.inspect((db) =>
        archiveEpicInProject(
          db,
          this.config.project_id,
          loadProject(db, this.config.project_id),
          epicId,
          { dry_run: true },
        ),
      );
      return (
        preview ?? fail("not_found", "Current project database required for read-only preview.")
      );
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty, db) => {
        const result = archiveEpicInProject(db, this.config.project_id, project, epicId, {
          dry_run: false,
        });
        dirty();
        return result;
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  /** Restore a previously archived epic and its tasks back to active visibility. */
  async restoreEpic(epicId: string): Promise<EpicRestoreResult> {
    this.requireCrudPermission();
    if (!IdSchema.safeParse(epicId).success) {
      fail("invalid_input", "epic_id harus UUID yang valid.");
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty) => {
        const result = restoreEpicInProject(project, epicId);
        dirty();
        return result;
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  async updateTask(taskId: string, input: z.input<typeof UpdateTaskInput>): Promise<LocalTask> {
    this.requireCrudPermission();
    if (!IdSchema.safeParse(taskId).success) {
      fail("invalid_input", "task_id harus UUID yang valid.");
    }
    const skipKeys = new Set([...DEFAULT_SCRUB_SKIP_KEYS, "persona", "role", "target_repo"]);
    const parsed = UpdateTaskInput.safeParse(scrubDeep(input, skipKeys).value);
    if (!parsed.success) {
      const paths = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
      ];
      fail("invalid_input", `Input updateTask tidak valid: ${paths.join(", ")}.`, {
        fields: paths,
      });
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty, _db, afterSave) => {
        const task = project.tasks.find((t) => t.id === taskId);
        if (!task) fail("not_found", "Task tidak ditemukan di proyek ini.");
        const data = parsed.data;
        const changedFields: string[] = [];

        if (data.target_repo !== undefined && data.target_repo !== task.target) {
          if (task.lease && data.target_repo && task.lease.repo !== data.target_repo) {
            fail(
              "task_locked",
              "Tidak bisa mengubah target_repo saat task sedang dipegang repo lain.",
            );
          }
          task.target = data.target_repo;
          changedFields.push("target_repo");
        }

        let personaAlias = data.persona;
        if (data.persona_id !== undefined) {
          const id = data.persona_id;
          const byId =
            id === null
              ? null
              : project.personas.find(
                  (persona) =>
                    projectPersonaId(this.config.project_id, persona.alias) === id.toLowerCase(),
                )?.alias;
          if (byId === undefined)
            fail("persona_not_found", "Persona ID tidak ditemukan di proyek ini.");
          if (personaAlias !== undefined && personaAlias !== byId) {
            fail(
              "invalid_input",
              "persona dan persona_id harus menunjuk persona yang sama atau sama-sama null.",
            );
          }
          personaAlias = byId;
        }
        if (personaAlias !== undefined) {
          if (personaAlias === null) {
            if (task.persona !== null) {
              task.persona = null;
              changedFields.push("persona");
            }
          } else {
            const p = project.personas.find((row) => row.alias === personaAlias);
            if (!p)
              fail("persona_not_found", `Persona "${personaAlias}" tidak ditemukan di proyek ini.`);
            if (task.target && !allowsRepo(p, task.target)) {
              fail(
                "persona_repo_mismatch",
                `Persona "${p.alias}" tidak memegang repo "${task.target}".`,
              );
            }
            if (task.persona !== p.alias) {
              task.persona = p.alias;
              changedFields.push("persona");
            }
            if (data.role === undefined && task.role !== p.role) {
              task.role = p.role;
              changedFields.push("role");
            }
          }
        } else if (task.persona && data.target_repo !== undefined && task.target) {
          const currentPersona = project.personas.find((row) => row.alias === task.persona);
          if (currentPersona && !allowsRepo(currentPersona, task.target)) {
            fail(
              "persona_repo_mismatch",
              `Persona "${currentPersona.alias}" tidak memegang repo "${task.target}".`,
            );
          }
        }

        if (data.role !== undefined && data.role !== task.role) {
          task.role = data.role;
          changedFields.push("role");
        }
        if (data.title !== undefined && data.title !== task.title) {
          task.title = data.title;
          changedFields.push("title");
        }
        if (data.prompt_instruction !== undefined && data.prompt_instruction !== task.instruction) {
          task.instruction = data.prompt_instruction;
          changedFields.push("prompt_instruction");
        }
        if (
          data.requires_approval !== undefined &&
          data.requires_approval !== task.requiresApproval
        ) {
          task.requiresApproval = data.requires_approval;
          changedFields.push("requires_approval");
        }
        if (data.position !== undefined && data.position !== task.position) {
          task.position = data.position;
          changedFields.push("position");
        }
        if (data.is_stale === false && task.stale) {
          task.stale = false;
          changedFields.push("is_stale");
        }
        if (data.scope_files !== undefined && !sameStringList(data.scope_files, task.scope_files)) {
          task.scope_files = data.scope_files;
          changedFields.push("scope_files");
        }
        if (data.verify_command !== undefined && data.verify_command !== task.verify_command) {
          task.verify_command = data.verify_command;
          changedFields.push("verify_command");
        }
        if (data.doc_refs !== undefined && !sameStringList(data.doc_refs, task.doc_refs)) {
          task.doc_refs = data.doc_refs;
          changedFields.push("doc_refs");
        }

        if (changedFields.length > 0) {
          dirty();
          const nowIso = new Date().toISOString();
          afterSave((txDb) => {
            insertTaskEvents(txDb, this.config.project_id, [
              {
                task_id: task.id,
                event: "update",
                actor: this.caller,
                note: changedFields.join(", "),
                detail: { fields: changedFields },
                created_at: nowIso,
              },
            ]);
          });
        }
        return structuredClone(task);
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  async cancelTask(taskId: string): Promise<{
    task_id: string;
    title: string;
    previous_status: LocalTask["status"];
    cancelled: true;
  }> {
    this.requireCrudPermission();
    if (!IdSchema.safeParse(taskId).success) {
      fail("invalid_input", "task_id harus UUID yang valid.");
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty, _db, afterSave) => {
        const idx = project.tasks.findIndex((t) => t.id === taskId);
        const task = project.tasks[idx];
        if (!task) fail("not_found", "Task tidak ditemukan di proyek ini.");
        if (
          task.status === "IN_PROGRESS" &&
          task.lease &&
          Date.parse(task.lease.expiresAt) > Date.now()
        ) {
          fail(
            "task_locked",
            "Task sedang dikerjakan (IN_PROGRESS); lepas lease terlebih dahulu sebelum membatalkan.",
          );
        }
        const dependents = project.tasks.filter(
          (other) => other.id !== taskId && other.dependencies.includes(taskId),
        );
        if (dependents.length > 0) {
          fail(
            "has_dependents",
            `Task masih menjadi dependensi ${dependents.length} task lain; perbarui dependensi terlebih dahulu.`,
            { dependent_task_ids: dependents.map((t) => t.id) },
          );
        }
        const previousStatus = task.status;
        const title = task.title;
        project.tasks.splice(idx, 1);
        dirty();
        const nowIso = new Date().toISOString();
        afterSave((txDb) => {
          insertTaskEvents(txDb, this.config.project_id, [
            {
              task_id: taskId,
              event: "cancel",
              actor: this.caller,
              note: title,
              detail: { from: previousStatus },
              created_at: nowIso,
            },
          ]);
        });
        return {
          task_id: taskId,
          title,
          previous_status: previousStatus,
          cancelled: true as const,
        };
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  async setTaskDependencies(
    taskId: string,
    input: z.input<typeof SetDependenciesInput>,
  ): Promise<{ task_id: string; depends_on: string[] }> {
    this.requireCrudPermission();
    if (!IdSchema.safeParse(taskId).success) {
      fail("invalid_input", "task_id harus UUID yang valid.");
    }
    const skipKeys = new Set([...DEFAULT_SCRUB_SKIP_KEYS, "depends_on"]);
    const parsed = SetDependenciesInput.safeParse(scrubDeep(input, skipKeys).value);
    if (!parsed.success) {
      const paths = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
      ];
      fail("invalid_input", `Input setTaskDependencies tidak valid: ${paths.join(", ")}.`, {
        fields: paths,
      });
    }
    const nextDeps = [...new Set(parsed.data.depends_on)];
    if (nextDeps.includes(taskId)) {
      fail("dependency_cycle", "Task tidak boleh bergantung pada dirinya sendiri.");
    }
    const existed = existsSync(this.stateFile);
    const out = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      (project, dirty, _db, afterSave) => {
        const task = project.tasks.find((t) => t.id === taskId);
        if (!task) fail("not_found", "Task tidak ditemukan di proyek ini.");
        const taskIds = new Set(project.tasks.map((t) => t.id));
        for (const depId of nextDeps) {
          if (!taskIds.has(depId)) {
            fail("dependency_not_found", `Task dependensi ${depId} tidak ditemukan di proyek ini.`);
          }
        }
        const edges = project.tasks.flatMap((t) => {
          const deps = t.id === task.id ? nextDeps : t.dependencies;
          return deps.map((dependsOn) => ({ task: t.id, dependsOn }));
        });
        const cycle = findCycle(edges);
        if (cycle) {
          fail("dependency_cycle", `Dependensi melingkar terdeteksi: ${cycle.join(" -> ")}.`, {
            cycle,
          });
        }
        task.dependencies = nextDeps;
        dirty();
        const nowIso = new Date().toISOString();
        afterSave((txDb) => {
          insertTaskEvents(txDb, this.config.project_id, [
            {
              task_id: task.id,
              event: "set_dependencies",
              actor: this.caller,
              detail: { depends_on: nextDeps },
              created_at: nowIso,
            },
          ]);
        });
        return { task_id: task.id, depends_on: [...task.dependencies] };
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    return out;
  }

  private async callCrudTool(name: McpCrudToolName, input: unknown): Promise<unknown> {
    // Each existing operation owns its transaction and checks the same capability.
    switch (name) {
      case "update_task": {
        const { task_id, ...patch } = MCP_TOOLS.update_task.input.parse(input);
        const task = await this.updateTask(task_id, patch);
        return {
          task_id: task.id,
          title: task.title,
          status: task.status,
          target_repo: task.target,
          role: task.role,
          persona: task.persona,
          persona_id:
            task.persona === null ? null : projectPersonaId(this.config.project_id, task.persona),
          position: task.position,
          requires_approval: task.requiresApproval,
          is_stale: task.stale,
        } satisfies McpToolOutput<"update_task">;
      }
      case "update_epic": {
        const { epic_id, ...patch } = MCP_TOOLS.update_epic.input.parse(input);
        return {
          epic: await this.updateEpic(epic_id, patch),
        } satisfies McpToolOutput<"update_epic">;
      }
      case "set_dependencies": {
        const { task_id, ...patch } = MCP_TOOLS.set_dependencies.input.parse(input);
        return this.setTaskDependencies(task_id, patch);
      }
      case "cancel_task": {
        const { task_id } = MCP_TOOLS.cancel_task.input.parse(input);
        return this.cancelTask(task_id);
      }
    }
  }

  private async sessionBriefHints(snapshot: SessionBriefHintSnapshot): Promise<string[]> {
    const hints: string[] = [];
    try {
      const projectId = this.config.project_id;
      const freshness = await this.store.inspect((db) => {
        // Avoid waiting on SQLite lock contention for optional output.
        db.exec("PRAGMA busy_timeout = 0");
        const indexed = db
          .prepare("SELECT 1 FROM files WHERE project_id = ? LIMIT 1")
          .get(projectId);
        return indexed ? checkGraphFreshness(db, projectId, snapshot.graphRoots) : undefined;
      });
      if (freshness?.stale) {
        hints.push(
          briefText(
            `Code graph index is stale (${freshness.reason ?? "changed"}) — run \`catenext index\`.`,
            160,
          ),
        );
      }
    } catch {
      // Unavailable graph: still attempt the worktree hint.
    }
    if (snapshot.worktreeLeases) {
      try {
        const overlaps = await readWorktreeOverlapHint(this.repoRoot, snapshot.worktreeLeases);
        if (overlaps.length > 0) {
          const files = overlaps.slice(0, 3).map((o) => o.file);
          const more = overlaps.length > 3 ? `, +${overlaps.length - 3} more` : "";
          hints.push(
            briefText(
              `Worktree file overlap detected (${overlaps.length}): ${files.join(", ")}${more} — run \`catenext worktree status\`.`,
              160,
            ),
          );
        }
      } catch {
        // Worktree hints are optional, even if the scanner fails unexpectedly.
      }
    }
    if (this.caller === "agent" && process.env.CATENEXT_MCP_ROLE === "") {
      hints.push(
        briefText(
          "MCP launched without --role — prefer --role orchestrator|worker to shrink tools/list.",
          160,
        ),
      );
    }
    return hints.slice(0, 6);
  }

  async callTool<K extends McpToolName>(
    name: K,
    input: unknown,
    local?: {
      /** Confirm checkout still exists under the same lock as prune. */
      beforeClaim?: K extends "claim_task" ? () => Promise<void> : never;
      /** Compare against what was presented to the human, not proof of authorship. */
      approvalSnapshot?: K extends "manage_task" ? string : never;
    },
  ): Promise<McpToolOutput<K>> {
    const toolName: McpToolName = name as McpToolName;
    if (isMcpCrudTool(toolName)) this.requireCrudPermission();
    const contract = MCP_TOOLS[name];
    const parsed = contract.input.safeParse(scrubDeep(input, DEFAULT_SCRUB_SKIP_KEYS).value);
    if (!parsed.success) {
      const paths = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)")),
      ];
      fail("invalid_input", `Input ${name} tidak valid: ${paths.join(", ")}.`, { fields: paths });
    }
    if (isMcpCrudTool(toolName)) {
      const result = await this.callCrudTool(toolName, parsed.data);
      return contract.output.parse(result) as McpToolOutput<K>;
    }
    if (name === "manage_task") {
      requireHumanApproval(this.caller, MCP_TOOLS.manage_task.input.parse(parsed.data));
    }
    const existed = existsSync(this.stateFile);
    const { out, hintSnapshot, claimContext } = await this.store.transaction(
      this.config.project_id,
      this.config.repo_name,
      async (project, dirty, db, afterSave) => {
        if (name === "claim_task") await local?.beforeClaim?.();
        const now = Date.now();
        const tools = new LocalWorkflow(
          project,
          this.config,
          this.repoRoot,
          db,
          now,
          dirty,
          this.caller,
        );
        const leaseId = "lease_id" in parsed.data ? parsed.data.lease_id : undefined;
        tools.tick(leaseId, name);
        if (toolName === "session_brief") {
          const { verbose } = MCP_TOOLS.session_brief.input.parse(parsed.data);
          const { brief, hintSnapshot } = tools.sessionBrief(Boolean(verbose));
          return { out: contract.output.parse(brief) as McpToolOutput<K>, hintSnapshot };
        }
        let result: unknown;
        let claimContext: ClaimContextSnapshot | undefined;
        if (toolName === "claim_task") {
          ({ result, context: claimContext } = tools.claim(
            MCP_TOOLS.claim_task.input.parse(parsed.data),
          ));
        } else if (name === "manage_task" && local?.approvalSnapshot !== undefined) {
          result = tools.manageTask(
            MCP_TOOLS.manage_task.input.parse(parsed.data),
            local.approvalSnapshot,
          );
        } else {
          // The registry correlates the parser and handler, which TS loses on generic access.
          const run = tools.handlers[toolName] as (data: typeof parsed.data) => unknown;
          result = await run(parsed.data);
        }
        const validated = contract.output.parse(result) as McpToolOutput<K>;
        const events = tools.drainEvents();
        const runs = tools.drainRuns();
        if (events.length > 0 || runs.length > 0) {
          afterSave((txDb) => {
            for (const run of runs) saveRun(txDb, this.config.project_id, run);
            insertTaskEvents(txDb, this.config.project_id, events);
          });
        }
        return { out: validated, claimContext };
      },
    );
    if (!existed && process.platform !== "win32" && existsSync(this.stateFile)) {
      await chmod(this.stateFile, 0o600);
    }
    // transaction() has committed and released the writer lock before any hint I/O.
    if (hintSnapshot) {
      const hints = await this.sessionBriefHints(hintSnapshot);
      if (hints.length > 0) return { ...out, hints };
    }
    if (claimContext) {
      const pack = await enrichClaimContext(claimContext, this.repoRoot, this.config.platforms);
      if (pack) return { ...out, context_pack: pack };
    }
    return out;
  }
}

class LocalWorkflow {
  private readonly tasks: Map<string, LocalTask>;
  private readonly repo: string;
  private readonly iso: string;
  private readonly events: NewTaskEvent[] = [];
  private readonly runs: EpicRun[] = [];

  constructor(
    private readonly project: LocalProject,
    private readonly config: CatenextConfig,
    private readonly root: string,
    private readonly db: DatabaseSync,
    private readonly now: number,
    private readonly dirty: () => void,
    private readonly caller: "human" | "agent" = "human",
  ) {
    this.tasks = new Map(project.tasks.map((task) => [task.id, task]));
    this.repo = config.repo_name;
    this.iso = new Date(now).toISOString();
  }

  private recordEvent(event: Omit<NewTaskEvent, "created_at">): void {
    this.events.push({ ...event, created_at: this.iso });
  }

  drainEvents(): NewTaskEvent[] {
    return this.events.splice(0);
  }

  drainRuns(): EpicRun[] {
    return this.runs.splice(0);
  }

  private taskRun(task: LocalTask): EpicRun | undefined {
    const run = readRun(this.db, this.config.project_id, task.epicId);
    return run?.status === "CLOSED" ? undefined : run;
  }

  private assertHealthy(run: EpicRun) {
    assertRunHealthy(run, this.project, this.db, this.config.project_id);
  }

  startRun(plan: EpicRun["plan"], snapshot: string): EpicRun {
    for (const { id } of plan.tasks) {
      const task = this.task(id);
      if (task.status === "DRAFT") this.manageTask({ action: "approve_plan", task_id: id });
      this.recordEvent({
        task_id: id,
        event: "epic_run_start",
        actor: "human",
        detail: { epic_id: plan.epic_id, snapshot },
      });
    }
    return {
      plan,
      snapshot,
      authorized_at: this.iso,
      status: "RUNNING",
      reviews: [],
      verification: [],
    };
  }

  private pauseRun(run: EpicRun, reason: string) {
    run.status = "PAUSED";
    run.reason = reason;
    delete run.ready_head;
  }

  advanceRun(
    run: EpicRun,
    options: Exclude<z.output<typeof epicRunAction>, { action: "preview" | "start" }>,
  ) {
    if (options.action === "close") {
      if (run.plan.tasks.some(({ id }) => this.tasks.get(id)?.lease))
        fail("run_state", "Release held task leases before closing the run.");
      run.status = "CLOSED";
      return;
    }
    if (run.status === "CLOSED") return;
    if (options.action === "pause") {
      this.pauseRun(run, options.reason);
      return;
    }
    const issue = runIssue(run, this.project, this.db, this.config.project_id);
    if (issue) {
      this.pauseRun(run, issue);
      return;
    }
    if (run.status === "READY_FOR_PR") {
      try {
        if (localCommit(this.root, integrationBranch(run.plan.epic_id)) !== run.ready_head) {
          this.pauseRun(run, "Verified integration branch moved.");
        }
      } catch {
        this.pauseRun(run, "Verified integration branch is missing or unreadable.");
      }
      return;
    }
    if (options.action === "resume") return;
    if (options.action === "verify") {
      if (run.verification.some(({ attempt }) => attempt === options.attempt)) return;
      try {
        assertIntegration(this.root, run, this.project, options.path, options.head);
      } catch (error) {
        if (
          !(error instanceof LocalServiceError) ||
          !["run_scope", "run_risk"].includes(error.code)
        )
          throw error;
        this.pauseRun(run, error.message);
        return;
      }
      run.verification.push({
        attempt: options.attempt,
        head: options.head,
        result: options.result,
        at: this.iso,
      });
      if (options.result === "pass") {
        run.status = "READY_FOR_PR";
        run.ready_head = options.head;
      } else if (run.verification.filter(({ result }) => result === "fail").length >= 2) {
        this.pauseRun(run, "Integration verification failed twice.");
      }
      return;
    }
    const task = this.task(options.task);
    if (!run.plan.tasks.some(({ id }) => id === task.id))
      fail("run_scope", "Task is outside run scope.");
    const reviewer = this.persona(options.reviewer);
    if (
      reviewer.role !== "reviewer" ||
      reviewer.alias === task.persona ||
      !allowsRepo(reviewer, this.repo)
    ) {
      fail("reviewer_required", "An independent reviewer persona for this repo is required.");
    }
    const previous = run.reviews.findLast(({ task: id }) => id === task.id);
    if (
      previous?.head === options.head &&
      previous.decision === options.decision &&
      previous.feedback === options.feedback &&
      previous.reviewer === options.reviewer &&
      (previous.revision === task.revision ||
        (previous.decision === "request_changes" && previous.revision + 1 === task.revision))
    )
      return;
    if (task.status !== "NEEDS_REVIEW" || task.handoff?.last_commit_hash !== options.head) {
      fail("run_review", "Review must target current NEEDS_REVIEW handoff and its exact commit.");
    }
    try {
      runTaskChanges(this.root, run, this.project, task, options.head);
    } catch (error) {
      if (!(error instanceof LocalServiceError) || !["run_scope", "run_risk"].includes(error.code))
        throw error;
      this.pauseRun(run, error.message);
      return;
    }
    const revision = task.revision;
    if (options.decision === "request_changes") {
      if (revision >= 2) this.pauseRun(run, `Task ${task.id} reached its two-revision limit.`);
      else reviseTask(task, this.tasks.values(), options.feedback, this.iso);
    } else if (previous?.revision === revision && previous.head === options.head) {
      fail(
        "run_review",
        "Acceptance is already recorded for this handoff. Request changes to supersede it.",
      );
    }
    run.reviews.push({
      task: task.id,
      head: options.head,
      reviewer: options.reviewer,
      decision: options.decision,
      feedback: options.feedback,
      revision,
      at: this.iso,
    });
    this.dirty();
    this.recordEvent({
      task_id: task.id,
      event: "epic_run_review",
      actor: options.reviewer,
      note: options.feedback,
      detail: {
        source: "delegated_review",
        decision: options.decision,
        head: options.head,
        revision,
        to: task.status,
      },
    });
  }

  runView(run: EpicRun) {
    const tasks = run.plan.tasks.map(({ id }) => this.tasks.get(id));
    const busy = tasks.filter((task) => task?.lease).length;
    const slots = Math.max(0, 2 - busy);
    const eligible =
      run.status === "RUNNING"
        ? tasks.flatMap((task) => (task && this.readyByDeps(task) ? [task.id] : [])).slice(0, slots)
        : [];
    return {
      ...run,
      integration_branch: integrationBranch(run.plan.epic_id),
      host_mode: "stepped" as const,
      unattended_supported: false,
      eligible,
      tasks: run.plan.tasks.map(({ id }, index) => ({
        id,
        status: tasks[index]?.status ?? null,
        revision: tasks[index]?.revision ?? null,
        branch: runBranch(run.plan.epic_id, id),
        head: tasks[index]?.handoff?.last_commit_hash ?? null,
      })),
    };
  }

  readonly handlers: Handlers = {
    create_epic: (input) => this.createEpic(input),
    list_epics: (input) => ({ epics: this.epicSummaries(input.include_archived) }),
    create_tasks: (input) => this.createTasks(input),
    manage_task: (input) => this.manageTask(input),
    list_personas: () => ({
      personas: this.personas().map((persona) => ({
        ...persona,
        id: projectPersonaId(this.config.project_id, persona.alias),
        scope: "project",
      })),
    }),
    upsert_persona: (input) => this.upsertPersona(input),
    remove_persona: (input) => this.removePersona(input),
    get_project_board: (input) => this.board(input),
    get_project_context: (input) => this.context(input),
    get_ready_tasks: (input) => ({
      tasks: this.ready(input, input.limit).map((task) => this.summary(task)),
    }),
    release_task: (input) => this.release(input),
    report_blocker: (input) => this.block(input),
    complete_handoff: (input) => this.handoff(input),
    get_document: (input) => this.document(input),
    save_document: (input) => this.saveDocument(input),
    archive_document: (input) => this.archiveDocument(input),
    restore_document: (input) => this.restoreDocument(input),
    search_context: (input) => this.search(input),
    review_pull_request: ({ request }) =>
      reviewPullRequest(request, {
        project: this.project,
        tasks: this.tasks,
        repoRoot: this.root,
        repo: this.repo,
        overrides: this.config.overrides,
        now: this.now,
        iso: this.iso,
        personaForAlias: (alias) => this.persona(alias),
        dirty: this.dirty,
        recordEvent: (event) => this.recordEvent(event),
      }),
    load_skill: async ({ name, revision, source_id }) => {
      const skill = await loadCatalogSkill(this.root, name, {
        platforms: this.config.platforms,
        sourceId: source_id,
        revision,
      });
      return {
        name: skill.name,
        when_to_use: skill.when_to_use,
        content: skill.content,
        source_id: skill.source_id,
        source_kind: skill.source_kind,
        source_path: skill.source_path,
        ...(skill.collision ? { collision: true } : {}),
        ...(revision ? { revision } : {}),
      };
    },
    save_repo_skill: (input) => saveSkill(this.root, input, new Date(this.now)),
    interview_setup: (input) => buildInterviewSetup(this.root, input.step, this.config.stack ?? []),
    manage_roots: (input) => this.manageRoots(input),
    graph_neighbors: (input) =>
      queryGraphNeighbors(this.db, this.config.project_id, input, this.graphRootDirs()),
    symbol_search: (input) => {
      const rootDirs = this.graphRootDirs();
      return {
        hits: symbolSearch(this.db, this.config.project_id, input.query, input.limit),
        ...this.graphFreshness(rootDirs),
      };
    },
    graph_summary: (input) =>
      summarizeProjectGraph(this.db, this.config.project_id, input, this.graphRootDirs()),
    graph_impact: (input) =>
      analyzeGraphImpact(this.db, this.config.project_id, input, this.graphRootDirs()),
  };

  private graphRootDirs(): GraphRootDir[] {
    return [
      { rootId: null, dir: this.root },
      ...(this.project.workspace_roots ?? []).map((r) => ({ rootId: r.id, dir: r.path })),
    ];
  }

  private graphFreshness(rootDirs: GraphRootDir[]): { stale?: boolean; stale_reason?: string } {
    const freshness = checkGraphFreshness(this.db, this.config.project_id, rootDirs);
    if (!freshness.stale) return {};
    return {
      stale: true,
      ...(freshness.reason ? { stale_reason: freshness.reason } : {}),
    };
  }

  /** Only the exact lease_id holder renews its own lease; expired leases are returned first. */
  tick(leaseId: string | undefined, name: McpToolName): void {
    for (const task of this.tasks.values()) {
      const lease = task.lease;
      if (task.review?.lease && Date.parse(task.review.lease.expiresAt) <= this.now) {
        delete task.review.lease;
        this.dirty();
      }
      if (!lease) continue;
      // Lease expired TIDAK langsung dilepas: holder yang sama masih boleh menyerahkan
      // pekerjaan (handoff terlambat) sampai ada claim baru yang menggantikannya.
      if (
        Date.parse(lease.expiresAt) > this.now &&
        name !== "claim_task" &&
        leaseId !== undefined &&
        leaseMatches(lease.id, leaseId) &&
        lease.repo === this.repo
      ) {
        lease.expiresAt = leaseEnd(this.now);
        this.dirty();
      }
    }
  }

  private task(id: string): LocalTask {
    return this.tasks.get(id) ?? fail("not_found", "Task tidak ditemukan di proyek ini.");
  }

  private activeLease(task: LocalTask): LocalTask["lease"] | undefined {
    if (!task.lease) return undefined;
    return Date.parse(task.lease.expiresAt) > this.now ? task.lease : undefined;
  }

  private persona(alias: string): Persona {
    return (
      this.project.personas.find((p) => p.alias === alias) ??
      fail("persona_not_found", `Persona "${alias}" tidak ditemukan di proyek ini.`)
    );
  }

  private personas(): Persona[] {
    return [...this.project.personas].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  private personaFor(role: string | null, repo: string | null): Persona | undefined {
    if (!role) return undefined;
    const matches = this.project.personas.filter(
      (p) => p.role === role && (!repo || allowsRepo(p, repo)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private owner(task: LocalTask, persona: Persona | undefined, role: string | null): void {
    if (persona && task.target && !allowsRepo(persona, task.target)) {
      fail(
        "persona_repo_mismatch",
        `Persona "${persona.alias}" tidak memegang repo "${task.target}".`,
      );
    }
    task.persona = persona?.alias ?? null;
    task.role = persona?.role ?? role;
    if (!task.target && persona?.repos.length === 1) task.target = persona.repos[0] ?? null;
  }

  private readyByDeps(task: LocalTask): boolean {
    return (
      claimable(task) && task.dependencies.every((id) => this.tasks.get(id)?.status === "DONE")
    );
  }

  private ready(
    input: { agent_alias?: string | undefined; role?: string | undefined },
    limit: number,
  ): LocalTask[] {
    const alias = input.agent_alias ?? this.config.overrides?.default_agent_alias;
    const persona = alias ? this.persona(alias) : undefined;
    const role = input.role ?? persona?.role ?? this.config.overrides?.default_role;
    if (!allowsRepo(persona, this.repo)) return [];
    const activeTasks = filterVisibleTasks(this.project.tasks, this.project.epics, false);
    return activeTasks
      .filter(
        (task) =>
          this.readyByDeps(task) &&
          (!task.target || task.target === this.repo) &&
          (!task.branch || task.branch.repo === this.repo) &&
          (task.persona ? task.persona === alias : !role || !task.role || task.role === role),
      )
      .sort(
        (a, b) =>
          Number(b.status === "REVISION_REQUESTED") - Number(a.status === "REVISION_REQUESTED"),
      )
      .slice(0, limit);
  }

  private summary(task: LocalTask): TaskSummary {
    return {
      id: task.id,
      title: task.title,
      depends_on: task.dependencies,
      ...(task.role ? { role: task.role } : {}),
      ...(task.target ? { target_repo: task.target } : {}),
      ...(task.persona ? { persona: task.persona } : {}),
      ...(task.status === "REVISION_REQUESTED" ? { revision: true } : {}),
    };
  }

  private epicSummaries(includeArchived = false) {
    const visibleEpics = filterVisibleEpics(this.project.epics, includeArchived);
    const counts = new Map(visibleEpics.map((epic) => [epic.id, new Map<string, number>()]));
    for (const task of this.project.tasks) {
      const entry = counts.get(task.epicId);
      entry?.set(task.status, (entry.get(task.status) ?? 0) + 1);
    }
    return visibleEpics.map((epic) => ({
      id: epic.id,
      title: epic.title,
      description: epic.description,
      task_counts: Object.fromEntries(counts.get(epic.id) ?? []),
      ...(epic.archived_at ? { archived_at: epic.archived_at } : {}),
      ...(epic.summary
        ? {
            summary_version: epic.summary.version,
            summary_updated_at: epic.summary.updated_at,
          }
        : {}),
    }));
  }

  private createEpic(input: Parsed<"create_epic">): McpToolOutput<"create_epic"> {
    const epic = { id: randomUUID(), title: input.title, description: input.description ?? null };
    this.project.epics.push(epic);
    this.dirty();
    return { epic: { ...epic, task_counts: {} } };
  }

  private createTasks(input: Parsed<"create_tasks">): McpToolOutput<"create_tasks"> {
    if (!this.project.epics.some((epic) => epic.id === input.epic_id && !epic.archived_at))
      fail("not_found", "Epic tidak ditemukan di proyek ini.");
    const ids = new Map(input.tasks.map((task) => [task.ref, randomUUID()]));
    let position = (this.project.tasks.at(-1)?.position ?? -1) + 1;
    const created = input.tasks.map((item) => {
      const task_id = ids.get(item.ref) ?? fail("invalid_input", "Ref task tidak ditemukan.");
      const dependencies = [
        ...new Set(
          item.depends_on.map((dep) => {
            const id = ids.get(dep);
            if (id) return id;
            if (!this.tasks.has(dep))
              fail("dependency_not_found", "UUID dependensi tidak ditemukan di proyek ini.");
            return dep;
          }),
        ),
      ];
      const target = item.target_repo ?? null;
      const role = item.role ?? null;
      const persona = item.persona ? this.persona(item.persona) : this.personaFor(role, target);
      const task: LocalTask = {
        id: task_id,
        epicId: input.epic_id,
        title: item.title,
        instruction: item.prompt_instruction,
        status: "DRAFT",
        dependencies,
        target,
        role,
        persona: null,
        position: position++,
        requiresApproval: item.requires_approval,
        stale: false,
        revision: 0,
        ...(item.scope_files !== undefined ? { scope_files: item.scope_files } : {}),
        ...(item.verify_command !== undefined ? { verify_command: item.verify_command } : {}),
        ...(item.doc_refs !== undefined ? { doc_refs: item.doc_refs } : {}),
      };
      this.owner(task, persona, role);
      this.project.tasks.push(task);
      return { ref: item.ref, task_id, status: "DRAFT" as const };
    });
    this.dirty();
    return { created };
  }

  private upsertPersona(input: Parsed<"upsert_persona">): McpToolOutput<"upsert_persona"> {
    if (this.caller === "agent") {
      const allowed = (this.project.permissions ?? []).some(
        (row) => row.action === "upsert_persona" && row.principal === "orchestrator",
      );
      if (!allowed) fail("permission_denied", "upsert_persona requires edit permission.");
    }
    const existing = this.project.personas.find((p) => p.alias === input.alias);
    const persona: Persona = {
      alias: input.alias,
      role: input.role,
      rules: input.rules ?? existing?.rules ?? [],
      repos: [...new Set(input.repos ?? existing?.repos ?? [])],
    };
    if (existing) {
      Object.assign(existing, persona);
      for (const task of this.tasks.values()) {
        if (task.persona === persona.alias && task.status !== "DONE") task.role = persona.role;
      }
    } else this.project.personas.push(persona);
    this.dirty();
    return { persona, created: !existing };
  }

  private removePersona(input: Parsed<"remove_persona">): McpToolOutput<"remove_persona"> {
    if (this.caller === "agent") {
      const allowed = (this.project.permissions ?? []).some(
        (row) => row.action === "upsert_persona" && row.principal === "orchestrator",
      );
      if (!allowed) fail("permission_denied", "remove_persona requires edit permission.");
    }
    const idx = this.project.personas.findIndex((p) => p.alias === input.alias);
    if (idx < 0) {
      fail("persona_not_found", `Persona "${input.alias}" tidak ditemukan di proyek ini.`);
    }
    const leased = this.project.tasks.filter(
      (task) => task.persona === input.alias && this.activeLease(task),
    );
    if (leased.length > 0) {
      fail(
        "persona_in_use",
        `Persona "${input.alias}" masih memegang lease aktif pada ${leased.length} task; lepas lease dulu.`,
        { task_ids: leased.map((t) => t.id) },
      );
    }
    const ownedRoots = (this.project.workspace_roots ?? []).filter(
      (root) => root.ownerPersona === input.alias,
    );
    if (ownedRoots.length > 0) {
      fail(
        "persona_owns_roots",
        `Persona "${input.alias}" masih menjadi owner ${ownedRoots.length} workspace root; pindahkan atau hapus root dulu.`,
        { root_ids: ownedRoots.map((r) => r.id) },
      );
    }
    for (const task of this.project.tasks) {
      if (task.persona === input.alias) task.persona = null;
    }
    this.project.personas.splice(idx, 1);
    this.dirty();
    return { alias: input.alias, removed: true };
  }

  private repos(): string[] {
    const names = new Set(this.project.repos);
    for (const persona of this.project.personas) for (const repo of persona.repos) names.add(repo);
    for (const task of this.tasks.values()) if (task.target) names.add(task.target);
    return [...names].sort();
  }

  private board(input: Parsed<"get_project_board">): McpToolOutput<"get_project_board"> {
    const personas = this.personas();
    const includeArchived = Boolean(input.include_archived);
    const epics = this.epicSummaries(includeArchived).filter(
      (epic) => !input.epic_id || epic.id === input.epic_id,
    );
    const visibleTasks = filterVisibleTasks(
      this.project.tasks,
      this.project.epics,
      includeArchived,
    );
    const rows = visibleTasks.filter(
      (task) =>
        (!input.epic_id || task.epicId === input.epic_id) &&
        (!input.task_id || task.id === input.task_id) &&
        (!input.status?.length || input.status.includes(task.status)),
    );
    return {
      epics: epics.map(({ id, title, task_counts, archived_at }) => ({
        id,
        title,
        counts: task_counts,
        ...(archived_at ? { archived_at } : {}),
      })),
      repos: this.repos().map((repo) => ({
        repo,
        personas: personas.filter((p) => p.repos.includes(repo)).map((p) => p.alias),
      })),
      personas,
      tasks: rows.slice(0, input.limit).map((task) => ({
        id: task.id,
        title: briefText(task.title, 120),
        epic_id: task.epicId,
        status: task.status,
        role: task.role,
        target_repo: task.target,
        persona: task.persona,
        depends_on: task.dependencies,
        is_ready: this.readyByDeps(task),
        is_stale: task.stale,
        revision_count: task.revision,
        locked_by_repo: this.activeLease(task)?.repo ?? null,
        blocker_reason: task.blocker
          ? briefText(task.blocker.reason, input.verbose ? 1000 : 160)
          : null,
        ...(task.archived_at ? { archived_at: task.archived_at } : {}),
      })),
      truncated: rows.length > input.limit,
    };
  }

  /** Bind decision to project, action, task content and its latest audit event (including ABA). */
  private approvalSnapshot(task: LocalTask, action: ApprovalAction): string {
    const latest = this.db
      .prepare("SELECT max(id) AS id FROM task_events WHERE project_id = ? AND task_id = ?")
      .get(this.config.project_id, task.id)?.id;
    const { lease: _lease, review, ...content } = task;
    const { lease: _reviewLease, ...reviewContent } = review ?? {};
    // Ignore transient leases; membership of dependencies matters, not their read order.
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.config.project_id,
          action,
          latest ?? null,
          { ...content, dependencies: [...content.dependencies].sort() },
          reviewContent,
        ]),
      )
      .digest("hex");
  }

  sessionBrief(verbose: boolean): {
    brief: McpToolOutput<"session_brief">;
    hintSnapshot: SessionBriefHintSnapshot;
  } {
    const lines: McpToolOutput<"session_brief">["lines"] = [];
    const activeTasks = filterVisibleTasks(this.project.tasks, this.project.epics, false);
    const ready = activeTasks.filter((task) => this.readyByDeps(task));
    const blocked = activeTasks.filter((task) => task.status === "BLOCKED");
    const draft = activeTasks.filter((task) => task.status === "DRAFT");
    const needsReview = activeTasks.filter((task) => task.status === "NEEDS_REVIEW");
    const approvalOptions = (taskId: string, kind: "plan" | "review") => [
      {
        id: "approve" as const,
        label: kind === "plan" ? "Approve plan" : "Approve handoff",
        command_hint: `${HUMAN_APPROVAL_COMMANDS[kind === "plan" ? "approve_plan" : "approve"]} ${taskId}`,
      },
      {
        id: "revise" as const,
        label: "Request revision (send feedback)",
        command_hint: `catenext revise ${taskId} --feedback "…"`,
      },
      {
        id: "next" as const,
        label: "Skip for now / show brief again",
        command_hint: "catenext brief",
      },
    ];
    const pending_approvals: McpToolOutput<"session_brief">["pending_approvals"] = [
      ...draft.slice(0, 5).map((task) => ({
        task_id: task.id,
        title: briefText(task.title, 120),
        status: task.status,
        summary: briefText(task.instruction, verbose ? 160 : 120),
        approval_snapshot: this.approvalSnapshot(task, "approve_plan"),
        ...(task.verify_command ? { verify_command: task.verify_command } : {}),
        options: approvalOptions(task.id, "plan"),
      })),
      ...needsReview.slice(0, 5).map((task) => ({
        task_id: task.id,
        title: briefText(task.title, 120),
        status: task.status,
        summary: briefText(
          task.handoff?.notes_for_next_agent ??
            task.handoff?.verification_command ??
            "Needs review",
          verbose ? 160 : 120,
        ),
        approval_snapshot: this.approvalSnapshot(task, "approve"),
        ...(task.handoff
          ? {
              branch: task.handoff.git_branch,
              commit: task.handoff.last_commit_hash,
              ...(task.handoff.verification_command
                ? { verify_command: task.handoff.verification_command }
                : {}),
            }
          : {}),
        options: approvalOptions(task.id, "review"),
      })),
    ].slice(0, 10);

    lines.push({
      kind: "info",
      text: "Read CATENEXT.md first (master prompt), then AGENTS.md.",
    });
    const activeWorktrees = this.project.tasks.filter((task) => {
      const lease = this.activeLease(task);
      return (
        task.status === "IN_PROGRESS" && Boolean(lease) && Boolean(task.branch || lease?.worktree)
      );
    });
    for (const task of activeWorktrees.slice(0, 5)) {
      const lease = this.activeLease(task);
      const worktreePath = lease?.worktree?.worktree_path ?? task.branch?.worktree_path;
      const baseBranch = lease?.worktree?.base_branch ?? task.branch?.base_branch;
      const branchLabel = baseBranch
        ? `${task.branch?.name ?? "branch?"} (base=${baseBranch})`
        : (task.branch?.name ?? "branch?");
      const pathPart = worktreePath ? ` · path=${worktreePath}` : "";
      lines.push({
        kind: "worktree",
        text: briefText(
          `${task.persona ?? "?"} · ${branchLabel}${pathPart} · session=${lease?.worktree?.session ?? "-"}`,
        ),
        task_id: task.id,
      });
    }
    for (const task of ready.slice(0, 5)) {
      lines.push({
        kind: "ready",
        text: briefText(`${task.persona ?? task.role ?? "unassigned"} · ${task.title}`),
        task_id: task.id,
      });
    }
    for (const task of blocked.slice(0, 5)) {
      lines.push({
        kind: "blocked",
        text: briefText(`${task.title}: ${task.blocker?.reason ?? "blocked"}`, verbose ? 160 : 120),
        task_id: task.id,
      });
    }
    const workspaceRoots = this.workspaceRootSummaries();
    if (workspaceRoots.length) {
      lines.push({
        kind: "info",
        text: briefText(
          `roots: ${workspaceRoots
            .map((r) => `${r.label ?? basename(r.path)}(${r.owner_persona ?? "*"})`)
            .join(", ")}`,
        ),
      });
    }
    if (pending_approvals.length) {
      lines.push({
        kind: "decision",
        text: briefText(
          `${pending_approvals.length} human approval(s) — present options approve/revise/next`,
        ),
      });
    }
    if (!this.project.platform_setup.length) {
      lines.push({
        kind: "ask",
        text: "No platform_setup yet — run interview_setup / catenext init",
      });
    } else if (pending_approvals[0]) {
      lines.push({
        kind: "ask",
        text: briefText(`Ask human: approve/revise/next for ${pending_approvals[0].task_id}`),
        task_id: pending_approvals[0].task_id,
      });
    } else if (ready[0]) {
      lines.push({
        kind: "ask",
        text: briefText(
          `Delegate ready task ${ready[0].id} to ${ready[0].persona ?? ready[0].role ?? "persona"}`,
        ),
        task_id: ready[0].id,
      });
    } else {
      lines.push({ kind: "info", text: "No ready tasks. Plan or unblock next." });
    }
    return {
      brief: {
        lines: lines.slice(0, 24),
        ready_count: ready.length,
        blocked_count: blocked.length,
        draft_count: draft.length,
        pending_approvals,
        workspace_roots: workspaceRoots,
        read_first: "CATENEXT.md",
        ...(this.project.session_prefs?.locale
          ? { locale: this.project.session_prefs.locale }
          : {}),
      },
      hintSnapshot: {
        graphRoots: this.graphRootDirs(),
        ...(activeWorktrees.length > 1
          ? { worktreeLeases: snapshotWorktreeLeases(this.project.tasks, this.repo) }
          : {}),
      },
    };
  }

  private workspaceRootSummaries() {
    return (this.project.workspace_roots ?? []).slice(0, 20).map((root) => ({
      id: root.id,
      path: root.path,
      owner_persona: root.ownerPersona,
      ...(root.label ? { label: root.label } : {}),
    }));
  }

  private manageRoots(input: Parsed<"manage_roots">): McpToolOutput<"manage_roots"> {
    this.project.workspace_roots ??= [];
    if (input.action === "list") {
      return {
        roots: this.project.workspace_roots.map((root) => ({
          id: root.id,
          path: root.path,
          owner_persona: root.ownerPersona,
          ...(root.label ? { label: root.label } : {}),
        })),
      };
    }
    if (this.caller === "agent") {
      const allowed = (this.project.permissions ?? []).some(
        (row) => row.action === "manage_roots" && row.principal === "orchestrator",
      );
      if (!allowed) fail("permission_denied", "manage_roots requires edit permission.");
    }
    if (input.action === "add") {
      const path = input.path
        ? resolve(input.path)
        : fail("invalid_input", "path required for add");
      let lstat: ReturnType<typeof lstatSync>;
      try {
        lstat = lstatSync(path);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "ENOENT" || code === "ENOTDIR") {
          fail("invalid_input", `Root path does not exist: ${path}`);
        }
        if (code === "EACCES" || code === "EPERM") {
          fail("permission_denied", `Root path cannot be accessed: ${path}`);
        }
        throw error;
      }
      if (lstat.isSymbolicLink()) {
        fail("permission_denied", `Root path must not be a symlink: ${path}`);
      }
      const stat = statSync(path);
      if (!stat.isDirectory()) {
        fail("invalid_input", `Root path must be a directory: ${path}`);
      }
      if (this.project.workspace_roots.some((root) => root.path === path)) {
        fail("already_exists", "Root path already registered.");
      }
      if (input.persona) this.persona(input.persona);
      this.project.workspace_roots.push({
        id: newRootId(),
        path,
        ownerPersona: input.persona ?? null,
        ...(input.label ? { label: input.label } : {}),
      });
      this.dirty();
    } else if (input.action === "remove") {
      const before = this.project.workspace_roots.length;
      this.project.workspace_roots = this.project.workspace_roots.filter((root) => {
        if (input.root_id) return root.id !== input.root_id;
        if (input.path) return root.path !== resolve(input.path);
        return true;
      });
      if (this.project.workspace_roots.length === before)
        fail("not_found", "Workspace root not found.");
      this.dirty();
    }
    return {
      roots: this.project.workspace_roots.map((root) => ({
        id: root.id,
        path: root.path,
        owner_persona: root.ownerPersona,
        ...(root.label ? { label: root.label } : {}),
      })),
    };
  }

  private async context(
    input: Parsed<"get_project_context">,
  ): Promise<McpToolOutput<"get_project_context">> {
    const alias = input.agent_alias ?? this.config.overrides?.default_agent_alias;
    const persona = alias ? this.persona(alias) : undefined;
    const active =
      input.lease_id === undefined
        ? undefined
        : this.project.tasks.find(
            (task) => task.lease?.repo === this.repo && leaseMatches(task.lease.id, input.lease_id),
          );
    const epic = active && this.project.epics.find((item) => item.id === active.epicId);
    const recent = new Map<string, ReturnType<typeof dependencyHandoffs>[number]>();
    for (const task of active ? [active] : this.ready(input, 5)) {
      for (const handoff of dependencyHandoffs(task, this.tasks))
        recent.set(handoff.task_id, handoff);
    }
    const catalog = await discoverSkillCatalog(this.root, {
      platforms: this.config.platforms,
    });
    return {
      project: {
        id: this.config.project_id,
        name: this.config.project_name ?? (basename(this.root) || this.repo),
        repo_name: this.repo,
        stack: this.config.stack,
        layout: this.config.layout,
      },
      directives: [...directives, ...(this.config.overrides?.extra_rules ?? [])],
      ...(persona ? { persona } : {}),
      ...(epic
        ? {
            epic_summary: resolveEpicSummaryText(epic, this.project.tasks, 1000),
          }
        : {}),
      skills: toSkillIndexEntries(catalog.entries, this.repo),
      recent_handoffs: [...recent.values()].slice(0, active ? undefined : 5),
      project_repos: this.repos(),
      documents: filterVisibleDocuments(this.project.documents, input.include_archived)
        .map(recordIndex)
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.slug.localeCompare(b.slug)),
      workspace_roots: this.workspaceRootSummaries(),
      ...(this.project.session_prefs?.locale ? { locale: this.project.session_prefs.locale } : {}),
    };
  }

  claim(input: Parsed<"claim_task">): {
    result: McpToolOutput<"claim_task">;
    context?: ClaimContextSnapshot;
  } {
    const task = this.task(input.task_id);
    const { worktree } = input;
    const run = this.taskRun(task);
    if (run) {
      this.assertHealthy(run);
      const branch = runBranch(task.epicId, task.id);
      if (run.plan.repo !== this.repo) fail("wrong_repo", "Run belongs to another repo.");
      if (!worktree?.worktree_path || worktree.branch !== branch) {
        fail("run_worktree", `Claim in linked checkout on ${branch}.`);
      }
      assertRunCheckout(this.root, runPrefix(task.epicId), branch, worktree.worktree_path);
      if (
        this.project.tasks.filter(
          (other) => other.epicId === task.epicId && other.id !== task.id && other.lease,
        ).length >= 2
      ) {
        fail("run_capacity", "Two run tasks already hold leases.");
      }
      assertDescends(this.root, run.plan.base_sha, localCommit(this.root, branch));
    }
    const alias = input.agent_alias ?? this.config.overrides?.default_agent_alias;
    const persona = alias ? this.persona(alias) : undefined;
    const owner = task.persona ? this.persona(task.persona) : undefined;
    // Lease expired boleh diambil alih; holder lama kehilangan hak lewat lease_id baru.
    if (task.lease && Date.parse(task.lease.expiresAt) <= this.now) {
      const expired = task.lease;
      const returnedStatus = returnClaim(task);
      this.recordEvent({
        task_id: task.id,
        event: "lease_expired",
        actor: "system",
        note: expired.alias ? `expired lease (${expired.alias})` : "expired lease",
        detail: {
          from: "IN_PROGRESS",
          to: returnedStatus,
          repo: expired.repo,
          expired_at: expired.expiresAt,
        },
      });
    }
    if (task.lease) {
      fail(
        task.lease.repo === this.repo ? "already_claimed" : "task_locked",
        `Task sudah dipegang sesi lain sampai ${task.lease.expiresAt}. Tunggu lease habis atau minta orchestrator melepasnya.`,
        { lease_expires_at: task.lease.expiresAt },
      );
    }
    if (!claimable(task))
      fail(
        "task_not_claimable",
        `Task berstatus ${task.status}; hanya TODO atau REVISION_REQUESTED yang bisa diambil.`,
      );
    if (task.target && task.target !== this.repo)
      fail("wrong_repo", `Task ini untuk repo "${task.target}".`);
    if (!this.readyByDeps(task)) fail("dependencies_pending", "Dependensi task belum DONE.");
    if (owner && owner.alias !== persona?.alias)
      fail("persona_mismatch", `Gunakan persona "${owner.alias}" untuk claim task ini.`);
    if (
      !owner &&
      task.role &&
      (persona?.role ?? this.config.overrides?.default_role) &&
      task.role !== (persona?.role ?? this.config.overrides?.default_role)
    ) {
      fail("persona_mismatch", `Task ini untuk role "${task.role}".`);
    }
    if (!allowsRepo(owner ?? persona, this.repo))
      fail("persona_repo_mismatch", `Persona tidak memegang repo "${this.repo}".`);
    if (task.branch && (task.branch.repo !== this.repo || task.branch.name !== worktree?.branch)) {
      fail(
        "reserved_branch",
        `Ambil kembali task di repo "${task.branch.repo}" pada branch "${task.branch.name}" dengan mode worktree.`,
      );
    }
    for (const other of this.tasks.values()) {
      if (other.id === task.id) continue;
      if (other.lease?.repo === this.repo && (!worktree || !other.lease.worktree)) {
        fail("repo_busy", `Repo "${this.repo}" masih memegang task aktif.`, { task_id: other.id });
      }
      if (worktree && other.lease?.worktree?.session === worktree.session_id)
        fail("session_busy", "Sesi worktree ini masih memegang task lain.");
      if (worktree && other.branch?.repo === this.repo && other.branch.name === worktree.branch)
        fail("branch_busy", "Branch ini sudah direservasi oleh task lain.");
    }
    if (
      !worktree &&
      (this.config.layout === "monorepo" ||
        this.project.tasks.some((row) => row.branch?.repo === this.repo))
    ) {
      fail(
        "worktree_required",
        "Proyek monorepo atau repo dengan reservasi branch wajib claim dalam mode worktree.",
      );
    }
    const revision =
      task.status === "REVISION_REQUESTED"
        ? { review_feedback: task.feedback ?? "", previous_handoff: task.handoff ?? null }
        : undefined;
    const fromStatus = task.status;
    advance(task, "claim");
    const leaseId = randomUUID();
    const expiry = leaseEnd(this.now);
    task.lease = {
      id: leaseKey(leaseId),
      repo: this.repo,
      expiresAt: expiry,
      ...(alias ? { alias } : {}),
      ...(worktree
        ? {
            worktree: {
              session: worktree.session_id,
              ...(worktree.worktree_path ? { worktree_path: worktree.worktree_path } : {}),
              ...(worktree.base_branch ? { base_branch: worktree.base_branch } : {}),
            },
          }
        : {}),
    };
    if (worktree) {
      task.branch = {
        repo: this.repo,
        name: worktree.branch,
        ...(worktree.worktree_path ? { worktree_path: worktree.worktree_path } : {}),
        ...(worktree.base_branch ? { base_branch: worktree.base_branch } : {}),
      };
    }
    this.recordEvent({
      task_id: task.id,
      event: "claim",
      actor: persona?.alias ?? alias ?? this.caller,
      note: worktree ? `branch=${worktree.branch}` : null,
      detail: {
        from: fromStatus,
        to: task.status,
        repo: this.repo,
        ...(worktree ? { branch: worktree.branch, session: worktree.session_id } : {}),
      },
    });
    const context =
      input.include_context === true
        ? snapshotClaimContext({
            project: this.project,
            task,
            db: this.db,
            projectId: this.config.project_id,
            graphRootDirs: () => this.graphRootDirs(),
          })
        : undefined;
    this.dirty();
    const result = claimResponse({
      task,
      tasks: this.tasks,
      persona,
      leaseId,
      expiry,
      compact: Boolean(input.compact),
      revision,
    });
    return { result, context };
  }

  /** Hanya holder dengan token lease yang cocok (hash di state) yang boleh memperbarui task. */
  private held(taskId: string, leaseId: string): LocalTask {
    const task = this.task(taskId);
    if (task.lease?.repo !== this.repo || !leaseMatches(task.lease.id, leaseId)) {
      fail(
        "not_lock_holder",
        "Task ini tidak sedang Anda pegang. Ambil ulang dengan claim_task bila lease sudah habis.",
      );
    }
    return task;
  }

  private release(input: Parsed<"release_task">): McpToolOutput<"release_task"> {
    const task = this.held(input.task_id, input.lease_id);
    const fromStatus = task.status;
    const actor = task.lease?.alias ?? task.persona ?? this.caller;
    const status = returnClaim(task);
    this.recordEvent({
      task_id: task.id,
      event: "release",
      actor,
      detail: { from: fromStatus, to: status, repo: this.repo },
    });
    this.dirty();
    return { status, task_id: task.id };
  }

  private block(input: Parsed<"report_blocker">): McpToolOutput<"report_blocker"> {
    const task = this.held(input.task_id, input.lease_id);
    const fromStatus = task.status;
    const actor = task.lease?.alias ?? task.persona ?? this.caller;
    advance(task, "report_blocker");
    task.blocker = { category: input.category, reason: input.reason };
    endLease(task);
    this.recordEvent({
      task_id: task.id,
      event: "blocker",
      actor,
      note: `[${input.category}] ${input.reason}`,
      detail: {
        from: fromStatus,
        to: task.status,
        category: input.category,
        reason: input.reason,
      },
    });
    this.dirty();
    return { status: "BLOCKED", task_id: task.id };
  }

  private handoff(input: Parsed<"complete_handoff">): McpToolOutput<"complete_handoff"> {
    const task = this.held(input.task_id, input.lease_id);
    const handoff = input.handoff_summary;
    if (task.branch && task.branch.name !== handoff.git_branch)
      fail("branch_mismatch", `Kirim handoff dari branch "${task.branch.name}".`);
    const run = this.taskRun(task);
    if (run) {
      this.assertHealthy(run);
      if (
        handoff.pull_request ||
        !fullSha.test(handoff.last_commit_hash) ||
        localCommit(this.root, runBranch(task.epicId, task.id)) !== handoff.last_commit_hash
      ) {
        fail(
          "run_handoff",
          "Run handoff needs the current local branch tip (full SHA), without PR metadata.",
        );
      }
      try {
        runTaskChanges(this.root, run, this.project, task, handoff.last_commit_hash);
      } catch (error) {
        if (
          !(error instanceof LocalServiceError) ||
          !["run_scope", "run_risk"].includes(error.code)
        )
          throw error;
        this.pauseRun(run, error.message);
        this.runs.push(run);
      }
    }
    const fromStatus = task.status;
    const actor = task.lease?.alias ?? task.persona ?? this.caller;
    advance(task, "complete");
    task.handoff = handoff;
    if (handoff.pull_request) {
      task.review = {
        ref: handoff.pull_request,
        repo: this.repo,
        author: task.lease?.alias ?? null,
        updatedAt: this.iso,
        approvedLocally: false,
      };
    } else delete task.review;
    endLease(task);
    this.recordEvent({
      task_id: task.id,
      event: "handoff",
      actor,
      note: handoff.notes_for_next_agent,
      detail: {
        from: fromStatus,
        to: task.status,
        git_branch: handoff.git_branch,
        last_commit_hash: handoff.last_commit_hash,
        files_count: handoff.files_modified.length,
        ...(handoff.pull_request?.url ? { pr_url: handoff.pull_request.url } : {}),
      },
    });
    this.dirty();
    return {
      task_id: task.id,
      status: "NEEDS_REVIEW",
      unlocked_task_ids: [],
      next_step_hint: `Handoff dicatat. Task hilir menunggu approve lokal.${handoff.pull_request ? ` ${offlineReview}` : ""}`,
    };
  }

  manageTask(input: Parsed<"manage_task">, snapshot?: string): McpToolOutput<"manage_task"> {
    const task = this.task(input.task_id);
    if (snapshot !== undefined) {
      if (
        !ApprovalSnapshotSchema.safeParse(snapshot).success ||
        (input.action !== "approve_plan" && input.action !== "approve")
      ) {
        fail("invalid_input", "Snapshot hanya berlaku untuk persetujuan rencana atau handoff.");
      }
      if (task.stale || this.approvalSnapshot(task, input.action) !== snapshot) {
        fail(
          "stale_approval",
          "Task berubah atau ditandai stale. Tinjau ulang dan minta persetujuan baru.",
        );
      }
    }
    if (task.archived_at) fail("already_archived", "Restore epic before editing archived task.");
    const run = this.taskRun(task);
    if (run) {
      this.assertHealthy(run);
      if (input.action === "approve") {
        if (run.plan.repo !== this.repo) fail("wrong_repo", "Run belongs to another repo.");
        if (!acceptedReview(run, task))
          fail(
            "run_review",
            "Record delegated acceptance before requesting separate human handoff approval.",
          );
      } else {
        fail(
          "run_state",
          "Record revisions through epic run review; close the run for manual governance changes.",
        );
      }
    }
    const fromStatus = task.status;
    let stale: string[] = [];
    let unlocked: string[] | undefined;
    if (input.action === "assign" || input.action === "request_revision") {
      if (input.action === "request_revision")
        stale = reviseTask(
          task,
          this.tasks.values(),
          input.feedback ?? fail("invalid_input", "Feedback revisi wajib."),
          this.iso,
        );
      else if (task.status !== "DRAFT" && !claimable(task) && task.status !== "BLOCKED")
        fail(
          "task_not_assignable",
          "Task aktif atau sudah diserahkan; gunakan request_revision setelah handoff.",
        );
      if (input.agent_alias) this.owner(task, this.persona(input.agent_alias), task.role);
      else if (input.agent_alias === null)
        this.owner(task, undefined, input.role === undefined ? task.role : input.role);
      else if (input.role !== undefined) {
        const current = task.persona ? this.persona(task.persona) : undefined;
        this.owner(
          task,
          current?.role === input.role ? current : this.personaFor(input.role, task.target),
          input.role,
        );
      }
      if (input.action === "request_revision") {
        this.recordEvent({
          task_id: task.id,
          event: "revision",
          actor: this.caller,
          note: input.feedback,
          detail: {
            from: fromStatus,
            to: task.status,
            revision_count: task.revision,
            stale_count: stale.length,
          },
        });
      } else {
        this.recordEvent({
          task_id: task.id,
          event: "assign",
          actor: this.caller,
          note: task.persona ? `@${task.persona}` : task.role ? `role:${task.role}` : "unassigned",
          detail: { persona: task.persona, role: task.role },
        });
      }
    } else {
      advance(task, input.action);
      if (input.action === "approve") {
        if (task.review) {
          task.review.approvedLocally = true;
          task.review.updatedAt = this.iso;
          delete task.review.lease;
        }
        delete task.branch;
        unlocked = this.project.tasks
          .filter((child) => child.dependencies.includes(task.id) && this.readyByDeps(child))
          .map((child) => child.id);
      } else if (input.action === "unblock") {
        delete task.blocker;
        if (task.handoff) task.status = "REVISION_REQUESTED";
      }
      this.recordEvent({
        task_id: task.id,
        event: input.action,
        actor: this.caller,
        note: unlocked?.length ? `unlocked ${unlocked.length} task(s)` : null,
        detail: {
          from: fromStatus,
          to: task.status,
          ...(unlocked?.length ? { unlocked_task_ids: unlocked } : {}),
          ...(snapshot !== undefined ? { dispatch: "conditional_cli" } : {}),
        },
      });
    }
    this.dirty();
    return {
      task_id: task.id,
      status: task.status,
      persona: task.persona,
      role: task.role,
      revision_count: task.revision,
      stale_task_ids: stale,
      ...(unlocked ? { unlocked_task_ids: unlocked } : {}),
    };
  }

  private document(input: Parsed<"get_document">): McpToolOutput<"get_document"> {
    const doc =
      this.project.documents.find((row) => row.slug === input.slug) ??
      fail("not_found", `Dokumen "${input.slug}" tidak ditemukan di proyek ini.`);
    if (input.outline_only) {
      return {
        ...doc,
        content: "",
        outline: extractMarkdownOutline(doc.content),
        truncated: doc.content.length > 0,
      };
    }
    if (input.section !== undefined) {
      const matched = extractMarkdownSection(doc.content, input.section);
      if (!matched) {
        fail("not_found", `Bagian "${input.section}" tidak ditemukan di dokumen "${input.slug}".`, {
          outline: extractMarkdownOutline(doc.content),
        });
      }
      return {
        ...doc,
        content: matched.content,
        section: matched.title,
        truncated: matched.truncated,
      };
    }
    return doc;
  }

  private saveDocument(input: Parsed<"save_document">): McpToolOutput<"save_document"> {
    const existing = this.project.documents.find((doc) => doc.slug === input.slug);
    const current = existing?.version ?? 0;
    if ((input.expected_version ?? 0) !== current) {
      fail(
        "document_version_conflict",
        `Dokumen "${input.slug}" saat ini versi ${current}. Baca ulang lalu kirim expected_version yang sesuai (0 = baru).`,
        { current_version: current },
      );
    }
    if (!existing && this.project.documents.length >= DOCUMENT_LIMITS.perProject)
      fail("document_limit", `Maksimal ${DOCUMENT_LIMITS.perProject} dokumen per proyek.`);
    const doc: ProjectDocument = {
      slug: input.slug,
      title: input.title,
      kind: input.kind,
      content: input.content,
      version: current + 1,
      updated_at: this.iso,
      updated_by: `local@${this.repo}`,
      size: input.content.length,
      archived_at: existing?.archived_at ?? null,
    };
    if (existing) Object.assign(existing, doc);
    else this.project.documents.push(doc);
    this.dirty();
    return { document: recordIndex(doc), created: !existing };
  }

  private archiveDocument(input: Parsed<"archive_document">): McpToolOutput<"archive_document"> {
    const existing =
      this.project.documents.find((doc) => doc.slug === input.slug) ??
      fail("not_found", `Dokumen "${input.slug}" tidak ditemukan di proyek ini.`);
    if (isDocumentArchived(existing)) {
      fail("already_archived", `Dokumen "${input.slug}" sudah diarsipkan.`);
    }
    Object.assign(existing, {
      archived_at: this.iso,
      updated_at: this.iso,
      updated_by: `local@${this.repo}`,
      version: existing.version + 1,
    });
    this.dirty();
    return { document: recordIndex(existing) };
  }

  private restoreDocument(input: Parsed<"restore_document">): McpToolOutput<"restore_document"> {
    const existing =
      this.project.documents.find((doc) => doc.slug === input.slug) ??
      fail("not_found", `Dokumen "${input.slug}" tidak ditemukan di proyek ini.`);
    if (!isDocumentArchived(existing)) {
      fail("not_archived", `Dokumen "${input.slug}" tidak diarsipkan.`);
    }
    Object.assign(existing, {
      archived_at: null,
      updated_at: this.iso,
      updated_by: `local@${this.repo}`,
      version: existing.version + 1,
    });
    this.dirty();
    return { document: recordIndex(existing) };
  }

  private async search(input: Parsed<"search_context">): Promise<McpToolOutput<"search_context">> {
    const items: LocalSearchItem[] = [];
    const sources = new Set(input.sources);
    if (sources.has("document"))
      for (const doc of filterVisibleDocuments(this.project.documents, input.include_archived))
        items.push({ source: "document", ref: doc.slug, title: doc.title, text: doc.content });
    if (sources.has("task"))
      for (const task of filterVisibleTasks(
        this.project.tasks,
        this.project.epics,
        input.include_archived,
      ))
        items.push({
          source: "task",
          ref: task.id,
          title: task.title,
          text: [task.instruction, task.feedback].filter(Boolean).join("\n"),
        });
    if (sources.has("skill")) {
      const catalog = await discoverSkillCatalog(this.root, {
        platforms: this.config.platforms,
      });
      for (const skill of catalog.entries)
        items.push({
          source: "skill",
          ref: skill.collision
            ? `${this.repo}:${skill.source_id}:${skill.name}`
            : `${this.repo}:${skill.name}`,
          title: skill.name,
          text: `${skill.when_to_use} ${skill.source_path}`,
        });
    }
    const contextHits = items.length ? searchLocalContext(input.query, items, input.limit) : [];
    let codeHits: SearchHit[] = [];
    let degraded = false;
    if (sources.has("code")) {
      const rootOpts = {
        roots: (this.project.workspace_roots ?? []).map((r) => ({
          id: r.id,
          path: r.path,
          label: r.label,
        })),
      };
      try {
        const res = await searchLocalCode(this.root, input.query, input.limit, {
          ...rootOpts,
          db: this.db,
          projectId: this.config.project_id,
        });
        codeHits = res.hits;
        degraded = res.degraded;
        if (codeHits.length === 0) {
          codeHits = await keywordFallback(this.root, input.query, input.limit, rootOpts);
        }
      } catch {
        degraded = true;
        codeHits = await keywordFallback(this.root, input.query, input.limit, rootOpts);
      }
    }
    const hits = [...contextHits, ...codeHits]
      .sort(
        (a, b) =>
          b.score - a.score || a.source.localeCompare(b.source) || a.ref.localeCompare(b.ref),
      )
      .slice(0, input.limit);
    return {
      hits,
      reranked: false,
      degraded,
    };
  }
}
