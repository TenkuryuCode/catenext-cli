import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  DEFAULT_PLATFORMS,
  type PlatformId,
  PlatformIdSchema,
  SUPPORTED_PLATFORMS,
} from "@catenext/shared";
import { detectStack } from "./init/detect.js";
import { type PersonaSeedMode, recommendPersonaAliases } from "./seed.js";

export type SetupOptionCard = {
  id: string;
  label: string;
  recommended: boolean;
  why: string;
};

export type InterviewSetupResult = {
  step: string;
  locale_hint: string;
  options: SetupOptionCard[];
  recommended_ids: string[];
  ask: string;
};

const PLATFORM_WHY: Partial<Record<PlatformId, string>> = {
  cursor: "Detected Cursor project files.",
  "claude-code": "Detected Claude Code MCP config.",
  codex: "Detected Codex config.",
  antigravity: "Detected Antigravity agents config.",
  opencode: "Detected OpenCode config.",
  vscode: "Detected VS Code MCP config.",
  windsurf: "Windsurf MCP is unsupported in this CLI.",
};

function detectPlatformHints(root: string): PlatformId[] {
  const hits: PlatformId[] = [];
  const checks: Array<[PlatformId, string]> = [
    ["cursor", ".cursor"],
    ["claude-code", ".mcp.json"],
    ["codex", ".codex"],
    ["antigravity", ".agents"],
    ["opencode", ".opencode"],
    ["vscode", ".vscode"],
  ];
  for (const [id, rel] of checks) {
    if (existsSync(join(root, rel))) hits.push(id);
  }
  return hits;
}

/** Compact option cards for orchestrator / CLI interview. Never essays. */
export function buildInterviewSetup(
  root: string,
  step: "platform" | "personas" | "locale" = "platform",
  stack: string[] = [],
): InterviewSetupResult {
  if (step === "locale") {
    return {
      step,
      locale_hint: "follow_user",
      options: [
        {
          id: "follow_user",
          label: "Mirror the user's language",
          recommended: true,
          why: "Orchestrator Q&A should match the user; agent files stay English.",
        },
        {
          id: "en",
          label: "English Q&A",
          recommended: false,
          why: "Force English for both Q&A and agents.",
        },
        {
          id: "id",
          label: "Indonesian Q&A",
          recommended: false,
          why: "Force Indonesian Q&A; agents remain English.",
        },
      ],
      recommended_ids: ["follow_user"],
      ask: "Which language should the orchestrator use when asking you questions?",
    };
  }

  if (step === "personas") {
    const matched = recommendPersonaAliases(stack);
    const stackHint = stack.length ? stack.join(", ") : "unknown";
    return {
      step,
      locale_hint: "follow_user",
      options: [
        {
          id: "matched",
          label: `Seed for this repo: ${matched.join(", ")}`,
          recommended: true,
          why: `Matched to stack [${stackHint}]. Add more later with persona set / sync.`,
        },
        {
          id: "minimal",
          label: "Seed be, fe, reviewer only",
          recommended: false,
          why: "Fixed small starter set; ignore stack match.",
        },
        {
          id: "all",
          label: "Seed be, fe, tester, android, security, reviewer, scribe",
          recommended: false,
          why: "Full catalog; use when you want every role stubbed up front.",
        },
        {
          id: "none",
          label: "Skip persona seed",
          recommended: false,
          why: "You will create personas manually.",
        },
      ],
      recommended_ids: ["matched"],
      ask: "Which persona seed should this project use?",
    };
  }

  const detected = detectPlatformHints(root);
  const recommended = detected.length
    ? detected.filter((id) => id !== "windsurf")
    : [...DEFAULT_PLATFORMS];
  const options: SetupOptionCard[] = SUPPORTED_PLATFORMS.filter((id) => id !== "windsurf").map(
    (id) => ({
      id,
      label: id,
      recommended: recommended.includes(id),
      why: detected.includes(id)
        ? (PLATFORM_WHY[id] ?? "Detected in this checkout.")
        : recommended.includes(id)
          ? "Common default for this CLI."
          : "Optional platform.",
    }),
  );
  return {
    step: "platform",
    locale_hint: "follow_user",
    options,
    recommended_ids: recommended,
    ask: "Which IDE/CLI platforms should Catenext install MCP for?",
  };
}

export function parsePlatformChoices(
  raw: string,
  recommended: readonly PlatformId[] = [...DEFAULT_PLATFORMS],
): PlatformId[] {
  const parts = raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 1 && (parts[0] === "recommended" || parts[0] === "default")) {
    return [...recommended];
  }
  const out: PlatformId[] = [];
  for (const part of parts) {
    const parsed = PlatformIdSchema.safeParse(part);
    if (!parsed.success) throw new Error(`Unsupported platform: ${part}`);
    if (parsed.data !== "windsurf") out.push(parsed.data);
  }
  return [...new Set(out)];
}

async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [${fallback}]: `, resolve);
    });
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

export type InterviewAnswers = {
  platforms: PlatformId[];
  personaSeed: PersonaSeedMode;
  locale: string;
  stack: string[];
};

export function parsePersonaSeed(raw: string): PersonaSeedMode {
  if (raw === "default") return "matched";
  if (raw === "all") return "all";
  if (raw === "minimal" || raw === "none" || raw === "matched") return raw;
  return "matched";
}

/** Interactive (TTY) or default (--yes / non-TTY) setup interview. */
export async function runInitInterview(
  root: string,
  opts: { yes?: boolean; platforms?: PlatformId[] },
): Promise<InterviewAnswers> {
  const stack = await detectStack(root);
  const platformCards = buildInterviewSetup(root, "platform", stack);
  const defaultPlatforms = opts.platforms?.length
    ? opts.platforms
    : (platformCards.recommended_ids as PlatformId[]);
  let platforms = defaultPlatforms;
  let personaSeed: PersonaSeedMode = "matched";
  let locale = "follow_user";

  if (!opts.yes && process.stdin.isTTY) {
    console.log(platformCards.ask);
    for (const card of platformCards.options) {
      console.log(`  ${card.recommended ? "*" : " "} ${card.id} — ${card.why}`);
    }
    const platformAnswer = await ask(
      "Platforms (comma-separated, or 'recommended')",
      defaultPlatforms.join(","),
    );
    platforms = parsePlatformChoices(platformAnswer, defaultPlatforms);

    const personaCards = buildInterviewSetup(root, "personas", stack);
    console.log(personaCards.ask);
    for (const card of personaCards.options) {
      console.log(`  ${card.recommended ? "*" : " "} ${card.id} — ${card.why}`);
    }
    const personaAnswer = await ask("Persona seed", "matched");
    personaSeed = parsePersonaSeed(personaAnswer);

    const localeCards = buildInterviewSetup(root, "locale", stack);
    console.log(localeCards.ask);
    for (const card of localeCards.options) {
      console.log(`  ${card.recommended ? "*" : " "} ${card.id} — ${card.why}`);
    }
    locale = await ask("Locale", "follow_user");
  }

  return { platforms, personaSeed, locale, stack };
}
