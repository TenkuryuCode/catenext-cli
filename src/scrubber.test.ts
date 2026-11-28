import { describe, expect, it, vi } from "vitest";
import { readResource } from "./mcp/handlers/resources.js";
import { createToolInvoker } from "./mcp/handlers/tools.js";
import { scrubDeep, scrubText } from "./scrubber.js";

describe("scrubText", () => {
  it.each([
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_token"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123456789", "github_token"],
    ["ghu_abcdefghijklmnopqrstuvwxyz0123456789", "github_token"],
    ["ghs_abcdefghijklmnopqrstuvwxyz0123456789", "github_token"],
    ["ghr_abcdefghijklmnopqrstuvwxyz0123456789", "github_token"],
    ["github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_token"],
    ["npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "npm_token"],
    ["AKIAABCDEFGHIJKLMNOP", "aws_key"],
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "llm_api_key"],
    ["sk-proj-abcdefghijklmnopqrstuvwxyz1234", "llm_api_key"],
    ["sk-svcacct-abcdefghijklmnop1234", "llm_api_key"],
    ["ctnx_AbCdEfGhIjKlMnOpQrStUv", "catenext_key"],
    ["xoxb-1234567890-abcdefghij", "slack_token"],
    ["xoxa-1234567890-abcdefghij", "slack_token"],
    ["xoxp-1234567890-abcdefghij", "slack_token"],
    ["xoxr-1234567890-abcdefghij", "slack_token"],
    ["xoxs-1234567890-abcdefghij", "slack_token"],
    ["xapp-1-A0123456789-1234567890-abcdef", "slack_token"],
    ["sk_live_abcdefghijklmnop", "stripe_key"],
    [["AIza", "SyTestFixture", "0123456789abcdef012345"].join(""), "google_api_key"],
    ["hf_abcdefghijklmnopqrstuvwxyz0123456789", "huggingface_token"],
    ["glpat-abcdefghijklmnopqrstuv", "gitlab_token"],
    ["pypi-AgEIcHlwaS5vcmcCJDEyMzQ1Njc4", "pypi_token"],
    [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "jwt",
    ],
  ])("menyensor %s", (secret, kind) => {
    const counts: Record<string, number> = {};
    const out = scrubText(`pakai ${secret} untuk tes`, counts);
    expect(out).not.toContain(secret);
    expect(out).toContain(`[REDACTED:${kind}]`);
    expect(counts[kind]).toBe(1);
  });

  it("menyensor password di URL tapi mempertahankan scheme dan host", () => {
    const out = scrubText("DATABASE_URL=postgres://app:s3cr3tPass@localhost:5432/db");
    expect(out).toBe("DATABASE_URL=postgres://app:[REDACTED:url_password]@localhost:5432/db");

    const counts: Record<string, number> = {};
    const ghUrl = scrubText(
      "https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/org/repo.git",
      counts,
    );
    expect(ghUrl).toBe("https://x-access-token:[REDACTED:url_password]@github.com/org/repo.git");
    expect(counts).toEqual({ url_password: 1 });

    expect(scrubText("https://:mySecretToken123@gitlab.com/org/repo.git")).toBe(
      "https://:[REDACTED:url_password]@gitlab.com/org/repo.git",
    );
    expect(scrubText("redis://default:p%40ss%3A1@redis.internal:6379/0")).toBe(
      "redis://default:[REDACTED:url_password]@redis.internal:6379/0",
    );
  });

  it("tidak merusak URL non-secret, link PR, git SHA, UUID, atau identifier normal", () => {
    const safeInputs = [
      "https://github.com/TenkuryuCode/catenext/pull/57",
      "https://github.com/TenkuryuCode/catenext/commit/dc82c581dec4bdd7bb1b46625b76af70073fde6d",
      "ssh://git@github.com/TenkuryuCode/catenext.git",
      "https://example.com:8443/@handle/profile",
      "[https://example.com:8080](mailto:a@b.com)",
      "Task ce87deb2-c018-48c0-9832-b5c8c5a3a1a6 at base dc82c58",
      "Env var npm_package_config_registry and https://registry.npmjs.org/@catenext/cli",
    ];
    for (const input of safeInputs) {
      expect(scrubText(input)).toBe(input);
    }
  });

  it("menyensor nilai assignment env tapi mempertahankan nama variabel", () => {
    const out = scrubText("Set STRIPE_SECRET=abc123xyz dan JWT_SECRET: 'superlongvaluehere'");
    expect(out).toBe(
      "Set STRIPE_SECRET=[REDACTED:assignment] dan JWT_SECRET: '[REDACTED:assignment]'",
    );
  });

  it("menyensor pasangan kunci JSON ber-kutip", () => {
    const out = scrubText(
      '{"api_key": "supersecretkey123", "password": "pw_with_digits_1", "note": "ok"}',
    );
    expect(out).not.toContain("supersecretkey123");
    expect(out).not.toContain("pw_with_digits_1");
    expect(out).toContain('"api_key": "[REDACTED:assignment]"');
    expect(out).toContain('"password": "[REDACTED:assignment]"');
    expect(out).toContain('"note": "ok"');
  });

  it.each([
    "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQE\n-----END PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIabc\n-----END EC PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHzBJBgkqhkiG\n-----END ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGabc\n-----END PGP PRIVATE KEY BLOCK-----",
    "-----BEGIN PRIVATE KEY-----\nunclosed-key-body",
  ])("menyensor blok private key PEM/PGP", (pem) => {
    const out = scrubText(`before\n${pem}\nafter`);
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).toContain("[REDACTED:private_key]");
  });

  it("tidak menyensor blok PUBLIC KEY atau CERTIFICATE", () => {
    const pub = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG\n-----END PUBLIC KEY-----";
    expect(scrubText(pub)).toBe(pub);
  });

  it("tidak mengubah prosa biasa", () => {
    const text =
      "Token lease diperpanjang tiap panggilan; auth memakai Better-Auth. password: hashed. Jalankan pnpm test.";
    expect(scrubText(text)).toBe(text);
  });
});

