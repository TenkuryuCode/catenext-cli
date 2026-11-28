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
  buildReviewContextPackFromSnapshot,
  clearReviewContextCache,
  collectScopedDiffMeta,
  collectScopedDiffMetaAsync,
  evaluateScopeDrift,
  getReviewContextCacheSize,
  matchesScopePattern,
  REVIEW_DIFF_CACHE_MAX_ENTRIES,
  snapshotReviewContext,
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
    clearReviewContextCache();
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

  it("parses renamed and binary files from combined --raw --numstat and falls back on missing commit", async () => {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.com");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/old.ts"), "export const x = 1;\nexport const y = 2;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "init");

    git(root, "checkout", "-b", "feat/rename-bin");
    git(root, "mv", "src/old.ts", "src/new.ts");
    await writeFile(join(root, "src/bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    git(root, "add", ".");
    git(root, "commit", "-m", "rename and binary");
    const headSha = git(root, "rev-parse", "HEAD");

    const meta = collectScopedDiffMeta({
      repoRoot: root,
      baseBranch: "main",
      headSha,
      handoffFiles: ["src/new.ts", "src/bin.dat"],
    });
    expect(meta.source).toBe("git_diff");
    expect(meta.changed_files).toEqual([
      {
        path: "src/bin.dat",
        status: "added",
        additions: 0,
        deletions: 0,
        binary: true,
      },
      {
        path: "src/new.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        previous_path: "src/old.ts",
      },
    ]);

    const missing = collectScopedDiffMeta({
      repoRoot: root,
      baseBranch: "main",
      headSha: "deadbeef".repeat(5),
      handoffFiles: ["src/new.ts"],
    });
    expect(missing.source).toBe("handoff_only");
    expect(missing.changed_files).toEqual([
      {
        path: "src/new.ts",
        status: "handoff",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it("caches raw git diff by (task_id, head_sha), invalidates on head_sha change, supports compact mode, and bounds LRU size", async () => {
    clearReviewContextCache();
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.com");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/base.ts"), "export const base = 0;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "init");

    git(root, "checkout", "-b", "feat/cache");
    for (let i = 0; i < 7; i += 1) {
      await writeFile(join(root, `src/f${i}.ts`), `export const n${i} = ${i};\n`);
    }
    git(root, "add", ".");
    git(root, "commit", "-m", "add 7 files");
    const headSha1 = git(root, "rev-parse", "HEAD");
    const taskId = randomUUID();

    // First call populates (taskId, headSha1) cache entry.
    const fullMeta = await collectScopedDiffMetaAsync({
      repoRoot: root,
      baseBranch: "main",
      headSha: headSha1,
      handoffFiles: ["src/f0.ts"],
      scopeFiles: ["src/f0.ts"],
      maxFiles: 15,
      taskId,
    });
    expect(getReviewContextCacheSize()).toBe(1);
    expect(fullMeta.total_files).toBe(7);
    expect(fullMeta.changed_files).toHaveLength(7);

    // Compact call on same (taskId, headSha1) hits cache (size stays 1) and applies compact file cap.
    const compactMeta = await collectScopedDiffMetaAsync({
      repoRoot: root,
      baseBranch: "main",
      headSha: headSha1,
      handoffFiles: ["src/f0.ts"],
      scopeFiles: ["src/f0.ts"],
      maxFiles: 5,
      taskId,
    });
    expect(getReviewContextCacheSize()).toBe(1);
    expect(compactMeta.total_files).toBe(7);
    expect(compactMeta.changed_files).toHaveLength(5);
    expect(compactMeta.files_truncated).toBe(true);
    expect(compactMeta.scope_drift?.drift_detected).toBe(true);

    // Build packs from snapshot in both full and compact modes using cached diff.
    const baseTask = {
      id: taskId,
      epicId: randomUUID(),
      title: "Cache test",
      instruction: "Test",
      status: "NEEDS_REVIEW" as const,
      dependencies: [],
      target: "be",
      role: "backend",
      persona: "be",
      position: 0,
      requiresApproval: true,
      revision: 0,
      stale: false,
      scope_files: ["src/f0.ts"],
      handoff: {
        files_modified: ["src/f0.ts"],
        key_decisions: ["Decision 1"],
        notes_for_next_agent: "Check",
        verification_command: "pnpm test",
        git_branch: "feat/cache",
        last_commit_hash: headSha1,
        pull_request: { base_branch: "main", head_sha: headSha1 },
      },
    };
    const baseReview = {
      ref: { base_branch: "main", head_sha: headSha1 },
      repo: "be",
      author: "be",
      updatedAt: new Date().toISOString(),
      approvedLocally: false,
    };
    const project = {
      repos: ["be"],
      epics: [],
      personas: [],
      tasks: [baseTask],
      documents: [],
      permissions: [],
      workspace_roots: [],
      session_prefs: {},
      platform_setup: [],
    };
    const fullPack = await buildReviewContextPackFromSnapshot(
      snapshotReviewContext({ project, task: baseTask, review: baseReview, compact: false }),
      root,
    );
    const compactPack = await buildReviewContextPackFromSnapshot(
      snapshotReviewContext({ project, task: baseTask, review: baseReview, compact: true }),
      root,
    );
    expect(getReviewContextCacheSize()).toBe(1);
    expect(fullPack.diff_meta.changed_files).toHaveLength(7);
    expect(compactPack.diff_meta.changed_files).toHaveLength(5);
    expect(compactPack.truncated).toBe(true);
    expect(compactPack.byte_length).toBeLessThan(fullPack.byte_length);

    // New commit changes headSha -> new cache entry with updated diff.
    await writeFile(join(root, "src/f7.ts"), "export const n7 = 7;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "add 8th file");
    const headSha2 = git(root, "rev-parse", "HEAD");
    const updatedMeta = await collectScopedDiffMetaAsync({
      repoRoot: root,
      baseBranch: "main",
      headSha: headSha2,
      handoffFiles: ["src/f0.ts"],
      taskId,
    });
    expect(getReviewContextCacheSize()).toBe(2);
    expect(updatedMeta.total_files).toBe(8);

    // LRU cache never grows past REVIEW_DIFF_CACHE_MAX_ENTRIES.
    // Batch parallel fill to avoid ~5s sequential git overhead while keeping final evictions deterministic.
    const batchSize = 16;
    for (let offset = 0; offset < REVIEW_DIFF_CACHE_MAX_ENTRIES; offset += batchSize) {
      const count = Math.min(batchSize, REVIEW_DIFF_CACHE_MAX_ENTRIES - offset);
      await Promise.all(
        Array.from({ length: count }, () =>
          collectScopedDiffMetaAsync({
            repoRoot: root,
            baseBranch: "main",
            headSha: headSha2,
            handoffFiles: ["src/f0.ts"],
            taskId: randomUUID(),
          }),
        ),
      );
    }
    for (let i = 0; i < 5; i += 1) {
      await collectScopedDiffMetaAsync({
        repoRoot: root,
        baseBranch: "main",
        headSha: headSha2,
        handoffFiles: ["src/f0.ts"],
        taskId: randomUUID(),
      });
    }
    expect(getReviewContextCacheSize()).toBe(REVIEW_DIFF_CACHE_MAX_ENTRIES);
  }, 15_000);

  it("rejects unsafe handoffFiles paths in handoff_only fallback while keeping safe repo-relative paths", () => {
    const meta = collectScopedDiffMeta({
      repoRoot: join(root, "missing-repo"),
      baseBranch: "main",
      headSha: "not-a-sha",
      handoffFiles: [
        "../outside.ts",
        "src/../../etc/passwd",
        "./../escape.ts",
        "/etc/passwd",
        "\\Windows\\System32\\cmd.exe",
        "C:\\Users\\secret.txt",
        "D:/drive/file.ts",
        "E:relative.ts",
        "src/null\0byte.ts",
        "src/ansi\x1b[31m.ts",
        "src/newline\n.ts",
        ".",
        "./",
        "",
        "src/safe.ts",
        "./src/normalized.ts",
        "src\\win-sep.ts",
      ],
      scopeFiles: ["src/**"],
    });

    expect(meta.source).toBe("handoff_only");
    expect(meta.changed_files).toEqual([
      { path: "src/safe.ts", status: "handoff", additions: 0, deletions: 0, in_scope: true },
      {
        path: "src/normalized.ts",
        status: "handoff",
        additions: 0,
        deletions: 0,
        in_scope: true,
      },
      { path: "src/win-sep.ts", status: "handoff", additions: 0, deletions: 0, in_scope: true },
    ]);
    expect(meta.scope_drift).toEqual({
      scope_files: ["src/**"],
      in_scope_files: ["src/safe.ts", "src/normalized.ts", "src/win-sep.ts"],
      out_of_scope_files: [],
      untouched_scope_files: [],
      drift_detected: false,
    });
  });

  it("scrubs secrets in diff_meta.base_ref, diff_meta.changed_files paths, and diff_meta.scope_drift entries", async () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234";
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.com");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, `src/old-${token}.ts`), "export const a = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "root commit");
    const headSha = git(root, "rev-parse", "HEAD");

    // Nonexistent baseBranch triggers diff-tree fallback where base_ref preserves baseBranch.
    const meta = collectScopedDiffMeta({
      repoRoot: root,
      baseBranch: `base/${token}`,
      headSha,
      handoffFiles: [`src/old-${token}.ts`],
      scopeFiles: [`src/scope-${token}.ts`],
    });

    expect(meta.source).toBe("git_diff");
    expect(meta.base_ref).toBe("base/[REDACTED:github_token]");
    expect(meta.changed_files).toEqual([
      {
        path: "src/old-[REDACTED:github_token].ts",
        status: "added",
        additions: 1,
        deletions: 0,
        in_scope: false,
      },
    ]);
    expect(meta.scope_drift).toEqual({
      scope_files: ["src/scope-[REDACTED:github_token].ts"],
      in_scope_files: [],
      out_of_scope_files: ["src/old-[REDACTED:github_token].ts"],
      untouched_scope_files: ["src/scope-[REDACTED:github_token].ts"],
      drift_detected: true,
    });
    expect(JSON.stringify(meta)).not.toContain(token);
  });

  it("derives detail_pointers.git_diff_command from diffMeta.base_ref when merge-base differs from baseBranch", async () => {
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.com");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "base commit");
    const mergeBaseSha = git(root, "rev-parse", "HEAD");

    git(root, "checkout", "-b", "feat/branch");
    await writeFile(join(root, "src/a.ts"), "export const a = 2;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "feature commit");
    const headSha = git(root, "rev-parse", "HEAD");

    // Advance main past the merge-base so diffMeta.base_ref resolves to mergeBaseSha !== "main".
    git(root, "checkout", "main");
    await writeFile(join(root, "src/other.ts"), "export const other = true;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "advance main");

    const pack = await buildReviewContextPackFromSnapshot(
      {
        taskId: randomUUID(),
        taskPersona: "be",
        baseBranch: "main",
        headSha,
        lastCommitHash: headSha,
        handoffFiles: ["src/a.ts"],
        handoffDecisions: ["Use merge-base for diff"],
        verificationCommand: "pnpm test",
        compact: false,
        maxBytes: REVIEW_CONTEXT_PACK_MAX_BYTES,
      },
      root,
    );

    expect(pack.base_branch).toBe("main");
    expect(pack.diff_meta.base_ref).toBe(mergeBaseSha);
    expect(pack.detail_pointers.git_diff_command).toBe(`git diff ${mergeBaseSha}...${headSha} --`);
  });
});
