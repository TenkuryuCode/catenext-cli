import { createHash } from "node:crypto";
import { LOCK_LEASE_MS, nextStatus, type TaskEvent } from "@catenext/shared";
import { LocalServiceError } from "./errors.js";
import type { LocalTask } from "./local-state.js";

function fail(code: string, message: string, details?: unknown): never {
  throw new LocalServiceError(code, message, details);
}

export function leaseEnd(now: number): string {
  return new Date(now + LOCK_LEASE_MS).toISOString();
}

/** State menyimpan hash token, bukan token yang bisa dipakai ulang oleh pembaca state. */
export function leaseKey(token: string): string {
  return `sha256.${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * State baru menyimpan hash: cocokkan `leaseKey(presented)`.
 * State lama yang masih plaintext: cocokkan kesamaan langsung (bukan hash yang disalin dari state).
 */
export function leaseMatches(stored: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  if (stored.startsWith("sha256.")) return stored === leaseKey(presented);
  return stored === presented;
}

export function claimable(task: LocalTask): boolean {
  return task.status === "TODO" || task.status === "REVISION_REQUESTED";
}

export function advance(task: LocalTask, event: TaskEvent): void {
  const status = nextStatus(task.status, event);
  if (!status)
    fail("invalid_transition", `Aksi ${event} tidak berlaku untuk status ${task.status}.`);
  task.status = status;
}

export function endLease(task: LocalTask) {
  delete task.lease;
  if (!task.handoff) delete task.branch;
}

export function returnClaim(task: LocalTask): "TODO" | "REVISION_REQUESTED" {
  endLease(task);
  task.status = task.handoff ? "REVISION_REQUESTED" : "TODO";
  return task.status;
}
