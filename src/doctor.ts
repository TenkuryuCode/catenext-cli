import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  CONFIG_PATH,
  configuredPlatforms,
  findProjectRoot,
  isMissingFile,
  parseConfig,
  stateFilePath,
} from "./config.js";
import {
  entryMatchesRoot,
  inspectMcp,
  selectedAdapters,
  WINDSURF_UNSUPPORTED,
} from "./init/mcp-config.js";
import { readRepoFile } from "./init/repo-files.js";
import { entryIsStale } from "./maintenance.js";
import {
  type CheckLine,
  formatNextFixTips,
  inspectLocalSkills,
  inspectOnboardingArtifacts,
} from "./verify.js";
import { readGitWorktreeRegistrations } from "./worktrees.js";

type Status = "ok" | "warning" | "error" | "skipped" | "fixed";

type Finding = {
  id: string;
  status: Status;
  message: string;
  path?: string;
};

type DoctorReport = { ok: boolean; checks: Finding[]; nextFix: string };

const ARTIFACT_OK: Record<string, string> = {
  "artifacts.master": "CATENEXT.md master prompt is present.",
  "artifacts.agents": "AGENTS.md contains the Catenext orchestrator block.",
};

const ARTIFACT_WARN: Record<string, string> = {
  "artifacts.master": "CATENEXT.md is missing or not Catenext-managed.",
  "artifacts.agents": "AGENTS.md is missing the Catenext orchestrator block.",
};

function artifactPath(label: string): string | undefined {
  const idx = label.indexOf(": ");
  return idx === -1 ? undefined : label.slice(idx + 2);
}

function artifactFinding(line: CheckLine): Finding {
  const id = line.id ?? "artifacts";
  const path = artifactPath(line.label);
  if (line.ok) {
    const message =
      ARTIFACT_OK[id] ??
      (id.startsWith("artifacts.entry.")
        ? "Platform entry pointer is present."
        : id.includes("orchestrator")
          ? "Orchestrator stub is present."
          : "Persona stub is present.");
    return finding(id, "ok", message, path);
  }
  const message =
    ARTIFACT_WARN[id] ??
    (id.startsWith("artifacts.entry.")
      ? "Platform entry pointer is missing or not Catenext-managed."
      : id.includes("orchestrator")
        ? "Orchestrator stub is missing or not Catenext-managed."
        : "Persona stub is missing or not Catenext-managed.");
  return finding(id, "warning", message, path);
}

function skillFinding(line: CheckLine): Finding {
  const id = line.id ?? "skills";
  const path = artifactPath(line.label);
  if (line.ok) {
    const count = line.label.replace(/^Skill lokal valid: /, "");
    return finding(id, "ok", `Local skills are valid (${count}).`, path);
  }
  return finding(id, "warning", line.hint ?? "Invalid local skill.", path);
}

function mcpFixKey(message: string): CheckLine["fixKey"] | undefined {
  if (message.includes("sync --fix")) return "sync-fix";
  if (message.includes("entry missing")) return "init";
  if (message.includes("sync --dry-run")) return "sync";
  return undefined;
}

function collectDoctorFixLines(fixLines: CheckLine[], checks: Finding[]): CheckLine[] {
  const lines = fixLines.filter((line) => !line.ok);
  for (const { id, status, message } of checks) {
    if (
      (status !== "warning" && status !== "error") ||
      id.startsWith("artifacts.") ||
      id.startsWith("skills.")
    ) {
      continue;
    }
    const fixKey = mcpFixKey(message);
    if (fixKey) lines.push({ ok: false, label: id, fixKey });
  }
  return lines;
}

function finding(id: string, status: Status, message: string, path?: string): Finding {
  return { id, status, message, ...(path ? { path } : {}) };
}

function supportsSnapshot(db: DatabaseSync): db is DatabaseSync & {
  deserialize(snapshot: Uint8Array): void;
} {
  return "deserialize" in db && typeof db.deserialize === "function";
}

const SQLITE_MAGIC = "SQLite format 3\0";
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const LOCK_AGE_MS = 30_000;

async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function plainFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1;
}

