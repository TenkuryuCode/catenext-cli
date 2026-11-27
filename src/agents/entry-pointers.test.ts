import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFileEdits } from "../maintenance.js";
import {
  ENTRY_MARKER,
  MASTER_MARKER,
  MASTER_PROMPT_FILE,
  PLATFORM_ENTRY_FILES,
  planEntryPointers,
  renderClaudeEntry,
  renderEntryPointer,
  renderMasterPrompt,
} from "./entry-pointers.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catenext-entry-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("entry-pointers rendering", () => {
  it("renderMasterPrompt is a crisp <=30-line boot pointer without duplicating AGENTS.md", () => {
    const md = renderMasterPrompt();
    const lines = md.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(md.startsWith(MASTER_MARKER)).toBe(true);
    expect(md).toContain("[AGENTS.md](./AGENTS.md)");
    expect(md).toContain("## Bootstrap (install if missing)");
    expect(md).toContain("npm install -g catenext");
    expect(md).toContain("catenext brief");
    expect(md).not.toContain("APPROVAL NEEDED");
    expect(md).not.toContain("ACCESS NEEDED");
    expect(md).not.toContain("INTEGRATE READY");
  });

  it("renderEntryPointer resolves relative links for root, single-depth, and multi-depth paths", () => {
    const nested = renderEntryPointer("cursor", ".cursor/CATENEXT.md");
    expect(nested.startsWith(ENTRY_MARKER)).toBe(true);
    expect(nested).toContain("# Cursor · Catenext entry");
    expect(nested).toContain("[CATENEXT.md](../CATENEXT.md)");
    expect(nested).toContain("[AGENTS.md](../AGENTS.md)");
    expect(nested).toContain(".cursor/agents/");
    expect(nested).toContain("model: inherit");

    const deep = renderEntryPointer("codex", ".codex/sub/CATENEXT.md");
    expect(deep).toContain("[CATENEXT.md](../../CATENEXT.md)");
    expect(deep).toContain("[AGENTS.md](../../AGENTS.md)");
    expect(deep).toContain(".codex/agents/");
    expect(deep).toContain("TOML");

    const rootLevel = renderEntryPointer("opencode", "ENTRY.md");
    expect(rootLevel).toContain("[CATENEXT.md](./CATENEXT.md)");
    expect(rootLevel).toContain("[AGENTS.md](./AGENTS.md)");
  });

  it("renderClaudeEntry includes marker, local CATENEXT.md link, and .claude/agents/ note", () => {
    const md = renderClaudeEntry();
    expect(md.startsWith(ENTRY_MARKER)).toBe(true);
    expect(md).toContain("# Claude Code · Catenext entry");
    expect(md).toContain("[CATENEXT.md](./CATENEXT.md)");
    expect(md).toContain("[AGENTS.md](./AGENTS.md)");
    expect(md).toContain(".claude/agents/");
  });

  it("antigravity entry points at native .agents/agents/", () => {
    const md = renderEntryPointer("antigravity", ".agents/CATENEXT.md");
    expect(md).toContain(".agents/agents/");
    expect(md).toContain("catenext sync --platform antigravity");
  });

  it("vscode entry points at .github/agents and .vscode/mcp.json", () => {
    const md = renderEntryPointer("vscode", ".vscode/CATENEXT.md");
    expect(md).toContain("# VS Code · Catenext entry");
    expect(md).toContain("[CATENEXT.md](../CATENEXT.md)");
    expect(md).toContain(".github/agents/");
    expect(md).toContain(".vscode/mcp.json");
    expect(md).toContain("catenext sync --platform vscode");
  });
});

describe("planEntryPointers", () => {
  it("creates CATENEXT.md and platform entry pointers, skipping platforms without entry files, and is idempotent", async () => {
    const platforms = [
      "claude-code",
      "cursor",
      "codex",
      "opencode",
      "antigravity",
      "vscode",
      "windsurf",
    ] as const;

    const first = await planEntryPointers(root, platforms);
    expect(first.map((e) => e.path)).toEqual([
      MASTER_PROMPT_FILE,
      PLATFORM_ENTRY_FILES["claude-code"],
      PLATFORM_ENTRY_FILES.cursor,
      PLATFORM_ENTRY_FILES.codex,
      PLATFORM_ENTRY_FILES.opencode,
      PLATFORM_ENTRY_FILES.antigravity,
      PLATFORM_ENTRY_FILES.vscode,
    ]);
    expect(first.every((e) => e.before === null)).toBe(true);

    await applyFileEdits(root, first);
    expect(await readFile(join(root, MASTER_PROMPT_FILE), "utf8")).toBe(renderMasterPrompt());
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(renderClaudeEntry());
    expect(await readFile(join(root, ".cursor/CATENEXT.md"), "utf8")).toBe(
      renderEntryPointer("cursor", ".cursor/CATENEXT.md"),
    );

    const second = await planEntryPointers(root, platforms);
    expect(second).toEqual([]);
  });

  it("updates stale Catenext-managed files that still carry markers", async () => {
    await writeFile(join(root, MASTER_PROMPT_FILE), `${MASTER_MARKER}\nold master\n`);
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".cursor/CATENEXT.md"), `${ENTRY_MARKER}\nold cursor\n`);

    const edits = await planEntryPointers(root, ["cursor"]);
    expect(edits).toEqual([
      {
        path: MASTER_PROMPT_FILE,
        before: `${MASTER_MARKER}\nold master\n`,
        after: renderMasterPrompt(),
      },
      {
        path: ".cursor/CATENEXT.md",
        before: `${ENTRY_MARKER}\nold cursor\n`,
        after: renderEntryPointer("cursor", ".cursor/CATENEXT.md"),
      },
    ]);
  });

  it("skips human-authored files without markers unless force is true", async () => {
    await writeFile(join(root, MASTER_PROMPT_FILE), "custom master prompt\n");
    await writeFile(join(root, "CLAUDE.md"), "custom claude instructions\n");
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".cursor/CATENEXT.md"), "custom cursor pointer\n");

    const skipped = await planEntryPointers(root, ["claude-code", "cursor"]);
    expect(skipped).toEqual([]);

    const forced = await planEntryPointers(root, ["claude-code", "cursor"], { force: true });
    expect(forced.map((e) => e.path)).toEqual([
      MASTER_PROMPT_FILE,
      "CLAUDE.md",
      ".cursor/CATENEXT.md",
    ]);

    await applyFileEdits(root, forced);
    expect(await readFile(join(root, MASTER_PROMPT_FILE), "utf8")).toContain(MASTER_MARKER);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain(ENTRY_MARKER);
    expect(await readFile(join(root, ".cursor/CATENEXT.md"), "utf8")).toContain(ENTRY_MARKER);
  });
});
