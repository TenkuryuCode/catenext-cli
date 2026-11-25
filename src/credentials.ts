import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { API_KEY_PREFIX } from "@catenext/shared";
import { z } from "zod";

/** Folder global Catenext (bukan di dalam repo). Bisa diganti lewat CATENEXT_HOME untuk tes. */
export function catenextHome(): string {
  return process.env.CATENEXT_HOME ?? join(homedir(), ".catenext");
}

export function credentialsPath(): string {
  return join(catenextHome(), "credentials.json");
}

/** URL API bila config & kredensial tidak menyebutkannya. Rilis npm menanam URL produksi saat build. */
export const DEFAULT_API_URL = process.env.CATENEXT_BUILD_API_URL || "http://localhost:8787";

const CredentialsSchema = z.object({
  api_key: z.string().startsWith(API_KEY_PREFIX),
  api_url: z.url().optional(),
  saved_at: z.string().optional(),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

export function validateApiKey(raw: string): string {
  const key = raw.trim();
  if (
    !key.startsWith(API_KEY_PREFIX) ||
    key.length < API_KEY_PREFIX.length + 16 ||
    /\s/.test(key)
  ) {
    throw new CredentialsError(
      `API key harus diawali "${API_KEY_PREFIX}" tanpa spasi. Salin ulang dari Dashboard > Security.`,
    );
  }
  return key;
}

/** Simpan kredensial dengan izin 0600 (folder 0700), ditulis atomik lewat file sementara. */
export async function saveCredentials(creds: { api_key: string; api_url?: string }) {
  const dir = catenextHome();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const data: Credentials = { ...creds, saved_at: new Date().toISOString() };
  const target = credentialsPath();
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
  await chmod(target, 0o600);
  return target;
}

/** Urutan: env CATENEXT_API_KEY, lalu ~/.catenext/credentials.json. */
export async function loadCredentials(): Promise<Credentials> {
  const fromEnv = process.env.CATENEXT_API_KEY;
  if (fromEnv) return { api_key: validateApiKey(fromEnv) };

  let raw: string;
  try {
    raw = await readFile(credentialsPath(), "utf8");
  } catch {
    throw new CredentialsError(
      "Belum login. Jalankan `catenext login` lalu tempel API key dari Dashboard.",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CredentialsError(`${credentialsPath()} rusak. Jalankan \`catenext login\` ulang.`);
  }
  const parsed = CredentialsSchema.safeParse(json);
  if (!parsed.success) {
    throw new CredentialsError(
      `${credentialsPath()} tidak valid. Jalankan \`catenext login\` ulang.`,
    );
  }
  return parsed.data;
}

/** Urutan api_url: env CATENEXT_API_URL, config.yaml, credentials.json, default lokal. */
export function resolveApiUrl(configUrl?: string, credsUrl?: string): string {
  return (process.env.CATENEXT_API_URL ?? configUrl ?? credsUrl ?? DEFAULT_API_URL).replace(
    /\/+$/,
    "",
  );
}