async function openRegular(path: string, expected: Stats): Promise<FileHandle> {
  if (!plainFile(expected)) throw new Error("Expected a regular, unlinked file");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!plainFile(stat) || stat.ino !== expected.ino || stat.dev !== expected.dev) {
      throw new Error("File changed while opening");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function checkLock(path: string): Promise<Finding> {
  const id = "sqlite.lock";
  try {
    const stat = await statIfPresent(path);
    if (!stat) return { id, status: "ok", message: "No state lock." };
    const unknown = {
      id,
      status: "warning",
      message:
        "Unrecognized state lock. Confirm no Catenext process is using it before manual recovery.",
    } as const;
    if (!plainFile(stat) || stat.size > 4096) return unknown;
    const handle = await openRegular(path, stat);
    try {
      const bytes = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(bytes);
      const data: unknown = JSON.parse(bytes.toString("utf8", 0, bytesRead));
      if (!data || typeof data !== "object" || !("pid" in data) || !("startedAt" in data)) {
        return unknown;
      }
      const { pid, startedAt } = data;
      if (
        typeof pid !== "number" ||
        !Number.isInteger(pid) ||
        pid < 1 ||
        pid > 0x7fffffff ||
        typeof startedAt !== "string" ||
        !Number.isFinite(Date.parse(startedAt))
      ) {
        return unknown;
      }
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
          return {
            id,
            status: "warning",
            message:
              "Stale state lock: owner process no longer exists. Normal CLI writes recover stale locks.",
          };
        }
        return unknown;
      }
      return Date.now() - Date.parse(startedAt) >= LOCK_AGE_MS
        ? {
            id,
            status: "warning",
            message: "State lock is old but its owner still exists. Do not remove it while in use.",
          }
        : { id, status: "ok", message: "State lock owner is active." };
    } finally {
      await handle.close();
    }
  } catch {
    return {
      id,
      status: "warning",
      message:
        "Cannot inspect state lock. Check access and confirm no Catenext process is using it.",
    };
  }
}

async function hasJournal(file: string): Promise<boolean> {
  const entries = await Promise.all(
    ["-wal", "-shm", "-journal", ".lock"].map((suffix) => statIfPresent(file + suffix)),
  );
  return entries.some(Boolean);
}

/** Never open the original in SQLite: a read-only WAL connection can still write SHM. */
async function checkIntegrity(file: string, handle: FileHandle): Promise<Finding> {
  const id = "sqlite.integrity";
  const busy = {
    id,
    status: "skipped",
    message:
      "State has a journal or lock, or changed during inspection. Close Catenext clients and retry after their journals are checkpointed; do not remove sidecars manually.",
  } as const;
  try {
    const before = await handle.stat({ bigint: true });
    if (await hasJournal(file)) return busy;
    if (before.size > MAX_SNAPSHOT_BYTES) {
      return {
        id,
        status: "skipped",
        message:
          "State exceeds doctor’s 64 MiB snapshot limit. Run SQLite integrity_check on a consistent backup.",
      };
    }
    const snapshot = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < snapshot.length; ) {
      const { bytesRead } = await handle.read(snapshot, offset, snapshot.length - offset, offset);
      if (!bytesRead) return busy;
      offset += bytesRead;
    }
    if (await hasJournal(file)) return busy;
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      current.ino !== after.ino ||
      current.dev !== after.dev
    )
      return busy;

    const db = new DatabaseSync(":memory:");
    try {
      if (!supportsSnapshot(db)) {
        return finding(
          id,
          "skipped",
          "This Node version cannot open an in-memory SQLite snapshot. Upgrade Node or run SQLite integrity_check on a consistent backup.",
        );
      }
      // sqlite3_deserialize requires rollback format. Change only the journal-free copy;
      // never interpret a main file with live or uncheckpointed WAL as complete.
      if (snapshot[18] === 2 && snapshot[19] === 2) {
        snapshot[18] = 1;
        snapshot[19] = 1;
      }
      db.deserialize(snapshot);
      return db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check === "ok"
        ? finding(id, "ok", "SQLite integrity check passed on a journal-free snapshot.")
        : finding(
            id,
            "error",
            "SQLite integrity check failed. Preserve state and restore from a known-good backup.",
          );
    } catch {
      return finding(
        id,
        "error",
        "SQLite could not check the snapshot. Preserve state and validate a backup.",
      );
    } finally {
      db.close();
    }
  } catch {
    return {
      id,
      status: "skipped",
      message:
        "Could not read a stable SQLite snapshot. Check state access or validate a consistent backup.",
    };
  }
}

