import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CatenextConfig,
  MCP_TOOLS,
  REVIEW_CONTEXT_PACK_MAX_BYTES,
  ReviewContextPackSchema,
} from "@catenext/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskReview } from "./fallback.js";
import { LocalService } from "./local-service.js";
import {
  boundReviewContextPack,
  collectScopedDiffMeta,
  evaluateScopeDrift,
  matchesScopePattern,
} from "./review-context.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("review-context unit and integration tests", () => {
  let root: string;
  let config: CatenextConfig;
  let service: LocalService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "catenext-review-ctx-"));
    config = {
      schema_version: 2,
      project_id: randomUUID(),
      repo_name: "be",
      layout: "polyrepo",
      stack: ["typescript"],
      state_file: ".catenext/catenext.sqlite",
    };
    service = new LocalService(root, config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("matches exact paths, directory prefixes, and glob patterns for scope_files drift check", () => {
    expect(
      matchesScopePattern("apps/cli/src/review-context.ts", "apps/cli/src/review-context.ts"),
    ).toBe(true);
    expect(matchesScopePattern("apps/cli/src/review-context.ts", "apps/cli/src")).toBe(true);
    expect(matchesScopePattern("apps/cli/src/review-context.ts", "apps/cli/**/*.ts")).toBe(true);
    expect(matchesScopePattern("packages/shared/src/review.ts", "apps/cli/**")).toBe(false);

    const drift = evaluateScopeDrift(
      ["apps/cli/src/review-context.ts", "packages/shared/src/unplanned.ts"],
      ["apps/cli/src/review-context.ts", "apps/cli/src/local-service.ts"],
    );
    expect(drift).toEqual({
      scope_files: ["apps/cli/src/review-context.ts", "apps/cli/src/local-service.ts"],
      in_scope_files: ["apps/cli/src/review-context.ts"],
      out_of_scope_files: ["packages/shared/src/unplanned.ts"],
      untouched_scope_files: ["apps/cli/src/local-service.ts"],
      drift_detected: true,
    });

    const clean = evaluateScopeDrift(
      ["apps/cli/src/review-context.ts"],
      ["apps/cli/src/review-context.ts"],
    );
    expect(clean?.drift_detected).toBe(false);
    expect(clean?.out_of_scope_files).toEqual([]);
  });

  it("collects scoped git diff metadata from real commits without leaking source lines", async () => {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.com");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/index.ts"), "export const a = 1;\nexport const b = 2;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "init");

    git(root, "checkout", "-b", "feat/scoped");
    const secretLine = "export const SECRET_PAYLOAD = 'SUPER_SECRET_SOURCE_LINE_DO_NOT_DUMP';";
    await writeFile(join(root, "src/index.ts"), `export const a = 10;\n${secretLine}\n`);
    await writeFile(join(root, "src/extra.ts"), "export const extra = true;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "feat changes");
    const headSha = git(root, "rev-parse", "HEAD");

    const meta = collectScopedDiffMeta({
      repoRoot: root,
      baseBranch: "main",
      headSha,
      handoffFiles: ["src/index.ts", "src/extra.ts"],
      scopeFiles: ["src/index.ts"],
    });

    expect(meta.source).toBe("git_diff");
    expect(meta.total_files).toBe(2);
    expect(meta.additions).toBe(3);
    expect(meta.deletions).toBe(2);
    expect(meta.changed_files).toEqual([
      {
        path: "src/extra.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        in_scope: false,
      },
      {
        path: "src/index.ts",
        status: "modified",
        additions: 2,
        deletions: 2,
        in_scope: true,
      },
    ]);
    expect(meta.scope_drift).toEqual({
      scope_files: ["src/index.ts"],
      in_scope_files: ["src/index.ts"],
      out_of_scope_files: ["src/extra.ts"],
      untouched_scope_files: [],
      drift_detected: true,
    });
    expect(JSON.stringify(meta)).not.toContain("SUPER_SECRET_SOURCE_LINE_DO_NOT_DUMP");
  });

  it("enforces REVIEW_CONTEXT_PACK_MAX_BYTES (4096) with exact UTF-8 byte_length and code-point-safe truncation", () => {
    const sha = "a".repeat(40);
    const taskId = randomUUID();
    const multibyteExcerpt = `## Decisions\n${"界🚀".repeat(900)}`;

    const pack = boundReviewContextPack({
      task_id: taskId,
      reviewed_commit_sha: sha,
      head_sha: sha,
      last_commit_hash: sha,
      base_branch: "main",
      git_branch: "feat/test",
      diff_meta: {
        source: "git_diff",
        base_ref: "main",
        total_files: 2,
        additions: 18,
        deletions: 4,
        changed_files: [
          { path: "src/a.ts", status: "modified", additions: 10, deletions: 2, in_scope: true },
          { path: "src/b.ts", status: "added", additions: 8, deletions: 2, in_scope: true },
        ],
      },
      handoff_decisions: ["Keep reviewer context pack under 4096 UTF-8 JSON bytes."],
      verification_command: "pnpm test",
      epic_summary_excerpt: "Epic: Compact reviewer context",
      sync_board_excerpt: multibyteExcerpt,
      detail_pointers: {
        git_diff_command: `git diff main...${sha} --`,
        git_show_stat_command: `git show --stat ${sha}`,
        mcp_tools: ["get_document (outline_only: true or section)"],
      },
    });

    const parsed = ReviewContextPackSchema.parse(pack);
    const actualBytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
    expect(parsed.truncated).toBe(true);
    expect(parsed.byte_length).toBe(actualBytes);
    expect(actualBytes).toBeLessThanOrEqual(REVIEW_CONTEXT_PACK_MAX_BYTES);
    expect(parsed.sync_board_excerpt?.endsWith("…")).toBe(true);
    const prefix = parsed.sync_board_excerpt?.slice(0, -1) ?? "";
    expect(Buffer.from(prefix, "utf8").toString("utf8")).toBe(prefix);
  });

  it("builds review_context_pack on claim and refresh, reports exact byte_length, and rejects stale commits", async () => {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.com");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/service.ts"), "export const v = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "base commit");

    git(root, "checkout", "-b", "feat/review-pack");
    await writeFile(join(root, "src/service.ts"), "export const v = 2;\nexport const ok = true;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "update service");
    const headSha = git(root, "rev-parse", "HEAD");
    const staleSha = "f".repeat(40);

    await service.callTool("upsert_persona", { alias: "be", role: "backend", repos: ["be"] });
    await service.callTool("upsert_persona", {
      alias: "reviewer",
      role: "reviewer",
      repos: ["be"],
    });

    const { epic } = await service.callTool("create_epic", {
      title: "Compact Reviewer Delegation",
      description: "Scoped diff metadata and bounded context pack for reviewer delegation.",
    });
    const { created } = await service.callTool("create_tasks", {
      epic_id: epic.id,
      tasks: [
        {
          ref: "rev-ctx",
          title: "Build compact reviewer context",
          prompt_instruction: "Implement bounded reviewer context pack.",
          persona: "be",
          scope_files: ["src/service.ts"],
          verify_command: "pnpm test",
          doc_refs: ["blueprint"],
        },
      ],
    });
    const taskId = created[0]?.task_id;
    if (!taskId) throw new Error("Missing created task");

    await service.callTool("save_document", {
      slug: "sync-board",
      title: "sync-board",
      kind: "other",
      content: `## Decisions\n- Task ${taskId}: enforce 4096 UTF-8 byte cap for review_context_pack.\n`,
    });

    await service.callTool("manage_task", { action: "approve_plan", task_id: taskId });
    const claim = await service.callTool("claim_task", {
      task_id: taskId,
      agent_alias: "be",
    });

    await service.callTool("complete_handoff", {
      task_id: taskId,
      lease_id: claim.lease_id,
      handoff_summary: {
        files_modified: ["src/service.ts"],
        key_decisions: [
          "Keyed review_context_pack to task_id and head_sha.",
          "Enforced 4096-byte UTF-8 cap without raw source dumps.",
        ],
        verification_command: "pnpm lint && pnpm typecheck && pnpm test",
        notes_for_next_agent: "Ready for delegated reviewer check on feat/review-pack.",
        pull_request: {
          base_branch: "main",
          head_sha: headSha,
        },
        git_branch: "feat/review-pack",
        last_commit_hash: headSha,
      },
    });

    // 1. Stale head_sha on claim is rejected without acquiring a lease or returning stale pack.
    const staleClaim = await service.callTool("review_pull_request", {
      request: {
        action: "claim",
        task_id: taskId,
        agent_alias: "reviewer",
        head_sha: staleSha,
        include_context: true,
      },
    });
    expect(staleClaim).toMatchObject({
      task_id: taskId,
      stale_commit: true,
      warning: expect.stringContaining("head SHA"),
    });
    expect(staleClaim).not.toHaveProperty("lease_id");
    expect(staleClaim).not.toHaveProperty("review_context_pack");

    // 2. Claim with include_context: true returns full review_context_pack and exact byte_length.
    const claimed = await service.callTool("review_pull_request", {
      request: {
        action: "claim",
        task_id: taskId,
        agent_alias: "reviewer",
        head_sha: headSha,
        include_context: true,
      },
    });
    const validatedClaim = MCP_TOOLS.review_pull_request.output.parse(claimed);
    if ("reviews" in validatedClaim || !validatedClaim.review_context_pack) {
      throw new Error("Expected review_context_pack on claim");
    }
    expect(validatedClaim.lease_id).toBeDefined();
    expect(validatedClaim.byte_length).toBe(
      Buffer.byteLength(JSON.stringify(validatedClaim), "utf8"),
    );

    const pack = validatedClaim.review_context_pack;
    expect(pack.task_id).toBe(taskId);
    expect(pack.reviewed_commit_sha).toBe(headSha);
    expect(pack.head_sha).toBe(headSha);
    expect(pack.last_commit_hash).toBe(headSha);
    expect(pack.diff_meta.source).toBe("git_diff");
    expect(pack.diff_meta.total_files).toBe(1);
    expect(pack.diff_meta.additions).toBe(2);
    expect(pack.diff_meta.deletions).toBe(1);
    expect(pack.diff_meta.scope_drift?.drift_detected).toBe(false);
    expect(pack.handoff_decisions).toHaveLength(2);
    expect(pack.verification_command).toBe("pnpm lint && pnpm typecheck && pnpm test");
    expect(pack.task_verify_command).toBe("pnpm test");
    expect(pack.epic_summary_excerpt).toContain("Compact Reviewer Delegation");
    expect(pack.sync_board_excerpt).toContain("4096 UTF-8 byte cap");
    expect(pack.detail_pointers.doc_refs).toEqual(["blueprint"]);
    expect(pack.byte_length).toBe(Buffer.byteLength(JSON.stringify(pack), "utf8"));
    expect(pack.byte_length).toBeLessThanOrEqual(REVIEW_CONTEXT_PACK_MAX_BYTES);

    // 3. Stale head_sha on refresh is rejected with stale_commit: true.
    const staleRefresh = await service.callTool("review_pull_request", {
      request: {
        action: "refresh",
        task_id: taskId,
        head_sha: staleSha,
        include_context: true,
      },
    });
    expect(staleRefresh).toMatchObject({
      task_id: taskId,
      stale_commit: true,
      warning: expect.stringContaining("head SHA"),
    });
    expect(staleRefresh).not.toHaveProperty("review_context_pack");

    // 4. Refresh with include_context: true and compact: true returns compact pack + byte_length.
    const compactRefresh = await service.callTool("review_pull_request", {
      request: {
        action: "refresh",
        task_id: taskId,
        head_sha: headSha,
        include_context: true,
        compact: true,
      },
    });
    if ("reviews" in compactRefresh || !compactRefresh.review_context_pack) {
      throw new Error("Expected review_context_pack on refresh");
    }
    expect(compactRefresh.byte_length).toBe(
      Buffer.byteLength(JSON.stringify(compactRefresh), "utf8"),
    );
    expect(compactRefresh.review_context_pack.byte_length).toBeLessThanOrEqual(pack.byte_length);

    // 5. Submit with stale head_sha sets stale_commit: true and does not consume the lease.
    const staleSubmit = await service.callTool("review_pull_request", {
      request: {
        action: "submit",
        task_id: taskId,
        lease_id: validatedClaim.lease_id ?? "",
        head_sha: staleSha,
        decision: "approve",
        feedback: "Should not apply to stale commit.",
      },
    });
    expect(staleSubmit).toMatchObject({
      stale_commit: true,
      warning: expect.stringContaining("lease atau head SHA"),
    });

    // 6. CLI taskReview helper prints context pack summary and JSON cleanly.
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    await taskReview(
      service,
      {
        action: "refresh",
        task_id: taskId,
        head_sha: headSha,
        include_context: true,
        compact: true,
      },
      false,
    );
    expect(logs.some((line) => line.includes("Context pack: 1 file (+2/-1)"))).toBe(true);
  });
});
