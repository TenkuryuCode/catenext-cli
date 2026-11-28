import { createHash, timingSafeEqual } from "node:crypto";
import { LOCK_LEASE_MS, nextStatus, type TaskEvent } from "@catenext/shared";
import { LocalServiceError } from "./errors.js";
import type { LocalTask } from "./local-state.js";

function fail(code: string, message: string, details?: unknown): never {
  throw new LocalServiceError(code, message, details);
}

export function leaseEnd(now: number): string {
  if (!Number.isFinite(now)) {
    fail("invalid_timestamp", "Timestamp lease tidak valid.");
  }
  const end = now + LOCK_LEASE_MS;
  if (!Number.isFinite(end)) {
    fail("invalid_timestamp", "Timestamp lease tidak valid.");
  }
  const date = new Date(end);
  if (Number.isNaN(date.getTime())) {
    fail("invalid_timestamp", "Timestamp lease tidak valid.");
  }
  return date.toISOString();
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
  if (stored.length === 0 || presented === undefined || presented.length === 0) return false;
  const candidate = stored.startsWith("sha256.") ? leaseKey(presented) : presented;
  const storedBuf = Buffer.from(stored, "utf8");
  const candidateBuf = Buffer.from(candidate, "utf8");
  if (storedBuf.length !== candidateBuf.length) return false;
  return timingSafeEqual(storedBuf, candidateBuf);
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
