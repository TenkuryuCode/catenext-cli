import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CatenextConfigSchema,
  estimateTokens,
  type HandoffSummary,
  type McpToolName,
} from "@catenext/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { LocalService } from "../local-service.js";
import type { McpRole } from "./catalog.js";
import { createCatenextMcpServer } from "./server.js";
import type { McpTransport } from "./stdio.js";

const exec = promisify(execFile);

/** Asserts that a lookup result is defined at runtime and returns it narrowed. */
function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

interface CallMeasurement {
  tool: McpToolName;
  responseBytes: number;
  text: string;
}

interface ScenarioResult {
  scenario: "new_task" | "revision" | "review";
  strategy: string;
  toolCalls: number;
  totalResponseBytes: number;
  proxyTokenEstimate: number;
  decisionsRetrieved: boolean;
  claimLockP50Ms: number;
  claimLockP95Ms: number;
  perCallBytes: Array<{ tool: string; bytes: number }>;
}

const tempRoots: string[] = [];
const activeClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (activeClosers.length > 0) {
    await activeClosers.pop()?.();
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function createTempGitRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["config", "user.email", "bench@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "Bench"], { cwd: dir });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/auth.ts"), "export const version = 1;\n", "utf8");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

async function connectMcp(
  service: LocalService,
  root: string,
  opts: { role?: McpRole; allowCrud?: boolean } = {},
) {
  const server = createCatenextMcpServer({
    version: "0.17.0-bench",
    context: async () => ({ ok: true, service, root }),
    log: () => {},
    role: opts.role,
    allowCrud: opts.allowCrud,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bench-client", version: "1.0.0" });
  const transport: McpTransport = {
    async start() {
      a.onmessage = transport.onmessage;
      a.onclose = transport.onclose;
      await a.start();
    },
    async send(msg) {
      await a.send(msg as never);
    },
    async close() {
      await a.close();
    },
  };
  await server.connect(transport);
  await client.connect(b);
  activeClosers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callMcpTool(
  client: Client,
  name: McpToolName,
  args: Record<string, unknown>,
): Promise<CallMeasurement> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  const text = first?.text ?? "";
  expect(result.isError, `${name}: ${text}`).not.toBe(true);
  return {
    tool: name,
    responseBytes: Buffer.byteLength(text, "utf8"),
    text,
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[idx] ?? 0).toFixed(2));
}

function buildSyncBoardContent(entries: Array<{ taskId: string; decision: string }>): string {
  const filler = [
    "## Overview",
    "This board coordinates backend, reviewer, and scribe work across the sprint.",
    "All agents must keep handoffs concise, cite file paths only, and never embed secrets.",
    "## Architecture",
    "- API handlers live under `apps/cli/src/mcp/` and delegate to `LocalService`.",
    "- SQLite persistence uses `.catenext/catenext.sqlite` with `.lock` coordination.",
    "- Code graph indexes imports and symbols into `graph_files` and `graph_edges`.",
    "- Skills are discovered from `.catenext/skills/` with frontmatter metadata.",
    "## Decisions",
    ...entries.map(
      (e) =>
        `- Task ${e.taskId} (be): ${e.decision} — use compact JSON schemas and bounded excerpts.`,
    ),
    "## Open Asks",
    "- ASK: reviewer · NEED: verify lock hold time and response byte budgets · BLOCKS: release",
  ];
  return filler.join("\n\n");
}

function makeHandoff(sha: string, tag: string): HandoffSummary {
  return {
    files_modified: ["apps/cli/src/mcp/catalog.ts", "apps/cli/src/local-claim-context.ts"],
    key_decisions: [`${tag}: keep schema compact and preserve uuid format`],
    verification_command: "pnpm --filter catenext exec vitest run src/mcp",
    notes_for_next_agent:
      `${tag} completed cleanly. ` +
      "Verified compact schema stripping, role filtering, and bounded sync-board excerpt behavior in isolated unit tests.",
    git_branch: `feat/${tag.toLowerCase()}`,
    last_commit_hash: sha,
  };
}

async function setupSeededProject(repoRoot: string) {
  const config = CatenextConfigSchema.parse({
    schema_version: 1,
    project_id: randomUUID(),
    project_name: "BenchProject",
    repo_name: "catenext",
  });
  const service = new LocalService(repoRoot, config);
  await service.callTool("upsert_persona", {
    alias: "be",
    role: "backend",
    rules: ["Own API, services, and tests."],
    repos: [],
  });
  await service.callTool("upsert_persona", {
    alias: "reviewer",
    role: "reviewer",
    rules: ["Review handoffs and diffs for correctness."],
    repos: [],
  });
  const { epic } = await service.callTool("create_epic", { title: "MCP Context Efficiency" });
  return { config, service, epicId: epic.id };
}

describe("MCP context pack, compact handoffs, and artifact retrieval benchmark", () => {
  it("measures tools/list role-filtering bytes and proxy token estimates", async () => {
    const repoRoot = await createTempGitRepo("catenext-bench-tools-");
    const { service } = await setupSeededProject(repoRoot);

    const profiles: Array<{ name: string; role?: McpRole; allowCrud?: boolean }> = [
      { name: "default_no_crud", role: undefined, allowCrud: false },
      { name: "all_with_crud", role: undefined, allowCrud: true },
      { name: "orchestrator_no_crud", role: "orchestrator", allowCrud: false },
      { name: "worker_no_crud", role: "worker", allowCrud: false },
    ];

    const summary: Array<{
      profile: string;
      toolCount: number;
      responseBytes: number;
      proxyTokenEstimate: number;
    }> = [];

    for (const profile of profiles) {
      const client = await connectMcp(service, repoRoot, {
        role: profile.role,
        allowCrud: profile.allowCrud,
      });
      const listed = await client.listTools();
      const json = JSON.stringify({ tools: listed.tools });
      const bytes = Buffer.byteLength(json, "utf8");
      summary.push({
        profile: profile.name,
        toolCount: listed.tools.length,
        responseBytes: bytes,
        proxyTokenEstimate: estimateTokens(json),
      });
    }

    const byName = new Map(summary.map((row) => [row.profile, row]));
    const getProfile = (name: string) =>
      requireValue(byName.get(name), `Missing benchmark profile summary: ${name}`);
    const worker = getProfile("worker_no_crud");
    const orch = getProfile("orchestrator_no_crud");
    const def = getProfile("default_no_crud");
    const all = getProfile("all_with_crud");
    expect(worker.toolCount).toBe(15);
    expect(orch.toolCount).toBe(24);
    expect(def.toolCount).toBe(29);
    expect(all.toolCount).toBe(33);
    expect(worker.responseBytes).toBeLessThan(def.responseBytes * 0.65);
    expect(orch.responseBytes).toBeLessThan(all.responseBytes * 0.8);

    if (process.env.CATENEXT_BENCHMARK_PRINT === "1") {
      console.log("TOOLS_LIST_BENCHMARK", JSON.stringify(summary));
    }
  });

  it("benchmarks new task, revision, and review scenarios across retrieval strategies", async () => {
    const results: ScenarioResult[] = [];
    const iterations = 10;

    // ------------------------------------------------------------------
    // Scenario 1: New Task (2 dependency handoffs + sync-board decision)
    // ------------------------------------------------------------------
    {
      const repoRoot = await createTempGitRepo("catenext-bench-new-");
      const sha = await gitHead(repoRoot);
      const { service, epicId } = await setupSeededProject(repoRoot);
      const { created } = await service.callTool("create_tasks", {
        epic_id: epicId,
        tasks: [
          {
            ref: "dep1",
            title: "Dep 1",
            prompt_instruction: "Complete dep 1",
            persona: "be",
            role: "backend",
          },
          {
            ref: "dep2",
            title: "Dep 2",
            prompt_instruction: "Complete dep 2",
            persona: "be",
            role: "backend",
          },
          {
            ref: "target",
            title: "Implement compact MCP handler",
            prompt_instruction: "Implement handler following sync-board decisions.",
            persona: "be",
            role: "backend",
            depends_on: ["dep1", "dep2"],
            scope_files: ["apps/cli/src/mcp/server.ts"],
          },
        ],
      });
      const id = (ref: string) =>
        requireValue(
          created.find((t) => t.ref === ref),
          `Missing created task ref: ${ref}`,
        ).task_id;
      for (const ref of ["dep1", "dep2"]) {
        await service.callTool("manage_task", { action: "approve_plan", task_id: id(ref) });
        const c = await service.callTool("claim_task", { task_id: id(ref), agent_alias: "be" });
        await service.callTool("complete_handoff", {
          task_id: id(ref),
          lease_id: c.lease_id,
          handoff_summary: makeHandoff(sha, ref.toUpperCase()),
        });
        await service.callTool("manage_task", { action: "approve", task_id: id(ref) });
      }
      await service.callTool("manage_task", { action: "approve_plan", task_id: id("target") });
      await service.callTool("save_document", {
        slug: "sync-board",
        title: "Sync Board",
        kind: "decision",
        content: buildSyncBoardContent([{ taskId: id("target"), decision: "DECISION-ALPHA-42" }]),
      });

      const client = await connectMcp(service, repoRoot, { role: "worker" });

      const strategies = [
        {
          name: "A_unpacked_full_doc",
          compact: false,
          includeContext: false,
          mode: "full" as const,
        },
        {
          name: "B1_compact_outline_section",
          compact: true,
          includeContext: false,
          mode: "outline_section" as const,
        },
        {
          name: "B2_compact_direct_section",
          compact: true,
          includeContext: false,
          mode: "direct_section" as const,
        },
        {
          name: "C_compact_context_pack",
          compact: true,
          includeContext: true,
          mode: "none" as const,
        },
      ];

      for (const strat of strategies) {
        const lockTimes: number[] = [];
        let lastClaim!: CallMeasurement;
        for (let i = 0; i < iterations; i++) {
          const t0 = performance.now();
          lastClaim = await callMcpTool(client, "claim_task", {
            task_id: id("target"),
            agent_alias: "be",
            compact: strat.compact,
            include_context: strat.includeContext,
          });
          lockTimes.push(performance.now() - t0);
          const leaseId = (JSON.parse(lastClaim.text) as { lease_id: string }).lease_id;
          if (i < iterations - 1) {
            await callMcpTool(client, "release_task", {
              task_id: id("target"),
              lease_id: leaseId,
            });
          }
        }

        const calls: CallMeasurement[] = [lastClaim];
        if (strat.mode === "full") {
          calls.push(await callMcpTool(client, "get_document", { slug: "sync-board" }));
        } else if (strat.mode === "outline_section") {
          calls.push(
            await callMcpTool(client, "get_document", { slug: "sync-board", outline_only: true }),
          );
          calls.push(
            await callMcpTool(client, "get_document", {
              slug: "sync-board",
              section: "Decisions",
            }),
          );
        } else if (strat.mode === "direct_section") {
          calls.push(
            await callMcpTool(client, "get_document", {
              slug: "sync-board",
              section: "Decisions",
            }),
          );
        }

        const leaseId = (JSON.parse(lastClaim.text) as { lease_id: string }).lease_id;
        calls.push(
          await callMcpTool(client, "complete_handoff", {
            task_id: id("target"),
            lease_id: leaseId,
            handoff_summary: makeHandoff(sha, "TARGET"),
          }),
        );

        const combinedText = calls.map((c) => c.text).join("\n");
        const hasDecision = combinedText.includes("DECISION-ALPHA-42");
        const hasDep1 = combinedText.includes("DEP1: keep schema compact");
        const hasDep2 = combinedText.includes("DEP2: keep schema compact");
        expect({ strategy: strat.name, hasDecision, hasDep1, hasDep2 }).toEqual({
          strategy: strat.name,
          hasDecision: true,
          hasDep1: true,
          hasDep2: true,
        });
        const decisionsRetrieved = hasDecision && hasDep1 && hasDep2;

        const totalBytes = calls.reduce((acc, c) => acc + c.responseBytes, 0);
        results.push({
          scenario: "new_task",
          strategy: strat.name,
          toolCalls: calls.length,
          totalResponseBytes: totalBytes,
          proxyTokenEstimate: estimateTokens(combinedText),
          decisionsRetrieved,
          claimLockP50Ms: percentile(lockTimes, 50),
          claimLockP95Ms: percentile(lockTimes, 95),
          perCallBytes: calls.map((c) => ({ tool: c.tool, bytes: c.responseBytes })),
        });

        // Reset task back to TODO for next strategy by releasing via revision or direct service
        // Since complete_handoff moved it to NEEDS_REVIEW, revise + approve resets to TODO cleanly.
        await service.callTool("manage_task", {
          action: "request_revision",
          task_id: id("target"),
          feedback: "Reset for next benchmark strategy",
        });
      }
    }

    // ------------------------------------------------------------------
    // Scenario 2: Revision (revision_count >= 1 + feedback + sync-board)
    // ------------------------------------------------------------------
    {
      const repoRoot = await createTempGitRepo("catenext-bench-rev-");
      const sha = await gitHead(repoRoot);
      const { service, epicId } = await setupSeededProject(repoRoot);
      const { created } = await service.callTool("create_tasks", {
        epic_id: epicId,
        tasks: [
          {
            ref: "dep1",
            title: "Base schema",
            prompt_instruction: "Create base schema",
            persona: "be",
            role: "backend",
          },
          {
            ref: "rev_target",
            title: "Fix validation edge case",
            prompt_instruction: "Apply review feedback.",
            persona: "be",
            role: "backend",
            depends_on: ["dep1"],
          },
        ],
      });
      const id = (ref: string) =>
        requireValue(
          created.find((t) => t.ref === ref),
          `Missing created task ref: ${ref}`,
        ).task_id;
      await service.callTool("manage_task", { action: "approve_plan", task_id: id("dep1") });
      const depClaim = await service.callTool("claim_task", {
        task_id: id("dep1"),
        agent_alias: "be",
      });
      await service.callTool("complete_handoff", {
        task_id: id("dep1"),
        lease_id: depClaim.lease_id,
        handoff_summary: makeHandoff(sha, "DEP1"),
      });
      await service.callTool("manage_task", { action: "approve", task_id: id("dep1") });

      await service.callTool("manage_task", { action: "approve_plan", task_id: id("rev_target") });
      const firstClaim = await service.callTool("claim_task", {
        task_id: id("rev_target"),
        agent_alias: "be",
      });
      await service.callTool("complete_handoff", {
        task_id: id("rev_target"),
        lease_id: firstClaim.lease_id,
        handoff_summary: makeHandoff(sha, "FIRST_PASS"),
      });
      await service.callTool("manage_task", {
        action: "request_revision",
        task_id: id("rev_target"),
        feedback: "REVISION-FIX-99: reject empty slug before writing to SQLite.",
      });
      await service.callTool("save_document", {
        slug: "sync-board",
        title: "Sync Board",
        kind: "decision",
        content: buildSyncBoardContent([
          { taskId: id("rev_target"), decision: "DECISION-BETA-17" },
        ]),
      });

      const client = await connectMcp(service, repoRoot, { role: "worker" });

      const strategies = [
        {
          name: "A_unpacked_full_doc",
          compact: false,
          includeContext: false,
          mode: "full" as const,
        },
        {
          name: "B2_compact_direct_section",
          compact: true,
          includeContext: false,
          mode: "direct_section" as const,
        },
        {
          name: "C_compact_context_pack",
          compact: true,
          includeContext: true,
          mode: "none" as const,
        },
      ];

      for (const strat of strategies) {
        const lockTimes: number[] = [];
        let lastClaim!: CallMeasurement;
        for (let i = 0; i < iterations; i++) {
          const t0 = performance.now();
          lastClaim = await callMcpTool(client, "claim_task", {
            task_id: id("rev_target"),
            agent_alias: "be",
            compact: strat.compact,
            include_context: strat.includeContext,
          });
          lockTimes.push(performance.now() - t0);
          const leaseId = (JSON.parse(lastClaim.text) as { lease_id: string }).lease_id;
          if (i < iterations - 1) {
            await callMcpTool(client, "release_task", {
              task_id: id("rev_target"),
              lease_id: leaseId,
            });
          }
        }

        const calls: CallMeasurement[] = [lastClaim];
        if (strat.mode === "full") {
          calls.push(await callMcpTool(client, "get_document", { slug: "sync-board" }));
        } else if (strat.mode === "direct_section") {
          calls.push(
            await callMcpTool(client, "get_document", {
              slug: "sync-board",
              section: "Decisions",
            }),
          );
        }

        const leaseId = (JSON.parse(lastClaim.text) as { lease_id: string }).lease_id;
        calls.push(
          await callMcpTool(client, "complete_handoff", {
            task_id: id("rev_target"),
            lease_id: leaseId,
            handoff_summary: makeHandoff(sha, "REV_DONE"),
          }),
        );

        const combinedText = calls.map((c) => c.text).join("\n");
        const decisionsRetrieved =
          combinedText.includes("REVISION-FIX-99") && combinedText.includes("DECISION-BETA-17");
        expect(decisionsRetrieved).toBe(true);

        const totalBytes = calls.reduce((acc, c) => acc + c.responseBytes, 0);
        results.push({
          scenario: "revision",
          strategy: strat.name,
          toolCalls: calls.length,
          totalResponseBytes: totalBytes,
          proxyTokenEstimate: estimateTokens(combinedText),
          decisionsRetrieved,
          claimLockP50Ms: percentile(lockTimes, 50),
          claimLockP95Ms: percentile(lockTimes, 95),
          perCallBytes: calls.map((c) => ({ tool: c.tool, bytes: c.responseBytes })),
        });

        await service.callTool("manage_task", {
          action: "request_revision",
          task_id: id("rev_target"),
          feedback: "REVISION-FIX-99: reject empty slug before writing to SQLite.",
        });
      }
    }

    // ------------------------------------------------------------------
    // Scenario 3: Review (review_pull_request claim + diff + sync-board)
    // ------------------------------------------------------------------
    {
      const repoRoot = await createTempGitRepo("catenext-bench-review-");
      await writeFile(join(repoRoot, "src/auth.ts"), "export const version = 2;\n", "utf8");
      await exec("git", ["add", "src/auth.ts"], { cwd: repoRoot });
      await exec("git", ["commit", "-m", "feat: bump auth version"], { cwd: repoRoot });
      const headSha = await gitHead(repoRoot);

      const { service, epicId } = await setupSeededProject(repoRoot);
      const { created } = await service.callTool("create_tasks", {
        epic_id: epicId,
        tasks: [
          {
            ref: "rev_task",
            title: "Update auth version",
            prompt_instruction: "Bump auth version and verify.",
            persona: "be",
            role: "backend",
            scope_files: ["src/auth.ts"],
          },
        ],
      });
      const taskId = requireValue(created[0], "Expected at least one created task").task_id;
      await service.callTool("manage_task", { action: "approve_plan", task_id: taskId });
      const claim = await service.callTool("claim_task", { task_id: taskId, agent_alias: "be" });
      await service.callTool("complete_handoff", {
        task_id: taskId,
        lease_id: claim.lease_id,
        handoff_summary: {
          files_modified: ["src/auth.ts"],
          key_decisions: ["DECISION-REVIEW-73: bump auth version to 2"],
          verification_command: "pnpm test",
          notes_for_next_agent:
            "Updated src/auth.ts to version 2 and verified all downstream callers remain compatible with the exported constant.",
          git_branch: "main",
          last_commit_hash: headSha,
          pull_request: { base_branch: "main", head_sha: headSha },
        },
      });
      await service.callTool("save_document", {
        slug: "sync-board",
        title: "Sync Board",
        kind: "decision",
        content: buildSyncBoardContent([{ taskId, decision: "DECISION-REVIEW-73" }]),
      });

      const strategies = [
        {
          name: "A_unpacked_full_doc",
          compact: false,
          includeContext: false,
          mode: "full" as const,
        },
        {
          name: "B2_compact_direct_section",
          compact: true,
          includeContext: false,
          mode: "direct_section" as const,
        },
        {
          name: "C_compact_review_pack",
          compact: true,
          includeContext: true,
          mode: "none" as const,
        },
      ];

      for (const strat of strategies) {
        const client = await connectMcp(service, repoRoot, { role: "worker" });
        const lockTimes: number[] = [];
        let claimCall!: CallMeasurement;
        // Measure review claim + submit across iterations (re-opening review via request_revision + re-handoff)
        for (let i = 0; i < iterations; i++) {
          const t0 = performance.now();
          claimCall = await callMcpTool(client, "review_pull_request", {
            request: {
              action: "claim",
              task_id: taskId,
              agent_alias: "reviewer",
              compact: strat.compact,
              include_context: strat.includeContext,
            },
          });
          lockTimes.push(performance.now() - t0);
          if (i < iterations - 1) {
            const leaseId = (JSON.parse(claimCall.text) as { lease_id: string }).lease_id;
            await callMcpTool(client, "review_pull_request", {
              request: {
                action: "submit",
                task_id: taskId,
                head_sha: headSha,
                lease_id: leaseId,
                decision: "request_changes",
                feedback: "Re-open for next benchmark iteration",
              },
            });
            const reClaim = await service.callTool("claim_task", {
              task_id: taskId,
              agent_alias: "be",
            });
            await service.callTool("complete_handoff", {
              task_id: taskId,
              lease_id: reClaim.lease_id,
              handoff_summary: {
                files_modified: ["src/auth.ts"],
                key_decisions: ["DECISION-REVIEW-73: bump auth version to 2"],
                verification_command: "pnpm test",
                notes_for_next_agent:
                  "Updated src/auth.ts to version 2 and verified all downstream callers remain compatible with the exported constant.",
                git_branch: "main",
                last_commit_hash: headSha,
                pull_request: { base_branch: "main", head_sha: headSha },
              },
            });
          }
        }

        const calls: CallMeasurement[] = [claimCall];
        if (strat.mode === "full") {
          calls.push(await callMcpTool(client, "get_document", { slug: "sync-board" }));
        } else if (strat.mode === "direct_section") {
          calls.push(
            await callMcpTool(client, "get_document", {
              slug: "sync-board",
              section: "Decisions",
            }),
          );
        }

        const leaseId = (JSON.parse(claimCall.text) as { lease_id: string }).lease_id;
        calls.push(
          await callMcpTool(client, "review_pull_request", {
            request: {
              action: "submit",
              task_id: taskId,
              head_sha: headSha,
              lease_id: leaseId,
              decision: "approve",
              feedback: "LGTM: verified auth version bump and tests.",
            },
          }),
        );

        const combinedText = calls.map((c) => c.text).join("\n");
        const decisionsRetrieved =
          combinedText.includes("DECISION-REVIEW-73") && combinedText.includes("src/auth.ts");
        expect(decisionsRetrieved).toBe(true);

        const totalBytes = calls.reduce((acc, c) => acc + c.responseBytes, 0);
        results.push({
          scenario: "review",
          strategy: strat.name,
          toolCalls: calls.length,
          totalResponseBytes: totalBytes,
          proxyTokenEstimate: estimateTokens(combinedText),
          decisionsRetrieved,
          claimLockP50Ms: percentile(lockTimes, 50),
          claimLockP95Ms: percentile(lockTimes, 95),
          perCallBytes: calls.map((c) => ({ tool: c.tool, bytes: c.responseBytes })),
        });

        // Reset review state back to NEEDS_REVIEW for next strategy
        await service.callTool("manage_task", {
          action: "request_revision",
          task_id: taskId,
          feedback: "Reset for next benchmark strategy",
        });
        const reClaim = await service.callTool("claim_task", {
          task_id: taskId,
          agent_alias: "be",
        });
        await service.callTool("complete_handoff", {
          task_id: taskId,
          lease_id: reClaim.lease_id,
          handoff_summary: {
            files_modified: ["src/auth.ts"],
            key_decisions: ["DECISION-REVIEW-73: bump auth version to 2"],
            verification_command: "pnpm test",
            notes_for_next_agent:
              "Updated src/auth.ts to version 2 and verified all downstream callers remain compatible with the exported constant.",
            git_branch: "main",
            last_commit_hash: headSha,
            pull_request: { base_branch: "main", head_sha: headSha },
          },
        });
      }
    }

    // Assert every scenario retrieved its required decisions
    expect(results.every((r) => r.decisionsRetrieved)).toBe(true);

    // Assert compact + context pack reduces tool calls vs baseline in new_task and revision
    const findResult = (scenario: ScenarioResult["scenario"], strategy: string) =>
      requireValue(
        results.find((r) => r.scenario === scenario && r.strategy === strategy),
        `Missing benchmark result for ${scenario} / ${strategy}`,
      );
    const newA = findResult("new_task", "A_unpacked_full_doc");
    const newC = findResult("new_task", "C_compact_context_pack");
    expect(newC.toolCalls).toBeLessThan(newA.toolCalls);
    expect(newC.totalResponseBytes).toBeLessThan(newA.totalResponseBytes);

    const revA = findResult("revision", "A_unpacked_full_doc");
    const revC = findResult("revision", "C_compact_context_pack");
    expect(revC.toolCalls).toBeLessThan(revA.toolCalls);
    expect(revC.totalResponseBytes).toBeLessThan(revA.totalResponseBytes);

    if (process.env.CATENEXT_BENCHMARK_PRINT === "1") {
      console.log("SCENARIO_BENCHMARK", JSON.stringify(results));
    }
  }, 60_000);
});