describe("scrubDeep", () => {
  it("menyensor string bersarang dan melewati kunci tertentu", () => {
    const r = scrubDeep(
      {
        task_id: "x",
        handoff_summary: {
          key_decisions: ["Pakai ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
          notes_for_next_agent: "aman",
          last_commit_hash: "abcdef1",
        },
      },
      new Set(["last_commit_hash"]),
    );
    expect(r.total).toBe(1);
    expect(r.value.handoff_summary.key_decisions[0]).toBe("Pakai [REDACTED:github_token]");
    expect(r.value.handoff_summary.last_commit_hash).toBe("abcdef1");
  });
});

describe("quoted multi-word secrets", () => {
  it("redacts double-quoted, single-quoted, escaped-quote, and JSON multi-word secrets while preserving quotes", () => {
    expect(scrubText('PASSWORD="my synthetic secret pass 123"')).toBe(
      'PASSWORD="[REDACTED:assignment]"',
    );
    expect(scrubText("API_SECRET='correct horse battery staple'")).toBe(
      "API_SECRET='[REDACTED:assignment]'",
    );
    expect(scrubText('API_KEY="my \\"escaped\\" synthetic secret"')).toBe(
      'API_KEY="[REDACTED:assignment]"',
    );
    expect(scrubText('{"password": "my synthetic secret 123", "note": "ok"}')).toBe(
      '{"password": "[REDACTED:assignment]", "note": "ok"}',
    );
  });

  it("does not redact short quoted values, already-redacted placeholders, or span across newlines", () => {
    expect(scrubText('PASSWORD="short"')).toBe('PASSWORD="short"');
    const redactedCounts: Record<string, number> = {};
    expect(scrubText('PASSWORD="[REDACTED:assignment]"', redactedCounts)).toBe(
      'PASSWORD="[REDACTED:assignment]"',
    );
    expect(redactedCounts).toEqual({});

    const multiline = 'PASSWORD="short\nline2"';
    expect(scrubText(multiline)).toBe(multiline);
  });
});

describe("MCP tool and resource scrubbing", () => {
  it("scrubs unlisted tool inputs with DEFAULT_SCRUB_SKIP_KEYS and scrubs MCP tool outputs", async () => {
    const epicId = "11111111-1111-4111-8111-111111111111";
    const receivedInputs: Array<{ name: string; input: unknown }> = [];
    const logs: string[] = [];

    const invoker = createToolInvoker({
      context: async () => ({
        ok: true,
        root: "/tmp/synthetic-catenext-root",
        service: {
          callTool: async (name: string, input: unknown) => {
            receivedInputs.push({ name, input });
            if (name === "epic_run") {
              return {
                epic_id: epicId,
                notes: "leaked output token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
              };
            }
            return { ok: true };
          },
        } as never,
      }),
      log: (msg) => logs.push(msg),
      supportsResourceLinks: () => false,
      supportsStructuredContent: () => false,
    });

    const res = await invoker("epic_run", {
      epic_id: epicId,
      action: "preview",
      base: "main",
      check: 'PASSWORD="my synthetic secret pass 123" pnpm test',
    });

    expect(res.isError).toBeUndefined();
    expect(receivedInputs).toEqual([
      {
        name: "epic_run",
        input: {
          epic_id: epicId,
          action: "preview",
          base: "main",
          check: 'PASSWORD="[REDACTED:assignment]" pnpm test',
        },
      },
    ]);
    const textPayload = res.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(textPayload).not.toContain("my synthetic secret pass 123");
    expect(textPayload).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(textPayload).toContain("[REDACTED:github_token]");
    expect(logs.length).toBe(2);
  });

  it("scrubs secrets from resources/read for both documents and handoffs", async () => {
    const taskId = "22222222-2222-4222-8222-222222222222";
    const callTool = vi.fn(async (name: string) => {
      if (name === "get_document") {
        return {
          slug: "blueprint",
          content: 'API_SECRET="synthetic multi word secret"\nBearer sk_live_abcdefghijklmnop1234',
        };
      }
      if (name === "get_project_context") {
        return {
          recent_handoffs: [
            {
              task_id: taskId,
              title: "Test handoff",
              handoff_summary: {
                last_commit_hash: "abcdef1",
                git_branch: "catenext/test",
                notes_for_next_agent: 'PASSWORD="synthetic handoff secret 99"',
              },
            },
          ],
        };
      }
      return {};
    });

    const context = async () => ({
      ok: true as const,
      root: "/tmp/nonexistent-catenext-root",
      service: { callTool } as never,
    });

    const docRes = await readResource(context, { uri: "catenext://documents/blueprint" });
    expect(docRes.ok).toBe(true);
    if (docRes.ok) {
      const text = docRes.result.contents[0]?.text ?? "";
      expect(text).not.toContain("synthetic multi word secret");
      expect(text).not.toContain("sk_live_abcdefghijklmnop1234");
      expect(text).toContain('API_SECRET="[REDACTED:assignment]"');
      expect(text).toContain("[REDACTED:stripe_key]");
    }

    const handoffRes = await readResource(context, { uri: `catenext://handoffs/${taskId}` });
    expect(handoffRes.ok).toBe(true);
    if (handoffRes.ok) {
      const text = handoffRes.result.contents[0]?.text ?? "";
      expect(text).not.toContain("synthetic handoff secret 99");
      expect(text).toContain("[REDACTED:assignment]");
      expect(text).toContain("abcdef1");
    }
  });
});

describe("embedding chunk secret scrubbing", () => {
  it("redacts provider env assignments, bearer tokens, and quoted multi-word secrets in code chunks", () => {
    const openaiKey = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz1234"].join("");
    const adminKey = ["sk-admin-", "abcdefghijklmnop1234"].join("");
    const geminiKey = ["AIza", "SyTestFixture", "0123456789abcdef012345"].join("");
    const bearer = ["Bearer ", "syntheticBearerToken1234567890"].join("");

    const chunk = [
      `OPENAI_API_KEY="${openaiKey}"`,
      `GEMINI_API_KEY='${geminiKey}'`,
      `const admin = "${adminKey}";`,
      `const header = "${bearer}";`,
      `const cfg = { password: "my synthetic multi word pass 99" };`,
    ].join("\n");

    const counts: Record<string, number> = {};
    const out = scrubText(chunk, counts);

    expect(out).not.toContain(openaiKey);
    expect(out).not.toContain(geminiKey);
    expect(out).not.toContain(adminKey);
    expect(out).not.toContain("syntheticBearerToken1234567890");
    expect(out).not.toContain("my synthetic multi word pass 99");
    expect(out).toContain("[REDACTED:llm_api_key]");
    expect(out).toContain("[REDACTED:google_api_key]");
    expect(out).toContain("[REDACTED:bearer_token]");
    expect(out).toContain("[REDACTED:assignment]");
    expect(counts.llm_api_key).toBeGreaterThanOrEqual(1);
    expect(counts.google_api_key).toBeGreaterThanOrEqual(1);
    expect(counts.bearer_token).toBe(1);
    expect(counts.assignment).toBeGreaterThanOrEqual(1);
  });
});
