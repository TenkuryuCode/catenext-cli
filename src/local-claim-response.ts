import type { DatabaseSync } from "node:sqlite";
import type { ClaimContextPack, McpToolOutput, Persona } from "@catenext/shared";
import { cosineSimilarity } from "./code-search.js";
import { decodeEmbeddingVector, type EmbeddingClient } from "./embeddings.js";
import { boundClaimContextPack } from "./local-claim-context.js";
import type { LocalTask } from "./local-state.js";

type ClaimResult = McpToolOutput<"claim_task">;

export function dependencyHandoffs(task: LocalTask, tasks: ReadonlyMap<string, LocalTask>) {
  const seen = new Set<string>();
  return task.dependencies.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
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

function maxCosineForPath(
  path: string,
  queryVec: Float32Array,
  chunkVectorsByPath: ReadonlyMap<string, Float32Array[]>,
): number {
  const vectors = chunkVectorsByPath.get(path);
  if (!vectors || vectors.length === 0) return -Infinity;
  let best = -Infinity;
  for (const vec of vectors) {
    const sim = cosineSimilarity(queryVec, vec);
    if (sim > best) best = sim;
  }
  return best;
}

/**
 * Optionally rerank `context_pack.graph_slice` and `context_pack.test_files` by cosine
 * similarity to `promptInstruction` when local cached embeddings exist, preserving the 4,096 B cap.
 */
export async function rerankClaimContextPack({
  pack,
  promptInstruction,
  db,
  projectId,
  embeddingClient,
}: {
  pack: ClaimContextPack;
  promptInstruction: string;
  db: DatabaseSync;
  projectId: string;
  embeddingClient?: EmbeddingClient;
}): Promise<ClaimContextPack> {
  if (!embeddingClient || !promptInstruction.trim()) return pack;

  const hasGraphSlice = (pack.graph_slice?.length ?? 0) > 1;
  const hasTestFiles = (pack.test_files?.length ?? 0) > 1;
  if (!hasGraphSlice && !hasTestFiles) return pack;

  const candidatePaths = new Set<string>();
  for (const file of pack.graph_slice ?? []) candidatePaths.add(file.path);
  for (const testFile of pack.test_files ?? []) candidatePaths.add(testFile);
  if (candidatePaths.size === 0) return pack;

  const chunkRows = db
    .prepare(
      `SELECT source_key, vector
       FROM embedding_chunks
       WHERE project_id = ? AND source_kind = 'code' AND model = ?`,
    )
    .all(projectId, embeddingClient.model) as Array<{ source_key: string; vector: Uint8Array }>;
  if (chunkRows.length === 0) return pack;

  const chunkVectorsByPath = new Map<string, Float32Array[]>();
  for (const row of chunkRows) {
    const filePath = row.source_key.replace(/#\d+$/, "");
    if (!candidatePaths.has(filePath)) continue;
    const list = chunkVectorsByPath.get(filePath) ?? [];
    list.push(decodeEmbeddingVector(row.vector));
    chunkVectorsByPath.set(filePath, list);
  }
  if (chunkVectorsByPath.size === 0) return pack;

  let queryVec: Float32Array | undefined;
  try {
    const [vec] = await embeddingClient.embed([promptInstruction]);
    queryVec = vec;
  } catch {
    return pack;
  }
  if (!queryVec || queryVec.length === 0) return pack;

  const nextPack: ClaimContextPack = { ...pack };
  if (hasGraphSlice && pack.graph_slice) {
    nextPack.graph_slice = pack.graph_slice
      .map((file, idx) => ({
        file,
        idx,
        score: maxCosineForPath(file.path, queryVec, chunkVectorsByPath),
      }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map((entry) => entry.file);
  }
  if (hasTestFiles && pack.test_files) {
    nextPack.test_files = pack.test_files
      .map((path, idx) => ({
        path,
        idx,
        score: maxCosineForPath(path, queryVec, chunkVectorsByPath),
      }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .map((entry) => entry.path);
  }

  return boundClaimContextPack(nextPack);
}
