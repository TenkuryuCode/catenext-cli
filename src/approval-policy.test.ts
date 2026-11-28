import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ApprovalSnapshotSchema,
  HUMAN_APPROVAL_COMMANDS,
  requireHumanApproval,
  requireHumanEpicRunApproval,
} from "./approval-policy.js";
import { LocalServiceError } from "./errors.js";

describe("approval-policy", () => {
  describe("ApprovalSnapshotSchema", () => {
    it("accepts 64-character lowercase hex sha256 digests", () => {
      expect(ApprovalSnapshotSchema.safeParse("0".repeat(64)).success).toBe(true);
      expect(ApprovalSnapshotSchema.safeParse("0123456789abcdef".repeat(4)).success).toBe(true);
    });

    it("rejects non-hex, uppercase, wrong length, whitespace, and non-string values", () => {
      for (const invalid of [
        "",
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
        `${"a".repeat(63)}\n`,
        ` ${"a".repeat(64)}`,
        123,
        null,
        undefined,
      ]) {
        expect(ApprovalSnapshotSchema.safeParse(invalid).success).toBe(false);
      }
    });
  });

  describe("requireHumanApproval", () => {
    const taskId = randomUUID();

    it("allows human caller for any action including approve and approve_plan", () => {
      expect(() =>
        requireHumanApproval("human", { action: "approve_plan", task_id: taskId }),
      ).not.toThrow();
      expect(() =>
        requireHumanApproval("human", { action: "approve", task_id: taskId }),
      ).not.toThrow();
      expect(() =>
        requireHumanApproval("human", { action: "assign", task_id: taskId }),
      ).not.toThrow();
    });

    it("allows agent caller for non-approval actions", () => {
      for (const action of ["assign", "request_revision", "unblock", "return_to_draft"] as const) {
        expect(() => requireHumanApproval("agent", { action, task_id: taskId })).not.toThrow();
      }
    });

    it("rejects agent caller on approve_plan and approve with exact CLI command hints", () => {
      expect(() =>
        requireHumanApproval("agent", { action: "approve_plan", task_id: taskId }),
      ).toThrowError(LocalServiceError);

      try {
        requireHumanApproval("agent", { action: "approve_plan", task_id: taskId });
      } catch (err) {
        expect(err).toBeInstanceOf(LocalServiceError);
        expect(err).toMatchObject({ code: "human_approval_required" });
        expect((err as Error).message).toContain(
          `${HUMAN_APPROVAL_COMMANDS.approve_plan} ${taskId}`,
        );
      }

      try {
        requireHumanApproval("agent", { action: "approve", task_id: taskId });
      } catch (err) {
        expect(err).toBeInstanceOf(LocalServiceError);
        expect(err).toMatchObject({ code: "human_approval_required" });
        expect((err as Error).message).toContain(`${HUMAN_APPROVAL_COMMANDS.approve} ${taskId}`);
      }
    });

    it("safely quotes task_id containing whitespace or special characters", () => {
      try {
        requireHumanApproval("agent", { action: "approve", task_id: "id with\nnewline" });
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain("\n");
        expect(message).toContain("'id with\\nnewline'");
      }
    });
  });

  describe("requireHumanEpicRunApproval", () => {
    const epicId = randomUUID();
    const validSha = "a".repeat(64);

    it("allows human caller for start and any other action", () => {
      expect(() =>
        requireHumanEpicRunApproval("human", {
          action: "start",
          epic_id: epicId,
          base: "main",
          check: "pnpm test",
          snapshot: validSha,
        }),
      ).not.toThrow();
    });

    it("allows agent caller for non-start actions", () => {
      for (const action of ["preview", "pause", "resume", "close"]) {
        expect(() =>
          requireHumanEpicRunApproval("agent", { action, epic_id: epicId }),
        ).not.toThrow();
      }
    });

    it("uses default placeholders when optional fields are omitted", () => {
      try {
        requireHumanEpicRunApproval("agent", { action: "start", epic_id: epicId });
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(LocalServiceError);
        expect(err).toMatchObject({ code: "human_approval_required" });
        expect((err as Error).message).toContain(
          `catenext epic run start ${epicId} --base <branch> --check "<command>" --if-snapshot <sha256>`,
        );
      }
    });

    it("formats normal values cleanly", () => {
      try {
        requireHumanEpicRunApproval("agent", {
          action: "start",
          epic_id: epicId,
          base: "main",
          check: "pnpm test",
          snapshot: validSha,
        });
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toMatchObject({ code: "human_approval_required" });
        expect((err as Error).message).toContain(
          `catenext epic run start ${epicId} --base main --check 'pnpm test' --if-snapshot ${validSha}`,
        );
      }
    });

    it("safely quotes and escapes spaces, quotes, newlines, and shell metacharacters", () => {
      try {
        requireHumanEpicRunApproval("agent", {
          action: "start",
          epic_id: epicId,
          base: "feat/my branch\r\n--evil",
          check: `echo "hi" && echo 'yo'\n$(id)\t\u0007`,
          snapshot: "abc 'def'\n123",
        });
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toMatchObject({ code: "human_approval_required" });
        const message = (err as Error).message;
        expect(message).not.toMatch(/[\r\n\t]/);
        expect(message).not.toContain("\u0007");
        expect(message).toContain(`catenext epic run start ${epicId}`);
        expect(message).toContain("--base 'feat/my branch\\r\\n--evil'");
        expect(message).toContain(`--check 'echo "hi" && echo '\\''yo'\\''\\n$(id)\\t'`);
        expect(message).toContain("--if-snapshot 'abc '\\''def'\\''\\n123'");
      }
    });

    it("quotes empty string arguments instead of leaving bare flags", () => {
      try {
        requireHumanEpicRunApproval("agent", {
          action: "start",
          epic_id: epicId,
          base: "",
          check: "",
          snapshot: "",
        });
        expect.unreachable("should throw");
      } catch (err) {
        expect((err as Error).message).toContain("--base '' --check '' --if-snapshot ''");
      }
    });

    it("strips C1 control characters and Unicode line/paragraph separators", () => {
      try {
        requireHumanEpicRunApproval("agent", {
          action: "start",
          epic_id: epicId,
          base: "main\u009b[31m\u0080\u009f",
          check: "pnpm test\u2028echo ok\u2029",
          snapshot: `${validSha}\u009b`,
        });
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toMatchObject({ code: "human_approval_required" });
        const message = (err as Error).message;
        expect(message).not.toMatch(/[\u0080-\u009f\u2028\u2029]/);
        expect(message).toContain(
          `catenext epic run start ${epicId} --base 'main[31m' --check 'pnpm testecho ok' --if-snapshot ${validSha}`,
        );
      }
    });
  });
});
