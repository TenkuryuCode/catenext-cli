import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENTRY_MARKER,
  MASTER_MARKER,
  MASTER_PROMPT_FILE,
  renderMasterPrompt,
} from "./agents/entry-pointers.js";
import { BackupError, backupDatabase, escapeSqlStringLiteral, restoreDatabase } from "./backup.js";
import {
  checkpointDatabaseFile,
  checkpointWal,
  checkpointWalAndClose,
  openDatabaseAt,
} from "./db/open.js";
import { SCHEMA_VERSION } from "./db/schema.js";
import { runDoctor } from "./doctor.js";
import { BLOCK_START } from "./init/agents-md.js";

let root: string;
let stateFile: string;
let projectId: string;

function seedProjectDb(file: string, epicTitle: string): void {
  const db = openDatabaseAt(file);
  try {
    db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
      projectId,
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO epics (id, project_id, title, description) VALUES (?, ?, ?, ?)").run(
      randomUUID(),
      projectId,
      epicTitle,
      "synthetic description",
    );
  } finally {
    checkpointWalAndClose(db);
  }
}

async function initDoctorFixture(): Promise<void> {
  await mkdir(join(root, ".catenext"), { recursive: true });
  await writeFile(
    join(root, ".catenext/config.yaml"),
    JSON.stringify({
      project_id: projectId,
      repo_name: "fixture",
      schema_version: 1,
      platforms: [],
    }),
  );
  await writeFile(join(root, MASTER_PROMPT_FILE), renderMasterPrompt());
  await writeFile(
    join(root, "AGENTS.md"),
    `# Fixture\n\n${BLOCK_START}\nfixture\n<!-- catenext:end -->\n`,
  );
  if (!existsSync(join(root, MASTER_PROMPT_FILE))) {
    await writeFile(join(root, MASTER_PROMPT_FILE), `${MASTER_MARKER}\n${ENTRY_MARKER}\n`);
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "catenext-backup-")));
  await mkdir(join(root, ".catenext"), { recursive: true });
  stateFile = join(root, ".catenext", "catenext.sqlite");
  projectId = randomUUID();
});

afterEach(async () => {
  if (existsSync(stateFile)) {
    await chmod(stateFile, 0o600).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
});

async function tryFileSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return false;
    }
    throw error;
  }
}

describe("WAL checkpoint helpers", () => {
  it("cleans lingering WAL/SHM sidecars so doctor sees a journal-free snapshot", async () => {
    await initDoctorFixture();
    seedProjectDb(stateFile, "Initial Epic");

    // Simulate a read-only connection outliving a writer connection, leaving -wal/-shm behind.
    const rw = openDatabaseAt(stateFile);
    rw.prepare("INSERT INTO epics (id, project_id, title, description) VALUES (?, ?, ?, ?)").run(
      randomUUID(),
      projectId,
      "WAL Frame Epic",
      null,
    );
    const ro = openDatabaseAt(stateFile, { readOnly: true });
    expect((ro.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number }).n).toBe(2);
    rw.close();
    ro.close();

    expect(existsSync(`${stateFile}-wal`) || existsSync(`${stateFile}-shm`)).toBe(true);

    const res = checkpointDatabaseFile(stateFile, { onlyIfSidecarExists: true });
    expect(res.ok).toBe(true);
    expect(existsSync(`${stateFile}-wal`)).toBe(false);
    expect(existsSync(`${stateFile}-shm`)).toBe(false);

    const report = await runDoctor({ cwd: root, version: "0.13.0" });
    expect(report.ok).toBe(true);
    const supportsSnapshot = "deserialize" in DatabaseSync.prototype;
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "sqlite.integrity",
        status: supportsSnapshot ? "ok" : "skipped",
      }),
    );
    if (!supportsSnapshot) {
      expect(report.checks).toContainEqual(
        expect.objectContaining({
          id: "sqlite.integrity",
          message: expect.stringContaining("cannot open an in-memory SQLite snapshot"),
        }),
      );
    }
  });

  it("never creates missing files and ignores memory, symlinks, busy locks, and read-only DBs", async () => {
    const missing = join(root, "does-not-exist.sqlite");
    expect(checkpointDatabaseFile(missing)).toMatchObject({ ok: true, skippedReason: "missing" });
    expect(existsSync(missing)).toBe(false);

    expect(checkpointDatabaseFile(":memory:")).toMatchObject({ ok: true, skippedReason: "memory" });

    seedProjectDb(stateFile, "Live Epic");
    const linkPath = join(root, "link.sqlite");
    if (await tryFileSymlink(stateFile, linkPath)) {
      expect(checkpointDatabaseFile(linkPath)).toMatchObject({
        ok: false,
        skippedReason: "non_regular",
      });
    }

    // SQLITE_BUSY / busy wal_checkpoint when another connection holds an active transaction.
    const holder = openDatabaseAt(stateFile);
    const contender = openDatabaseAt(stateFile);
    try {
      holder.exec("BEGIN EXCLUSIVE");
      holder
        .prepare("INSERT INTO epics (id, project_id, title, description) VALUES (?, ?, ?, ?)")
        .run(randomUUID(), projectId, "Locked Epic", null);
      const busyRes = checkpointWal(contender, { busyTimeoutMs: 10 });
      expect(busyRes.ok).toBe(false);
      expect(busyRes.busy).toBe(true);
      expect(busyRes.skippedReason).toBe("busy");
      holder.exec("COMMIT");
    } finally {
      holder.close();
      contender.close();
    }

    if (process.platform !== "win32" && process.geteuid?.() !== 0) {
      await chmod(stateFile, 0o400);
      expect(checkpointDatabaseFile(stateFile)).toMatchObject({
        ok: false,
        skippedReason: "readonly",
      });
      await chmod(stateFile, 0o600);
    }
  });
});

