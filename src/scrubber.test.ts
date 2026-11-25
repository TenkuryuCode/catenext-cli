import { describe, expect, it } from "vitest";
import { scrubDeep, scrubText } from "./scrubber.js";

describe("scrubText", () => {
  it.each([
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_token"],
    ["AKIAABCDEFGHIJKLMNOP", "aws_key"],
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "llm_api_key"],
    ["ctnx_AbCdEfGhIjKlMnOpQrStUv", "catenext_key"],
    ["xoxb-1234567890-abcdefghij", "slack_token"],
    ["sk_live_abcdefghijklmnop", "stripe_key"],
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

  it("menyensor password di URL tapi mempertahankan host", () => {
    const out = scrubText("DATABASE_URL=postgres://app:s3cr3tPass@localhost:5432/db");
    expect(out).not.toContain("s3cr3tPass");
    expect(out).toContain("@localhost:5432/db");
  });

  it("menyensor nilai assignment env tapi mempertahankan nama variabel", () => {
    const out = scrubText("Set STRIPE_SECRET=abc123xyz dan JWT_SECRET: 'superlongvaluehere'");
    expect(out).toBe(
      "Set STRIPE_SECRET=[REDACTED:assignment] dan JWT_SECRET: '[REDACTED:assignment]'",
    );
  });

  it("menyensor private key", () => {
    const out = scrubText("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----");
    expect(out).toBe("[REDACTED:private_key]");
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
