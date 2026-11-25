import { z } from "zod";
import { IdSchema } from "./common.js";

/**
 * Login CLI lewat browser (device authorization, mirip RFC 8628). CLI meminta kode, pengguna
 * menyetujui di Web, CLI menerima API key baru tanpa perlu menyalin-tempel.
 */
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 3;

/** Format kode yang diketik/dicek manusia: XXXX-XXXX tanpa huruf ambigu. */
export const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const UserCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/, "Kode harus 8 karakter, mis. ABCD-EFGH")
  .transform((s) => (s.includes("-") ? s : `${s.slice(0, 4)}-${s.slice(4)}`));

export const DeviceCodeInput = z.object({
  /** Nama mesin/klien yang ditampilkan saat menyetujui, mis. "catenext CLI @ macbook". */
  client_name: z.string().trim().min(1).max(80),
  /**
   * Public key X25519 sementara milik CLI (SPKI DER, base64url). API key hasil persetujuan
   * dienkripsi ke kunci ini, jadi baris database saja tidak cukup untuk membacanya.
   */
  public_key: z.string().min(40).max(200),
});

export const DeviceCodeOutput = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number().int(),
  interval: z.number().int(),
});

export const DeviceTokenInput = z.object({ device_code: z.string().min(20).max(200) });
export const DeviceTokenOutput = z.object({
  /** API key terenkripsi ke public_key CLI: <pub efemeral>.<iv>.<tag>.<ciphertext> (base64url). */
  encrypted_key: z.string(),
  workspace_id: IdSchema,
  project_id: IdSchema.nullable(),
});

/** Kode error saat polling (HTTP 400/403/410). */
export const DEVICE_ERRORS = ["authorization_pending", "access_denied", "expired_token"] as const;

export const DeviceLookupOutput = z.object({
  user_code: z.string(),
  client_name: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
  expires_at: z.string(),
});

export const DeviceApproveInput = z.object({
  user_code: UserCodeSchema,
  approve: z.boolean(),
  /** Batasi API key ke satu proyek (disarankan). null = semua proyek di workspace. */
  project_id: IdSchema.nullish(),
});
