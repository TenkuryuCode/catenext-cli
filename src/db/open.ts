import { accessSync, chmodSync, constants, existsSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runSchemaMigrations } from "./migrate.js";

export interface OpenDatabaseOptions {
  readOnly?: boolean;
}

export interface CheckpointOptions {
  busyTimeoutMs?: number;
}

export interface CheckpointFileOptions extends CheckpointOptions {
  onlyIfSidecarExists?: boolean;
}

export interface CheckpointResult {
  ok: boolean;
  busy: boolean;
  log: number;
  checkpointed: number;
  skippedReason?: "memory" | "missing" | "non_regular" | "no_sidecar" | "busy" | "readonly";
}

function isInMemoryPath(file: string): boolean {
  return file === ":memory:" || file.startsWith("file::memory:");
}

function boundedBusyTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return 250;
  return Math.max(0, Math.min(5000, Math.floor(ms)));
}

function classifyBusyOrReadonlyError(error: unknown): "busy" | "readonly" | null {
  if (!(error instanceof Error)) return null;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "readonly";

  const errcode =
    "errcode" in error && typeof error.errcode === "number" ? error.errcode : undefined;
  if (errcode !== undefined) {
    const base = errcode & 0xff;
    if (base === 5 || base === 6) return "busy";
    // 8 = SQLITE_READONLY; 778 = SQLITE_IOERR_WRITE (often raised on 0o400 WAL files)
    if (base === 8 || errcode === 778) return "readonly";
  }

  if (/database is locked|sqlite_busy|busy/i.test(error.message)) return "busy";
  if (/readonly|read-only|sqlite_readonly|attempt to write a readonly/i.test(error.message)) {
    return "readonly";
  }
  return null;
}

export function ensureDatabasePermissions(file: string): void {
  if (isInMemoryPath(file)) return;
  for (const target of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(target, 0o600);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTSUP")
      ) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Run a bounded `PRAGMA wal_checkpoint(TRUNCATE)` on an open SQLite handle.
 * Gracefully ignores `SQLITE_BUSY` and read-only states without throwing.
 */
export function checkpointWal(db: DatabaseSync, options: CheckpointOptions = {}): CheckpointResult {
  const timeoutMs = boundedBusyTimeout(options.busyTimeoutMs);
  try {
    db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;
    const busy = (row?.busy ?? 0) !== 0;
    return {
      ok: !busy,
      busy,
      log: row?.log ?? 0,
      checkpointed: row?.checkpointed ?? 0,
      ...(busy ? { skippedReason: "busy" as const } : {}),
    };
  } catch (error) {
    const reason = classifyBusyOrReadonlyError(error);
    if (reason) {
      return {
        ok: false,
        busy: reason === "busy",
        log: 0,
        checkpointed: 0,
        skippedReason: reason,
      };
    }
    throw error;
  }
}

/** Checkpoint WAL cleanly (ignoring busy/read-only) and close the database handle. */
export function checkpointWalAndClose(
  db: DatabaseSync,
  options: CheckpointOptions = {},
): CheckpointResult {
  try {
    return checkpointWal(db, options);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore close errors */
    }
  }
}

/**
 * Best-effort bounded WAL checkpoint for a SQLite file path on shutdown.
 * Never creates a missing database file and never fails caller exit on busy/read-only state.
 */
export function checkpointDatabaseFile(
  file: string,
  options: CheckpointFileOptions = {},
): CheckpointResult {
  if (isInMemoryPath(file)) {
    return { ok: true, busy: false, log: 0, checkpointed: 0, skippedReason: "memory" };
  }

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: true, busy: false, log: 0, checkpointed: 0, skippedReason: "missing" };
    }
    const reason = classifyBusyOrReadonlyError(error);
    if (reason) {
      return {
        ok: false,
        busy: reason === "busy",
        log: 0,
        checkpointed: 0,
        skippedReason: reason,
      };
    }
    throw error;
  }

  if (!stat.isFile() || stat.nlink !== 1) {
    return { ok: false, busy: false, log: 0, checkpointed: 0, skippedReason: "non_regular" };
  }

  if (options.onlyIfSidecarExists && !existsSync(`${file}-wal`) && !existsSync(`${file}-shm`)) {
    return { ok: true, busy: false, log: 0, checkpointed: 0, skippedReason: "no_sidecar" };
  }

  try {
    accessSync(file, constants.W_OK);
  } catch (error) {
    const reason = classifyBusyOrReadonlyError(error);
    if (reason) {
      return { ok: false, busy: false, log: 0, checkpointed: 0, skippedReason: reason };
    }
    throw error;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    const result = checkpointWal(db, options);
    if (result.ok) {
      try {
        ensureDatabasePermissions(file);
      } catch (permError) {
        const reason = classifyBusyOrReadonlyError(permError);
        if (!reason) throw permError;
      }
    }
    return result;
  } catch (error) {
    const reason = classifyBusyOrReadonlyError(error);
    if (reason) {
      return {
        ok: false,
        busy: reason === "busy",
        log: 0,
        checkpointed: 0,
        skippedReason: reason,
      };
    }
    throw error;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

export function openDatabaseAt(file: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const readOnly = Boolean(options.readOnly);
  const db = readOnly ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    if (readOnly) {
      return db;
    }
    if (!isInMemoryPath(file)) {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
      if (mode?.journal_mode?.toLowerCase() !== "wal") {
        db.exec("PRAGMA journal_mode = WAL");
      }
      ensureDatabasePermissions(file);
    }
    runSchemaMigrations(db);
    ensureDatabasePermissions(file);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      /* ignore close errors */
    }
    throw error;
  }
}
