import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMissingFile } from "./config.js";
import { getSchemaVersion } from "./db/migrate.js";
import { checkpointWalAndClose, ensureDatabasePermissions, openDatabaseAt } from "./db/open.js";
import { SCHEMA_VERSION } from "./db/schema.js";

const SQLITE_MAGIC = "SQLite format 3\0";
const REQUIRED_CATENEXT_TABLES = ["projects", "epics", "personas", "tasks", "documents"] as const;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export interface BackupResult {
  ok: true;
  out: string;
  bytes: number;
  mode: "0600" | null;
}

export interface RestoreResult {
  ok: true;
  from: string;
  stateFile: string;
  safetyBackup: string | null;
  schemaVersion: number;
  mode: "0600" | null;
}

export function escapeSqlStringLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new BackupError("Path must not contain NUL bytes.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

async function setPrivateMode(file: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTSUP") {
      return;
    }
    throw error;
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isPlainRegularFile(st: { isFile(): boolean; nlink: number }): boolean {
  return st.isFile() && st.nlink === 1;
}

async function verifySqliteHeader(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 16 || header.subarray(0, 16).toString("ascii") !== SQLITE_MAGIC) {
      throw new BackupError("Backup file is not a valid SQLite database.");
    }
  } finally {
    await handle.close();
  }
}

async function copyRegularFileSafely(srcPath: string, destPath: string): Promise<void> {
  const srcStat = await lstatIfPresent(srcPath);
  if (!srcStat) {
    throw new BackupError(`Backup file does not exist: ${srcPath}`);
  }
  if (!isPlainRegularFile(srcStat)) {
    throw new BackupError("Backup source must be a regular file, not a symlink or directory.");
  }

  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const srcHandle = await open(srcPath, flags);
  try {
    const openedStat = await srcHandle.stat();
    if (
      !isPlainRegularFile(openedStat) ||
      openedStat.ino !== srcStat.ino ||
      openedStat.dev !== srcStat.dev
    ) {
      throw new BackupError("Backup source changed or is not a regular file.");
    }
    const header = Buffer.alloc(100);
    const { bytesRead: hdrRead } = await srcHandle.read(header, 0, header.length, 0);
    if (hdrRead < 16 || header.subarray(0, 16).toString("ascii") !== SQLITE_MAGIC) {
      throw new BackupError("Backup file is not a valid SQLite database.");
    }

    const destHandle = await open(
      destPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await destHandle.write(header, 0, hdrRead, 0);
      const buf = Buffer.allocUnsafe(64 * 1024);
      let offset = hdrRead;
      while (true) {
        const { bytesRead } = await srcHandle.read(buf, 0, buf.length, offset);
        if (bytesRead === 0) break;
        await destHandle.write(buf, 0, bytesRead, offset);
        offset += bytesRead;
      }
    } finally {
      await destHandle.close();
    }
  } finally {
    await srcHandle.close();
  }
}

async function removeSidecars(file: string): Promise<void> {
  await Promise.all(
    ["-wal", "-shm", "-journal"].map((suffix) => rm(`${file}${suffix}`, { force: true })),
  );
}

function validateBackupDatabase(stagedPath: string): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(stagedPath);
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check?: string;
    }>;
    if (rows.length !== 1 || rows[0]?.integrity_check?.toLowerCase() !== "ok") {
      throw new BackupError("Backup file failed SQLite integrity_check.");
    }

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name?: string }>;
    const tables = new Set(tableRows.map((row) => row.name).filter(Boolean));
    for (const required of REQUIRED_CATENEXT_TABLES) {
      if (!tables.has(required)) {
        throw new BackupError(`Backup file is missing required Catenext table "${required}".`);
      }
    }

    const version = getSchemaVersion(db);
    if (version < 1 || version > SCHEMA_VERSION) {
      throw new BackupError(
        `Backup file has unsupported Catenext schema version ${version} (supported: 1..${SCHEMA_VERSION}).`,
      );
    }
    return version;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("Backup file could not be validated as a Catenext SQLite database.");
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