describe("backupDatabase", () => {
  it("creates a consistent 0o600 VACUUM INTO snapshot and safely escapes paths with quotes", async () => {
    seedProjectDb(stateFile, "Backup Epic");
    const outPath = join(root, "backups", "catenext's-snapshot.sqlite");

    expect(escapeSqlStringLiteral("a'b")).toBe("'a''b'");

    const result = await backupDatabase({ stateFile, outPath });
    expect(result.ok).toBe(true);
    expect(result.out).toBe(outPath);
    expect(result.bytes).toBeGreaterThan(0);

    if (process.platform !== "win32") {
      expect((await stat(outPath)).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(`${outPath}-wal`)).toBe(false);
    expect(existsSync(`${outPath}-shm`)).toBe(false);

    const checkDb = new DatabaseSync(outPath, { readOnly: true });
    try {
      expect(checkDb.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      const row = checkDb.prepare("SELECT title FROM epics").get() as { title: string };
      expect(row.title).toBe("Backup Epic");
    } finally {
      checkDb.close();
    }
  });

  it("refuses overwriting non-empty target unless --force is passed", async () => {
    seedProjectDb(stateFile, "First");
    const outPath = join(root, "snapshot.sqlite");
    await backupDatabase({ stateFile, outPath });

    // Update live state and attempt backup without --force.
    const db = openDatabaseAt(stateFile);
    try {
      db.prepare("INSERT INTO epics (id, project_id, title, description) VALUES (?, ?, ?, ?)").run(
        randomUUID(),
        projectId,
        "Second",
        null,
      );
    } finally {
      checkpointWalAndClose(db);
    }

    await expect(backupDatabase({ stateFile, outPath })).rejects.toThrow(BackupError);

    const forced = await backupDatabase({ stateFile, outPath, force: true });
    expect(forced.ok).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(outPath)).mode & 0o777).toBe(0o600);
    }
    const verifyDb = new DatabaseSync(outPath, { readOnly: true });
    try {
      const count = verifyDb.prepare("SELECT COUNT(*) AS n FROM epics").get() as { n: number };
      expect(count.n).toBe(2);
    } finally {
      verifyDb.close();
    }
  });

  it("refuses symlink backup target and overwriting active state file", async () => {
    seedProjectDb(stateFile, "Safe");
    await expect(backupDatabase({ stateFile, outPath: stateFile, force: true })).rejects.toThrow(
      BackupError,
    );

    const decoy = join(root, "decoy.sqlite");
    await writeFile(decoy, "keep");
    const linkTarget = join(root, "link-out.sqlite");
    if (await tryFileSymlink(decoy, linkTarget)) {
      await expect(backupDatabase({ stateFile, outPath: linkTarget, force: true })).rejects.toThrow(
        BackupError,
      );
      expect(await readFile(decoy, "utf8")).toBe("keep");
    }
  });
});

