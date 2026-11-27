import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { emptyExtendedProject, loadProject, saveProject } from "./db/project-codec.js";
import { SCHEMA_SQL } from "./db/schema.js";
import {
  archiveEpicInProject,
  filterVisibleTasks,
  restoreEpicInProject,
  upsertVersionedEpicSummary,
} from "./local-retention.js";
import type { LocalTask } from "./local-state.js";

it("previews without mutation and restores retained records", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(SCHEMA_SQL);
    const p = emptyExtendedProject();
    const epic = { id: randomUUID(), title: "Retention", description: null };
    p.epics.push(epic);
    const t: LocalTask = {
      id: randomUUID(),
      epicId: epic.id,
      title: "test",
      status: "DONE",
      dependencies: [],
      target: null,
      instruction: "test",
      role: null,
      persona: null,
      position: 0,
      requiresApproval: true,
      stale: false,
      revision: 0,
      handoff: {
        files_modified: [],
        key_decisions: ["keep history"],
        notes_for_next_agent: "verified",
        verification_command: null,
        git_branch: "feature",
        last_commit_hash: "1234567",
      },
    };
    p.tasks.push(t);
    saveProject(db, "p", p);
    const before = structuredClone(t);
    db.prepare(
      "INSERT INTO task_events(project_id,task_id,event,actor,created_at) VALUES (?,?,?,?,?)",
    ).run("p", t.id, "approve", "human", new Date().toISOString());
    db.exec("PRAGMA query_only=ON");
    const preview = archiveEpicInProject(db, "p", p, epic.id, { dry_run: true });
    expect(preview.counts.task_count).toBe(1);
    expect(preview.counts).toEqual({ task_count: 1, handoff_count: 1, event_count: 1 });
    expect(t).toEqual(before);
    db.exec("PRAGMA query_only=OFF");
    t.lease = {
      id: randomUUID(),
      repo: "test",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    expect(() => archiveEpicInProject(db, "p", p, epic.id)).toThrow(/lease/);
    delete t.lease;
    p.tasks.push({
      ...t,
      id: randomUUID(),
      epicId: randomUUID(),
      status: "TODO",
      dependencies: [t.id],
    });
    expect(() => archiveEpicInProject(db, "p", p, epic.id)).toThrow(/lintas-epic/);
    p.tasks.pop();
    t.status = "TODO";
    expect(() => archiveEpicInProject(db, "p", p, epic.id)).toThrow();
    t.status = "DONE";
    const summary = upsertVersionedEpicSummary(epic, p.tasks, {
      overview: "猫".repeat(600),
      outcomes: ["猫".repeat(200)],
    });
    expect(summary.byte_length).toBe(Buffer.byteLength(JSON.stringify(summary)));
    expect(summary.byte_length).toBeLessThanOrEqual(2048);
    archiveEpicInProject(db, "p", p, epic.id);
    saveProject(db, "p", p);
    const loaded = loadProject(db, "p");
    expect(filterVisibleTasks(loaded.tasks, loaded.epics)).toEqual([]);
    restoreEpicInProject(loaded, epic.id);
    expect(db.prepare("SELECT event FROM task_events").all()).toEqual([{ event: "approve" }]);
    expect(loaded.tasks).toEqual([before]);
    expect(loaded.epics[0]?.summary).toEqual(summary);
  } finally {
    db.close();
  }
});
