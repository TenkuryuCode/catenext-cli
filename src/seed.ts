import type { LocalProject } from "./local-state.js";

/** Default personas seeded on init (English rules for agents). */
export const DEFAULT_PERSONAS: LocalProject["personas"] = [
  {
    alias: "be",
    role: "backend",
    repos: [],
    rules: [
      "Own API, services, data layer, and migrations.",
      "Write tests for behavior you change.",
      "Do not edit frontend UI or mobile app code unless the task explicitly requires a shared contract.",
    ],
  },
  {
    alias: "fe",
    role: "frontend",
    repos: [],
    rules: [
      "Own web UI, client state, and accessibility of interactive surfaces.",
      "Prefer existing design tokens and components.",
      "Do not change backend schemas without a BE task dependency.",
    ],
  },
  {
    alias: "tester",
    role: "testing",
    repos: [],
    rules: [
      "Own automated tests, fixtures, and regression coverage.",
      "Prefer failing tests that reproduce the bug before fixes.",
      "Do not ship product features; file blockers when requirements are ambiguous.",
    ],
  },
  {
    alias: "android",
    role: "android",
    repos: [],
    rules: [
      "Own Android app code, Gradle modules, and device-specific behavior.",
      "Keep shared contracts in sync with BE/FE tasks.",
    ],
  },
  {
    alias: "security",
    role: "security",
    repos: [],
    rules: [
      "Review auth, secrets handling, input validation, and dependency risk.",
      "Never print secrets into handoffs or documents.",
      "Request revision when security requirements are unmet.",
    ],
  },
  {
    alias: "reviewer",
    role: "reviewer",
    repos: [],
    rules: [
      "Review handoffs and PRs for correctness, scope, and test evidence.",
      "Use request_revision with specific feedback; do not rewrite the task as a new item.",
    ],
  },
  {
    alias: "scribe",
    role: "docs",
    repos: [],
    rules: [
      "Own project documents hygiene: blueprint, orchestrator, permissions, sync-board, decisions.",
      "Load skill `docs-hygiene` before large tidy passes.",
      "You may `save_document` for project docs only; no application code edits.",
      "Keep docs short; no secrets or code dumps.",
    ],
  },
];

export const DEFAULT_PERMISSIONS: LocalProject["permissions"] = [
  { action: "approve_plan", principal: "human" },
  { action: "edit_setup", principal: "human" },
  { action: "edit_setup", principal: "orchestrator" },
  { action: "manage_roots", principal: "human" },
  { action: "manage_roots", principal: "orchestrator" },
  { action: "upsert_persona", principal: "human" },
  { action: "upsert_persona", principal: "orchestrator" },
];

const iso = () => new Date().toISOString();

export function starterDocuments(updatedBy = "catenext-init"): LocalProject["documents"] {
  const at = iso();
  const docs: Array<{
    slug: string;
    title: string;
    kind: "blueprint" | "other" | "decision";
    body: string;
  }> = [
    {
      slug: "blueprint",
      title: "Project blueprint",
      kind: "blueprint",
      body: [
        "# Blueprint",
        "",
        "Local Catenext project. Orchestrator asks the user first (user language), then delegates to English-persona subagents.",
        "",
        "- Storage: `.catenext/catenext.sqlite`",
        "- Default personas: be, fe, tester, android, security, reviewer, scribe",
        "- Kickoff: cross-agent brainstorm → document `sync-board`",
        "- External folders: register with `catenext root add` and assign an owning persona",
      ].join("\n"),
    },
    {
      slug: "orchestrator",
      title: "Orchestrator guide",
      kind: "other",
      body: [
        "# Orchestrator",
        "",
        "1. Ask the user first; mirror their language for Q&A.",
        "2. Call `interview_setup` / `session_brief` for compact options and next steps.",
        "3. Before parallel work: short brainstorm with involved personas; save to `sync-board` (skill `cross-agent-sync`).",
        "4. Delegate only; concurrent personas each use a separate git worktree.",
        "5. Watch all worktrees; after handoffs integrate if needed, then ask: PR | merge | revise | next.",
        "6. Docs tidy: delegate persona `scribe` with skill `docs-hygiene`.",
        "7. Keep tool outputs brief; no code dumps or secrets.",
      ].join("\n"),
    },
    {
      slug: "permissions",
      title: "Permission matrix",
      kind: "decision",
      body: [
        "# Permissions",
        "",
        "| Action | Who |",
        "| --- | --- |",
        "| approve_plan | human |",
        "| edit_setup | human, orchestrator |",
        "| manage_roots | human, orchestrator |",
        "| upsert_persona | human, orchestrator |",
        "",
        "Human CLI remains the hard gate for approve / approve_plan.",
      ].join("\n"),
    },
    {
      slug: "sync-board",
      title: "Cross-agent sync board",
      kind: "decision",
      body: [
        "# Sync board",
        "",
        "UPDATED: (set on each write)",
        "",
        "## DECISIONS",
        "",
        "- (kickoff brainstorm outcomes)",
        "",
        "## CONTRACTS",
        "",
        "- (be ↔ fe, api shapes, events — one line each)",
        "",
        "## OPEN ASKS",
        "",
        "- (from <persona> to <persona>: …)",
        "",
        "Protocol: skill `cross-agent-sync`. Personas read this after claim; orchestrator owns updates unless `scribe` is tidying.",
      ].join("\n"),
    },
  ];
  return docs.map((doc) => ({
    slug: doc.slug,
    title: doc.title,
    kind: doc.kind,
    version: 1,
    updated_by: updatedBy,
    updated_at: at,
    size: doc.body.length,
    content: doc.body,
  }));
}

/** Seed empty project fields used after first init transaction. */
export function applyProjectSeed(
  project: LocalProject,
  options: {
    platforms?: string[];
    locale?: string;
    personaSeed?: "default" | "minimal" | "none";
  } = {},
): void {
  if (project.personas.length === 0 && options.personaSeed !== "none") {
    const source =
      options.personaSeed === "minimal"
        ? DEFAULT_PERSONAS.filter((persona) => ["be", "fe", "reviewer"].includes(persona.alias))
        : DEFAULT_PERSONAS;
    project.personas = source.map((persona) => ({
      ...persona,
      rules: [...persona.rules],
      repos: [...persona.repos],
    }));
  }
  if (project.permissions.length === 0) {
    project.permissions = DEFAULT_PERMISSIONS.map((row) => ({ ...row }));
  }
  if (project.documents.length === 0) {
    project.documents = starterDocuments();
  }
  if (options.platforms?.length) {
    project.platform_setup = [
      ...new Set([...(project.platform_setup ?? []), ...options.platforms]),
    ];
  }
  if (options.locale) {
    project.session_prefs = { ...project.session_prefs, locale: options.locale };
  }
}
