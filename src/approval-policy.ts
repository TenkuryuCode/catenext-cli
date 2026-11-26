import type { ManageTaskInput } from "@catenext/shared";
import type { z } from "zod";
import { LocalServiceError } from "./errors.js";

export const HUMAN_APPROVAL_COMMANDS = {
  approve_plan: "catenext task approve",
  approve: "catenext review approve",
} as const;

export function requireHumanApproval(
  caller: "human" | "agent",
  input: Pick<z.output<typeof ManageTaskInput>, "action" | "task_id">,
): void {
  if (caller === "human" || (input.action !== "approve" && input.action !== "approve_plan")) return;
  const command = HUMAN_APPROVAL_COMMANDS[input.action];
  throw new LocalServiceError(
    "human_approval_required",
    `Aksi ${input.action} hanya lewat CLI manusia. Jalankan \`${command} ${input.task_id}\` dari terminal; agen MCP tidak boleh menyetujui.`,
  );
}
