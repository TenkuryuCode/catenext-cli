import type { ManageTaskInput } from "@catenext/shared";
import { z } from "zod";
import { LocalServiceError } from "./errors.js";

export const HUMAN_APPROVAL_COMMANDS = {
  approve_plan: "catenext task approve",
  approve: "catenext review approve",
} as const;

export type ApprovalAction = keyof typeof HUMAN_APPROVAL_COMMANDS;
export const ApprovalSnapshotSchema = z.string().regex(/^[a-f0-9]{64}$/);

function sanitizeCliControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === "\r") out += "\\r";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else {
      const code = ch.charCodeAt(0);
      if (
        (code >= 0 && code <= 0x1f) ||
        code === 0x7f ||
        (code >= 0x80 && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029
      ) {
        continue;
      }
      out += ch;
    }
  }
  return out;
}

function quoteCliArg(value: string, alwaysQuote = false): string {
  const clean = sanitizeCliControlChars(value);
  if (!alwaysQuote && /^[A-Za-z0-9._:/@-]+$/.test(clean)) {
    return clean;
  }
  return `'${clean.replaceAll("'", "'\\''")}'`;
}

export function requireHumanApproval(
  caller: "human" | "agent",
  input: Pick<z.output<typeof ManageTaskInput>, "action" | "task_id">,
): void {
  if (caller === "human" || (input.action !== "approve" && input.action !== "approve_plan")) return;
  const command = HUMAN_APPROVAL_COMMANDS[input.action];
  const taskId = quoteCliArg(input.task_id);
  throw new LocalServiceError(
    "human_approval_required",
    `Aksi ${input.action} hanya lewat CLI setelah persetujuan manusia. Jalankan \`${command} ${taskId}\` dari terminal; agen MCP tidak boleh menyetujui.`,
  );
}

/** Enforce CLI-only human authorization for starting a bounded local epic run. */
export function requireHumanEpicRunApproval(
  caller: "human" | "agent",
  input: {
    action: string;
    epic_id: string;
    base?: string;
    check?: string;
    snapshot?: string;
  },
): void {
  if (caller === "human" || input.action !== "start") return;
  const epicId = quoteCliArg(input.epic_id);
  const base = input.base !== undefined ? quoteCliArg(input.base) : "<branch>";
  const check = input.check !== undefined ? quoteCliArg(input.check, true) : '"<command>"';
  const snapshot = input.snapshot !== undefined ? quoteCliArg(input.snapshot) : "<sha256>";
  throw new LocalServiceError(
    "human_approval_required",
    `Aksi epic_run start hanya lewat CLI setelah persetujuan manusia. Jalankan \`catenext epic run start ${epicId} --base ${base} --check ${check} --if-snapshot ${snapshot}\` dari terminal; agen MCP tidak boleh memulai epic run.`,
  );
}
