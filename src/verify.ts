import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatenextConfig } from "@catenext/shared";
import { AgentApi, ApiRequestError } from "./api-client.js";
import { CredentialsError, loadCredentials, resolveApiUrl } from "./credentials.js";
import { ADAPTERS, readMcpEntry } from "./init/mcp-config.js";
import { entryIsStale } from "./maintenance.js";

export interface CheckLine {
  ok: boolean;
  label: string;
  hint?: string;
}

/** Verifikasi 3 baris: token API, konfigurasi MCP, akses proyek. */
export async function verifySetup(root: string, config: CatenextConfig): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];

  let tokenLine: CheckLine;
  let projectLine: CheckLine;
  try {
    const creds = await loadCredentials();
    const api = new AgentApi({
      baseUrl: resolveApiUrl(config.api_url, creds.api_url),
      apiKey: creds.api_key,
      projectId: config.project_id,
      repoName: config.repo_name,
      agentName: () => "catenext-cli",
    });
    const res = await api.post<{ project: { name: string } }>("verify");
    tokenLine = { ok: true, label: "Token API valid" };
    projectLine = {
      ok: true,
      label: `Akses proyek "${res.project.name}" aktif (repo ${config.repo_name})`,
    };
  } catch (err) {
    if (err instanceof CredentialsError) {
      tokenLine = { ok: false, label: "Token API valid", hint: err.message };
      projectLine = { ok: false, label: "Akses baca proyek aktif", hint: "Butuh token API dulu." };
    } else if (err instanceof ApiRequestError && (err.status === 401 || err.status === null)) {
      tokenLine = { ok: false, label: "Token API valid", hint: err.message };
      projectLine = { ok: false, label: "Akses baca proyek aktif", hint: "Butuh token API dulu." };
    } else {
      tokenLine = { ok: true, label: "Token API valid" };
      projectLine = {
        ok: false,
        label: "Akses baca proyek aktif",
        hint: `${(err as Error).message} Periksa project_id di .catenext/config.yaml.`,
      };
    }
  }

  const found: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const adapter of ADAPTERS) {
    const src = await readFile(join(root, adapter.path), "utf8").catch(() => null);
    const entry = src ? readMcpEntry(src) : null;
    if (!entry) missing.push(adapter.label);
    else if (entryIsStale(entry)) stale.push(adapter.label);
    else found.push(adapter.label);
  }
  const mcpLine: CheckLine =
    missing.length > 0
      ? {
          ok: false,
          label: "Konfigurasi MCP terbaca",
          hint: `Entri "catenext" belum ada untuk ${missing.join(", ")}. Jalankan \`catenext init\`.`,
        }
      : stale.length > 0
        ? {
            ok: false,
            label: "Konfigurasi MCP terbaca",
            hint: `Entri "catenext" untuk ${stale.join(", ")} menunjuk ke path yang sudah tidak ada. Jalankan \`catenext sync --fix\`.`,
          }
        : { ok: true, label: `Konfigurasi MCP terbaca (${found.join(", ")})` };

  lines.push(tokenLine, mcpLine, projectLine);
  return lines;
}

export function formatChecks(lines: CheckLine[]): string {
  return lines
    .map((l) => `${l.ok ? "✓" : "✗"} ${l.label}${l.hint && !l.ok ? `\n    → ${l.hint}` : ""}`)
    .join("\n");
}