async function checkSqlite(file: string, fix: boolean): Promise<Finding[]> {
  const checks: Finding[] = [await checkLock(`${file}.lock`)];
  try {
    const stat = await statIfPresent(file);
    if (!stat)
      return [
        ...checks,
        {
          id: "sqlite.file",
          status: "skipped",
          message: "No SQLite state yet. Initialize the project or verify state_file.",
        },
      ];
    const handle = await openRegular(file, stat);
    try {
      const bytes = Buffer.alloc(100);
      const { bytesRead } = await handle.read(bytes);
      if (bytesRead !== bytes.length || bytes.toString("ascii", 0, 16) !== SQLITE_MAGIC) {
        return [
          ...checks,
          {
            id: "sqlite.file",
            status: "error",
            message: "Invalid SQLite header. Verify state_file and preserve the file for recovery.",
          },
        ];
      }
      const mode = bytes[18] === 2 && bytes[19] === 2;
      checks.push({
        id: "sqlite.wal",
        status: mode ? "ok" : "warning",
        message: mode
          ? "SQLite header declares WAL mode."
          : "SQLite header does not declare WAL mode. Normal Catenext writes enable WAL.",
      });
      const id = "sqlite.permissions";
      const modeOk = process.platform === "win32" || (stat.mode & 0o7777) === 0o600;
      if (modeOk) {
        checks.push({
          id,
          status: "ok",
          message: "SQLite state file permissions are private or not applicable on this platform.",
        });
      } else if (fix && stat.uid === process.getuid?.() && (stat.mode & 0o600) === 0o600) {
        try {
          const current = await handle.stat();
          const named = await lstat(file);
          if (
            !plainFile(current) ||
            !plainFile(named) ||
            current.uid !== stat.uid ||
            (current.mode & 0o600) !== 0o600 ||
            named.dev !== current.dev ||
            named.ino !== current.ino
          )
            throw new Error("State file changed");
          await handle.chmod(0o600);
          checks.push({
            id,
            status: "fixed",
            message: "Set owned SQLite state file mode to 0600.",
          });
        } catch {
          checks.push({
            id,
            status: "error",
            message:
              "Could not safely set SQLite mode to 0600. Verify the state path and ownership.",
          });
        }
      } else {
        checks.push({
          id,
          status: "error",
          message:
            "SQLite state file mode must be 0600. Doctor --fix only removes extra access on an owned file; ask the owner to repair other modes.",
        });
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const sidecar = await statIfPresent(file + suffix);
        if (
          sidecar &&
          (!plainFile(sidecar) ||
            (process.platform !== "win32" && (sidecar.mode & 0o7777) !== 0o600))
        ) {
          checks.push({
            id: "sqlite.sidecar_permissions",
            status: "error",
            message: `Unsafe SQLite ${suffix.slice(1)} sidecar type or mode. Close Catenext clients and check the sidecar; doctor does not modify it.`,
          });
        }
      }
      // Avoid persisting a snapshot of state with unsafe permissions outside the project.
      if (!checks.some((check) => check.status === "error"))
        checks.push(await checkIntegrity(file, handle));
      else
        checks.push({
          id: "sqlite.integrity",
          status: "skipped",
          message: "Resolve SQLite file permission errors before running integrity checks.",
        });
    } finally {
      await handle.close();
    }
  } catch {
    checks.push({
      id: "sqlite.file",
      status: "error",
      message:
        "Cannot inspect state. Verify access and use a regular SQLite file, not a link or special file.",
    });
  }
  return checks;
}

async function checkWorktrees(root: string): Promise<Finding> {
  const id = "git.worktrees";
  try {
    // Full lifecycle inventory opens the live SQLite DB, which can create WAL sidecars.
    // Doctor reports Git registrations only, independent of SQLite availability or schema.
    const trees = await readGitWorktreeRegistrations(root);
    const count = trees.filter(({ prunable }) => prunable).length;
    return count > 0
      ? finding(
          id,
          "warning",
          `Git reports ${count} prunable worktree registration(s). This is separate from managed cleanup eligibility; doctor never prunes. Review with git worktree list --porcelain.`,
        )
      : finding(id, "ok", "Git reports no prunable worktree registrations.");
  } catch {
    return finding(
      id,
      "skipped",
      "Cannot list Git worktrees. Check Git availability and repository access.",
    );
  }
}

async function checkMcp(
  root: string,
  platforms: ReturnType<typeof configuredPlatforms>,
): Promise<Finding[]> {
  if (!platforms.length) return [finding("mcp.config", "skipped", "No MCP platforms configured.")];
  const checks: Finding[] = [];
  for (const platform of platforms) {
    const id = `mcp.${platform}`;
    if (platform === "windsurf") {
      checks.push(finding(id, "skipped", WINDSURF_UNSUPPORTED));
      continue;
    }
    try {
      for (const adapter of await selectedAdapters(root, [platform])) {
        const check = (status: Status, message: string) =>
          finding(id, status, message, adapter.path);
        try {
          const { count, managed, entry, compatible } = inspectMcp(
            await readRepoFile(root, adapter.path),
            adapter,
          );
          if (!count)
            checks.push(
              check("warning", "Catenext MCP entry missing. Review with catenext sync --dry-run."),
            );
          else if (!managed || !entry)
            checks.push(check("warning", "Unmanaged Catenext MCP entry. Review it manually."));
          else if (
            count !== 1 ||
            !compatible ||
            !entryMatchesRoot(entry, root, adapter) ||
            entryIsStale(entry)
          ) {
            checks.push(
              check(
                "warning",
                "Duplicate, incompatible, unscoped, or stale Catenext MCP entry. Review with catenext sync --fix --dry-run.",
              ),
            );
          } else checks.push(check("ok", "Managed Catenext MCP entry matches this project."));
        } catch {
          // Do not echo input or parser errors: configs may contain credentials.
          checks.push(
            check("error", "Cannot read or parse workspace MCP config. Review it manually."),
          );
        }
      }
    } catch {
      checks.push(
        finding(
          id,
          "error",
          "Cannot locate workspace MCP config. Review access and file types manually.",
        ),
      );
    }
  }
  return checks;
}

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function exactRelease(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && RELEASE.test(value);
}