async function createSafetyBackup(stateFile: string): Promise<string> {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const candidate = `${stateFile}.bak.${stamp}`;
  const backupPath = (await lstatIfPresent(candidate))
    ? `${candidate}.${randomUUID().slice(0, 8)}`
    : candidate;

  let vacuumed = false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(stateFile);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`VACUUM INTO ${escapeSqlStringLiteral(backupPath)}`);
    vacuumed = true;
  } catch {
    await rm(backupPath, { force: true });
  } finally {
    if (db) {
      checkpointWalAndClose(db);
    }
  }

  if (!vacuumed) {
    await copyFile(stateFile, backupPath);
  }
  await setPrivateMode(backupPath);
  return backupPath;
}

export async function backupDatabase(opts: {
  stateFile: string;
  outPath: string;
  force?: boolean;
}): Promise<BackupResult> {
  const stateFile = resolve(opts.stateFile);
  const outPath = resolve(opts.outPath);

  if (outPath === stateFile) {
    throw new BackupError("Backup output path must differ from the active SQLite state file.");
  }

  const srcStat = await lstatIfPresent(stateFile);
  if (!srcStat) {
    throw new BackupError(`SQLite state file does not exist: ${stateFile}`);
  }
  if (!isPlainRegularFile(srcStat)) {
    throw new BackupError("SQLite state file must be a regular file, not a symlink or directory.");
  }
  await verifySqliteHeader(stateFile);

  const outStat = await lstatIfPresent(outPath);
  if (outStat) {
    if (!isPlainRegularFile(outStat)) {
      throw new BackupError(
        "Backup output path already exists and is not a regular file (refusing symlink or directory).",
      );
    }
    if (outStat.size > 0 && !opts.force) {
      throw new BackupError(
        `Backup target already exists (${outPath}). Pass --force to overwrite.`,
      );
    }
  }

  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${outPath}.tmp.${process.pid}.${randomUUID()}`;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(stateFile);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`VACUUM INTO ${escapeSqlStringLiteral(tmpPath)}`);
    await setPrivateMode(tmpPath);
    await rename(tmpPath, outPath);
    await setPrivateMode(outPath);
    const finalStat = await stat(outPath);
    return {
      ok: true,
      out: outPath,
      bytes: finalStat.size,
      mode: process.platform === "win32" ? null : "0600",
    };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("Failed to create SQLite backup snapshot.");
  } finally {
    if (db) {
      checkpointWalAndClose(db);
    }
    await rm(tmpPath, { force: true });
  }
}

export async function restoreDatabase(opts: {
  stateFile: string;
  fromPath: string;
  force?: boolean;
}): Promise<RestoreResult> {
  const stateFile = resolve(opts.stateFile);
  const fromPath = resolve(opts.fromPath);

  if (fromPath === stateFile) {
    throw new BackupError("Restore source must differ from the target SQLite state file.");
  }

  const targetDir = dirname(stateFile);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });

  const stagedPath = `${stateFile}.restore.${process.pid}.${randomUUID()}`;
  try {
    await copyRegularFileSafely(fromPath, stagedPath);
    await setPrivateMode(stagedPath);
    const schemaVersion = validateBackupDatabase(stagedPath);

    // Run any compatible schema migrations + WAL setup on staged file before swapping.
    const stagedDb = openDatabaseAt(stagedPath);
    checkpointWalAndClose(stagedDb);
    await removeSidecars(stagedPath);

    const existingTarget = await lstatIfPresent(stateFile);
    let safetyBackup: string | null = null;
    if (existingTarget) {
      if (!isPlainRegularFile(existingTarget)) {
        throw new BackupError(
          "Target SQLite state path is not a regular file (refusing symlink or directory).",
        );
      }
      if (!opts.force) {
        throw new BackupError(
          `Target SQLite state already exists (${stateFile}). Pass --force to replace it (a timestamped safety backup will be created first).`,
        );
      }
      safetyBackup = await createSafetyBackup(stateFile);
    }

    await removeSidecars(stateFile);
    await rename(stagedPath, stateFile);

    const restoredDb = openDatabaseAt(stateFile);
    checkpointWalAndClose(restoredDb);
    ensureDatabasePermissions(stateFile);
    await setPrivateMode(stateFile);

    return {
      ok: true,
      from: fromPath,
      stateFile,
      safetyBackup,
      schemaVersion,
      mode: process.platform === "win32" ? null : "0600",
    };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError("Failed to restore SQLite state from backup.");
  } finally {
    await removeSidecars(stagedPath);
    await rm(stagedPath, { force: true });
  }
}
