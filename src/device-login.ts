import { spawn } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { hostname } from "node:os";
import { DeviceCodeOutput, DeviceTokenOutput } from "@catenext/shared";
import { ApiRequestError } from "./api-client.js";

/**
 * `catenext login` lewat browser: minta kode, buka halaman persetujuan, lalu tunggu.
 * CLI membuat pasangan kunci X25519 sementara; API key dikirim balik terenkripsi ke kunci
 * itu, jadi tidak pernah tersimpan polos di server selama menunggu.
 */

export function newKeyPair(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    privateKey,
  };
}

export function decryptFromServer(blob: string, privateKey: KeyObject): string {
  const [pub, iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!pub || !iv || !tag || !data) throw new Error("Balasan login rusak.");
  const serverKey = createPublicKey({ key: pub, format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey, publicKey: serverKey });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(shared).digest(),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function openBrowser(url: string): boolean {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown) {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ApiRequestError(
      `Tidak bisa menghubungi Catenext API (${(err as Error).message}). Periksa --api-url.`,
      null,
      "network_error",
    );
  }
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return { status: res.status, json };
}

export interface DeviceLoginOptions {
  apiUrl: string;
  /** false = jangan coba membuka browser (mis. lewat SSH). */
  browser: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export async function deviceLogin(opts: DeviceLoginOptions): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const keys = newKeyPair();

  const start = await postJson(fetchImpl, `${opts.apiUrl}/api/v1/cli-auth/code`, {
    client_name: `catenext CLI @ ${hostname()}`.slice(0, 80),
    public_key: keys.publicKey,
  });
  const code = DeviceCodeOutput.safeParse(start.json);
  if (start.status !== 201 || !code.success) {
    throw new ApiRequestError(
      start.json.error?.message ??
        `Server di ${opts.apiUrl} belum mendukung login lewat browser. Pakai \`catenext login --with-key\`.`,
      start.status,
      start.json.error?.code ?? "device_unsupported",
    );
  }

  const { user_code, verification_uri_complete, verification_uri, interval, expires_in } =
    code.data;
  log(`Buka ${verification_uri_complete}`);
  log(`lalu pastikan kodenya sama: ${user_code}  (berlaku ${Math.round(expires_in / 60)} menit)`);
  if (opts.browser && openBrowser(verification_uri_complete)) {
    log("Browser dibuka. Menunggu persetujuan...");
  } else {
    log(`(Tidak membuka browser. Buka ${verification_uri} di perangkat mana pun.)`);
  }

  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const poll = await postJson(fetchImpl, `${opts.apiUrl}/api/v1/cli-auth/token`, {
      device_code: code.data.device_code,
    });
    if (poll.status === 200) {
      const token = DeviceTokenOutput.safeParse(poll.json);
      if (!token.success)
        throw new ApiRequestError("Balasan login tidak valid.", 200, "bad_response");
      return decryptFromServer(token.data.encrypted_key, keys.privateKey);
    }
    const errCode = poll.json.error?.code;
    if (errCode === "authorization_pending") continue;
    throw new ApiRequestError(
      poll.json.error?.message ?? `Login gagal (HTTP ${poll.status}).`,
      poll.status,
      errCode ?? "device_error",
    );
  }
  throw new ApiRequestError(
    "Kode login kedaluwarsa. Jalankan `catenext login` lagi.",
    410,
    "expired_token",
  );
}
