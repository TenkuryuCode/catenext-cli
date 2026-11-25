import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptFromServer, deviceLogin, newKeyPair } from "./device-login.js";

/** Cerminan encryptForClient di API (apps/api/src/routes/device.ts). */
function encryptForClient(secret: string, clientPublicKey: string): string {
  const eph = generateKeyPairSync("x25519");
  const pub = createPublicKey({
    key: Buffer.from(clientPublicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(shared).digest(), iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [eph.publicKey.export({ format: "der", type: "spki" }), iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("base64url"))
    .join(".");
}

describe("login lewat browser", () => {
  it("kunci hanya bisa dibuka oleh pasangan kunci CLI yang meminta", () => {
    const keys = newKeyPair();
    const blob = encryptForClient("ctnx_rahasia", keys.publicKey);
    expect(decryptFromServer(blob, keys.privateKey)).toBe("ctnx_rahasia");
    expect(() => decryptFromServer(blob, newKeyPair().privateKey)).toThrow();
  });

  it("menunggu authorization_pending lalu mengembalikan key", async () => {
    let publicKey = "";
    let polls = 0;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url.endsWith("/code")) {
        publicKey = body.public_key;
        return new Response(
          JSON.stringify({
            device_code: "d".repeat(43),
            user_code: "ABCD-EFGH",
            verification_uri: "http://web/device",
            verification_uri_complete: "http://web/device?code=ABCD-EFGH",
            expires_in: 600,
            interval: 1,
          }),
          { status: 201 },
        );
      }
      polls++;
      if (polls < 3) {
        return new Response(
          JSON.stringify({ error: { code: "authorization_pending", message: "tunggu" } }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          encrypted_key: encryptForClient("ctnx_abcdefghijklmnopqrstuvwxyz", publicKey),
          workspace_id: "11111111-2222-4333-8444-555555555555",
          project_id: null,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const lines: string[] = [];
    const key = await deviceLogin({
      apiUrl: "http://api",
      browser: false,
      fetch: fakeFetch,
      sleep: async () => {},
      log: (l) => lines.push(l),
    });
    expect(key).toBe("ctnx_abcdefghijklmnopqrstuvwxyz");
    expect(polls).toBe(3);
    expect(lines.join("\n")).toContain("ABCD-EFGH");
  });

  it("berhenti dengan pesan jelas bila ditolak", async () => {
    const fakeFetch = (async (url: string) =>
      url.endsWith("/code")
        ? new Response(
            JSON.stringify({
              device_code: "d".repeat(43),
              user_code: "ABCD-EFGH",
              verification_uri: "u",
              verification_uri_complete: "u",
              expires_in: 600,
              interval: 1,
            }),
            { status: 201 },
          )
        : new Response(
            JSON.stringify({
              error: { code: "access_denied", message: "Login ditolak di browser." },
            }),
            {
              status: 403,
            },
          )) as typeof fetch;
    await expect(
      deviceLogin({
        apiUrl: "http://api",
        browser: false,
        fetch: fakeFetch,
        sleep: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/ditolak/);
  });
});
