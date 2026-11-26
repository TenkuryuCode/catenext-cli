import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runSchemaMigrations } from "./migrate.js";

export interface OpenDatabaseOptions {
  readOnly?: boolean;
}

function isInMemoryPath(file: string): boolean {
  return file === ":memory:" || file.startsWith("file::memory:");
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
