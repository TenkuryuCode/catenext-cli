import { AGENT_HEADERS, ApiErrorSchema, QUOTA_WARNING_HEADER } from "@catenext/shared";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface AgentApiOptions {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  repoName: string;
  /** Nama klien MCP (mis. "claude-code", "cursor"); dibaca saat request agar terisi setelah handshake. */
  agentName?: () => string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Dipanggil saat API mengirim peringatan kuota (≥80%). */
  onWarning?: (message: string) => void;
}

/**
 * Klien HTTP untuk /api/v1/agent. project_id dan repo_name selalu berasal dari
 * .catenext/config.yaml (dikirim lewat header), tidak pernah dari input agen.
 */
export class AgentApi {
  private warning: string | undefined;
  constructor(private readonly opts: AgentApiOptions) {}

  /** Ambil (dan hapus) peringatan kuota terakhir, untuk disisipkan ke hasil tool MCP. */
  takeWarning(): string | undefined {
    const w = this.warning;
    this.warning = undefined;
    return w;
  }

  post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  put<T = unknown>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  private async request<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
    const url = `${this.opts.baseUrl}/api/v1/agent/${path}`;
    const doFetch = this.opts.fetch ?? fetch;
    const agent = sanitizeAgentName(this.opts.agentName?.());
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
          [AGENT_HEADERS.project]: this.opts.projectId,
          [AGENT_HEADERS.repo]: this.opts.repoName,
          [AGENT_HEADERS.agent]: agent,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new ApiRequestError(
        `Tidak bisa menghubungi Catenext API di ${this.opts.baseUrl} (${(err as Error).message}). Pastikan API berjalan (pnpm dev) atau periksa api_url.`,
        null,
        "network_error",
      );
    }

    const warning = res.headers.get(QUOTA_WARNING_HEADER);
    if (warning) {
      this.warning = warning;
      this.opts.onWarning?.(warning);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(json);
      if (parsed.success) {
        throw new ApiRequestError(
          parsed.data.error.message,
          res.status,
          parsed.data.error.code,
          parsed.data.error.details,
        );
      }
      throw new ApiRequestError(
        `Catenext API membalas HTTP ${res.status}. Periksa api_url (${this.opts.baseUrl}).`,
        res.status,
        "http_error",
      );
    }
    if (json === undefined) {
      throw new ApiRequestError(
        `Respons Catenext API bukan JSON. Periksa api_url (${this.opts.baseUrl}).`,
        res.status,
        "bad_response",
      );
    }
    return json as T;
  }
}

export function sanitizeAgentName(name: string | undefined): string {
  const clean = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || "agent";
}
