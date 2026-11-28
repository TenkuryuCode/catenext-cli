import { isPlainObject, JSONRPC_INVALID_PARAMS } from "./protocol.js";
import type { GetPromptResult, HandlerResult, McpPrompt } from "./types.js";

interface PromptDefinition {
  prompt: McpPrompt;
  render: (args: Record<string, string>) => GetPromptResult;
}

const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    prompt: {
      name: "kickoff-brainstorm",
      title: "Kickoff Brainstorm",
      description:
        "Run an orchestrator-led cross-agent kickoff brainstorm and record shared contracts in sync-board.",
      arguments: [
        {
          name: "goal",
          description: "Feature or epic goal to align on before parallel work.",
          required: true,
        },
        {
          name: "personas",
          description: "Comma-separated persona aliases involved (e.g. be,fe,reviewer).",
          required: false,
        },
        {
          name: "epic_id",
          description: "Optional Catenext epic UUID for context.",
          required: false,
        },
      ],
    },
    render: (args) => {
      const personas = args.personas || "involved personas";
      const epicLine = args.epic_id ? `Epic: ${args.epic_id}\n` : "";
      return {
        description: "Orchestrator-led cross-agent kickoff brainstorm workflow",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Run a Catenext kickoff brainstorm for: ${args.goal}`,
                `${epicLine}Personas: ${personas}`,
                "",
                "Steps:",
                "1. Call session_brief and read catenext://documents/sync-board (get_document).",
                "2. Align on shared decisions, API/schema contracts, and open asks across the involved personas.",
                "3. Save compact outcomes to slug `sync-board` via save_document (no secrets, no code dumps, paths only).",
                "4. Inspect active worktrees via worktree_status and confirm DRAFT/TODO tasks, dependencies, and isolated worktree boundaries before delegating.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  },
  {
    prompt: {
      name: "rc-review",
      title: "Release Candidate Review",
      description:
        "Review a completed task handoff or release candidate for correctness, scope, and verification evidence (prefer MCP --role reviewer).",
      arguments: [
        {
          name: "task_id",
          description: "Task UUID in NEEDS_REVIEW (or target task to inspect).",
          required: true,
        },
        {
          name: "focus",
          description: "Optional review focus (e.g. security, tests, contracts).",
          required: false,
        },
      ],
    },
    render: (args) => {
      const focusLine = args.focus ? `Focus: ${args.focus}\n` : "";
      return {
        description: "Review a Catenext task handoff or release candidate",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Review Catenext task ${args.task_id}.`,
                focusLine ? focusLine.trimEnd() : undefined,
                "",
                "Steps:",
                `1. Inspect task details via get_project_board (task_id: ${args.task_id}), check worktree_status for dirty/ahead state or overlaps, and read catenext://handoffs/${args.task_id}.`,
                "2. Verify scope adherence, changed files, test/lint/typecheck evidence, and that no credentials or secrets were exposed.",
                "3. If issues exist, request revision on the same task with actionable feedback; otherwise submit review_pull_request recommendation or present the APPROVAL NEEDED card for human confirmation (catenext review approve).",
              ]
                .filter((line): line is string => line !== undefined)
                .join("\n"),
            },
          },
        ],
      };
    },
  },
  {
    prompt: {
      name: "docs-hygiene",
      title: "Docs Hygiene",
      description:
        "Audit and tidy Catenext project documents (blueprint, orchestrator, permissions, sync-board).",
      arguments: [
        {
          name: "slugs",
          description:
            "Optional comma-separated document slugs to focus on (default: blueprint, orchestrator, permissions, sync-board).",
          required: false,
        },
      ],
    },
    render: (args) => {
      const targets = args.slugs || "blueprint, orchestrator, permissions, sync-board";
      return {
        description: "Audit and tidy Catenext project documents",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Run Catenext docs hygiene for: ${targets}`,
                "",
                "Steps:",
                "1. List project documents via get_project_context and read target slugs (catenext://documents/{slug}).",
                "2. Drop or merge stale/duplicate slugs, keep one topic per doc (titles <= 120 chars), and ensure no secrets or code dumps.",
                "3. Update documents via save_document using expected_version.",
                "4. Report kept, merged, archived, and open questions without rewriting task handoff history.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  },
];

const PROMPT_BY_NAME = new Map<string, PromptDefinition>(
  PROMPT_DEFINITIONS.map((def) => [def.prompt.name, def]),
);

/** List all reusable Catenext workflow prompts. */
export function listPrompts(): HandlerResult<{ prompts: McpPrompt[] }> {
  return {
    ok: true,
    result: {
      prompts: PROMPT_DEFINITIONS.map((def) => def.prompt),
    },
  };
}

/** Validate params and render a parameterized Catenext workflow prompt. */
export function getPrompt(params: unknown): HandlerResult<GetPromptResult> {
  if (!isPlainObject(params) || typeof params.name !== "string" || params.name.length === 0) {
    return {
      ok: false,
      code: JSONRPC_INVALID_PARAMS,
      message: "Invalid prompts/get params: missing prompt name.",
    };
  }

  const def = PROMPT_BY_NAME.get(params.name);
  if (!def) {
    return {
      ok: false,
      code: JSONRPC_INVALID_PARAMS,
      message: `Prompt not found: ${params.name}`,
    };
  }

  if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
    return {
      ok: false,
      code: JSONRPC_INVALID_PARAMS,
      message: "Invalid prompts/get params: arguments must be an object.",
    };
  }

  const rawArgs = isPlainObject(params.arguments) ? params.arguments : {};
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawArgs)) {
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return {
        ok: false,
        code: JSONRPC_INVALID_PARAMS,
        message: `Invalid prompts/get argument "${key}": expected string.`,
      };
    }
    args[key] = value.trim();
  }

  for (const spec of def.prompt.arguments ?? []) {
    const value = args[spec.name];
    if (spec.required && (!value || value.length === 0)) {
      return {
        ok: false,
        code: JSONRPC_INVALID_PARAMS,
        message: `Missing required prompt argument: ${spec.name}`,
      };
    }
  }

  return {
    ok: true,
    result: def.render(args),
  };
}
