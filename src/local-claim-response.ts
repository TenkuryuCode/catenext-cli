import type { McpToolOutput, Persona } from "@catenext/shared";
import type { LocalTask } from "./local-state.js";

type ClaimResult = McpToolOutput<"claim_task">;

export function dependencyHandoffs(task: LocalTask, tasks: ReadonlyMap<string, LocalTask>) {
  return task.dependencies.flatMap((id) => {
    const dep = tasks.get(id);
    if (!dep?.handoff) return [];
    const integrated =
      dep.integrated_commit ??
      (dep.handoff as { integrated_commit?: { branch: string; sha: string } }).integrated_commit;
    return [
      {
        task_id: id,
        title: dep.title,
        handoff_summary: dep.handoff,
        ...(integrated ? { integrated_commit: integrated } : {}),
      },
    ];
  });
}

function claimDependencyHandoffs(
  task: LocalTask,
  tasks: ReadonlyMap<string, LocalTask>,
  compact: boolean,
) {
  const handoffs = dependencyHandoffs(task, tasks);
  if (!compact) return handoffs;
  return handoffs.map(({ task_id, title, handoff_summary, integrated_commit }) => ({
    task_id,
    title,
    compact_handoff: {
      files_modified: handoff_summary.files_modified,
      key_decisions: handoff_summary.key_decisions,
      notes_for_next_agent: handoff_summary.notes_for_next_agent,
    },
    ...(integrated_commit ? { integrated_commit } : {}),
  }));
}

export function claimResponse({
  task,
  tasks,
  persona,
  leaseId,
  expiry,
  compact,
  revision,
}: {
  task: LocalTask;
  tasks: ReadonlyMap<string, LocalTask>;
  persona?: Persona;
  leaseId: string;
  expiry: string;
  compact: boolean;
  revision?: ClaimResult["revision"];
}): ClaimResult {
  return {
    task: {
      id: task.id,
      title: task.title,
      prompt_instruction: task.instruction,
      status: "IN_PROGRESS",
      revision_count: task.revision,
      ...(task.role ? { role: task.role } : {}),
      ...(task.target ? { target_repo: task.target } : {}),
      ...(task.scope_files !== undefined ? { scope_files: task.scope_files } : {}),
      ...(task.verify_command !== undefined ? { verify_command: task.verify_command } : {}),
      ...(task.doc_refs !== undefined ? { doc_refs: task.doc_refs } : {}),
    },
    ...(persona ? { persona } : {}),
    lease_id: leaseId,
    lease_expires_at: expiry,
    dependencies: claimDependencyHandoffs(task, tasks, compact),
    ...(revision ? { revision } : {}),
    warnings: [],
  };
}