/** Compare the running build to a project-owned Catenext manifest or exact npm dependency. */
async function checkVersion(root: string, version: string): Promise<Finding> {
  const id = "cli.version";
  for (const path of ["apps/cli/package.json", "package.json"]) {
    const check = (status: Status, message: string) => finding(id, status, message, path);
    try {
      const source = await readRepoFile(root, path);
      if (source === null) continue;
      const manifest: unknown = JSON.parse(source);
      if (!manifest || typeof manifest !== "object") continue;
      let expected: unknown;
      if ("name" in manifest && manifest.name === "catenext") {
        expected = "version" in manifest ? manifest.version : undefined;
        if (!exactRelease(expected))
          return check("warning", "Project Catenext manifest has no valid release version.");
      } else if (path === "package.json") {
        for (const key of ["devDependencies", "dependencies"] as const) {
          const deps: unknown = (manifest as Record<string, unknown>)[key];
          if (
            deps &&
            typeof deps === "object" &&
            "catenext" in deps &&
            exactRelease(deps.catenext)
          ) {
            expected = deps.catenext;
            break;
          }
        }
      }
      if (!exactRelease(expected)) continue;
      if (version === "0.0.0-dev" || !exactRelease(version)) {
        return check(
          "skipped",
          "Running a development CLI. Build Catenext and run doctor using the built executable to compare versions.",
        );
      }
      return version === expected
        ? check("ok", "Running CLI matches the project's declared Catenext version.")
        : check(
            "warning",
            "Running CLI differs from the project's declared Catenext version. Compare catenext --version and use the matching build.",
          );
    } catch {
      return check(
        "skipped",
        "Cannot read project package metadata. Verify package.json and the running Catenext build.",
      );
    }
  }
  return finding(
    id,
    "skipped",
    "Project does not pin a Catenext version. Compare catenext --version with the version required by your team.",
  );
}

async function loadDoctorProject(cwd: string | undefined) {
  const root = await findProjectRoot(cwd);
  if (!root) return null;
  return { root, config: parseConfig((await readRepoFile(root, CONFIG_PATH)) ?? "") };
}

export async function runDoctor(options: {
  cwd?: string;
  fix?: boolean;
  version: string;
}): Promise<DoctorReport> {
  const id = "project.config";
  const project = await loadDoctorProject(options.cwd).catch(() => undefined);
  if (!project)
    return {
      ok: false,
      checks: [
        finding(
          id,
          "error",
          project === null
            ? "No .catenext/config.yaml found. Run doctor inside an initialized project."
            : "Cannot read or validate .catenext/config.yaml. Check access, format, and CLI compatibility.",
        ),
      ],
      nextFix: formatNextFixTips([
        { ok: false, label: id, fixKey: project === null ? "init" : undefined },
      ]),
    };
  const { root, config } = project;
  const platforms = configuredPlatforms(config);
  const skillLines = await inspectLocalSkills(root);
  // Snapshot persona reads avoid opening live SQLite (doctor must not create -shm).
  const artifactLines = await inspectOnboardingArtifacts(root, config, platforms, {
    personaStubs: "snapshot",
  });
  const checks = [
    finding(id, "ok", "Project config is readable and valid."),
    ...(await checkSqlite(stateFilePath(root, config), options.fix === true)),
    await checkWorktrees(root),
    ...(await checkMcp(root, platforms)),
    await checkVersion(root, options.version),
    ...skillLines.map(skillFinding),
    ...artifactLines.map(artifactFinding),
  ];
  const nextFix = formatNextFixTips(
    collectDoctorFixLines([...skillLines, ...artifactLines], checks),
  );
  return {
    ok: !checks.some(({ status }) => status === "error" || status === "warning"),
    checks,
    nextFix,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const body = report.checks
    .map(
      ({ id, status, message, path }) => `[${status}] ${id}${path ? ` (${path})` : ""}: ${message}`,
    )
    .join("\n");
  return report.nextFix ? `${body}\n\n${report.nextFix}` : body;
}
