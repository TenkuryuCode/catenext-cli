import { describe, expect, it } from "vitest";
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