describe("restoreDatabase", () => {
  it("validates source integrity, schema, and symlinks before touching target state", async () => {
    seedProjectDb(stateFile, "Live Original");
    const beforeBytes = await readFile(stateFile);

    // 1. Missing file
    await expect(
      restoreDatabase({ stateFile, fromPath: join(root, "missing.sqlite"), force: true }),
    ).rejects.toThrow(BackupError);

    // 2. Symlink source
    const validBackup = join(root, "valid.sqlite");
    await backupDatabase({ stateFile, outPath: validBackup });
    const symlinkSrc = join(root, "src-link.sqlite");
    if (await tryFileSymlink(validBackup, symlinkSrc)) {
      await expect(
        restoreDatabase({ stateFile, fromPath: symlinkSrc, force: true }),
      ).rejects.toThrow(BackupError);
    }

    // 3. Non-SQLite garbage
    const garbage = join(root, "garbage.sqlite");
    await writeFile(garbage, "not-a-sqlite-file");
    await expect(restoreDatabase({ stateFile, fromPath: garbage, force: true })).rejects.toThrow(
      BackupError,
    );

    // 4. Corrupt SQLite page beyond header
    const corruptPath = join(root, "corrupt.sqlite");
    const corrupt = Buffer.from(await readFile(validBackup));
    const rawPageSize = corrupt.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    corrupt[pageSize] = 0xff;
    await writeFile(corruptPath, corrupt);
    await expect(
      restoreDatabase({ stateFile, fromPath: corruptPath, force: true }),
    ).rejects.toThrow(BackupError);

    // 5. Foreign SQLite DB without Catenext tables
    const foreignPath = join(root, "foreign.sqlite");
    const foreignDb = new DatabaseSync(foreignPath);
    foreignDb.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    foreignDb.close();
    await expect(
      restoreDatabase({ stateFile, fromPath: foreignPath, force: true }),
    ).rejects.toThrow(BackupError);

    // 6. Newer unsupported schema version
    const futurePath = join(root, "future.sqlite");
    await backupDatabase({ stateFile, outPath: futurePath });
    const futureDb = new DatabaseSync(futurePath);
    futureDb.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    futureDb
      .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run(String(SCHEMA_VERSION + 1));
    futureDb.close();
    await expect(restoreDatabase({ stateFile, fromPath: futurePath, force: true })).rejects.toThrow(
      /schema version/i,
    );

    // Live state file must be completely untouched.
    expect(await readFile(stateFile)).toEqual(beforeBytes);
    await expect(readdir(join(root, ".catenext"))).resolves.toEqual(["catenext.sqlite"]);
  });

  it("refuses silent overwrite without --force, saves timestamped safety copy with --force, and keeps doctor clean", async () => {
    await initDoctorFixture();
    seedProjectDb(stateFile, "Good Backup State");
    const backupPath = join(root, "good-backup.sqlite");
    await backupDatabase({ stateFile, outPath: backupPath });

    // Mutate live state after taking the backup.
    const liveDb = openDatabaseAt(stateFile);
    try {
      liveDb.prepare("UPDATE epics SET title = ?").run("Mutated Current State");
    } finally {
      checkpointWalAndClose(liveDb);
    }

    // Refuse without --force.
    await expect(restoreDatabase({ stateFile, fromPath: backupPath })).rejects.toThrow(/--force/);

    const restored = await restoreDatabase({ stateFile, fromPath: backupPath, force: true });
    expect(restored.ok).toBe(true);
    expect(restored.safetyBackup).toBeTruthy();
    expect(restored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(existsSync(restored.safetyBackup as string)).toBe(true);

    if (process.platform !== "win32") {
      expect((await lstat(stateFile)).mode & 0o777).toBe(0o600);
      expect((await lstat(restored.safetyBackup as string)).mode & 0o777).toBe(0o600);
    }

    // Doctor runs strictly read-only on the freshly restored state and sees a clean snapshot.
    const doctorReport = await runDoctor({ cwd: root, version: "0.13.0" });
    expect(doctorReport.ok).toBe(true);
    const supportsSnapshot = "deserialize" in DatabaseSync.prototype;
    expect(doctorReport.checks).toContainEqual(
      expect.objectContaining({
        id: "sqlite.integrity",
        status: supportsSnapshot ? "ok" : "skipped",
      }),
    );
    if (!supportsSnapshot) {
      expect(doctorReport.checks).toContainEqual(
        expect.objectContaining({
          id: "sqlite.integrity",
          message: expect.stringContaining("cannot open an in-memory SQLite snapshot"),
        }),
      );
    }

    // Restored state has original epic title; safety backup preserves the mutated state.
    const checkRestored = openDatabaseAt(stateFile, { readOnly: true });
    try {
      expect(
        (checkRestored.prepare("SELECT title FROM epics").get() as { title: string }).title,
      ).toBe("Good Backup State");
    } finally {
      checkRestored.close();
    }

    const checkSafety = new DatabaseSync(restored.safetyBackup as string, { readOnly: true });
    try {
      expect(
        (checkSafety.prepare("SELECT title FROM epics").get() as { title: string }).title,
      ).toBe("Mutated Current State");
    } finally {
      checkSafety.close();
    }
  });
});
