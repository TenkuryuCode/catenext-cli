import { describe, expect, it } from "vitest";
import { CreateTasksInput } from "../mcp-tools.js";
import { EPIC_TEMPLATES } from "../templates.js";

describe("template epic", () => {
  it("ada 2 template, masing-masing 3 task valid tanpa siklus", () => {
    expect(EPIC_TEMPLATES).toHaveLength(2);
    for (const t of EPIC_TEMPLATES) {
      expect(t.tasks).toHaveLength(3);
      const parsed = CreateTasksInput.safeParse({
        epic_id: "11111111-2222-4333-8444-555555555555",
        tasks: t.tasks,
      });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });
});
