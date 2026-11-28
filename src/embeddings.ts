import {
  type EmbeddingProvider,
  type EmbeddingsConfig,
  isValidEmbeddingEndpoint,
} from "@catenext/shared";
import { scrubText } from "./scrubber.js";

export const DEFAULT_EMBEDDING_TIMEOUT_MS = 15_000;

export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  ollama: "nomic-embed-text",
  gemini: "text-embedding-004",
  openai: "text-embedding-3-small",
};

export const DEFAULT_EMBEDDING_ENDPOINTS: Record<EmbeddingProvider, string> = {
  ollama: "http://127.0.0.1:11434",
  gemini: "https://generativelanguage.googleapis.com",
  openai: "https://api.openai.com/v1",
};

export type EmbeddingErrorCode =
  | "invalid_endpoint"
  | "missing_api_key"
  | "timeout"
  | "network_error"
  | "provider_error"
  | "invalid_response";

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly status?: number;

  constructor(
    code: EmbeddingErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "EmbeddingError";
    this.code = code;
    this.status = options?.status;
  }
}

export interface EmbedClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface EmbeddingClient {
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly dimensions?: number;
  readonly endpoint: string;
  embed(texts: readonly string[], options?: EmbedClientOptions): Promise<Float32Array[]>;
}

/** Validate that an embedding endpoint URL uses http/https without embedded credentials. */
export function validateEmbeddingEndpoint(raw: string): URL {
  if (!isValidEmbeddingEndpoint(raw)) {
    throw new EmbeddingError(
      "invalid_endpoint",
      "Embedding endpoint must be a valid http/https URL without embedded credentials.",
    );
  }
  return new URL(raw);
}

function normalizeBaseUrl(raw: string): string {
  const url = validateEmbeddingEndpoint(raw);
  return url.toString().replace(/\/+$/, "");
}

function requireApiKey(
  envVar: "OPENAI_API_KEY" | "GEMINI_API_KEY",
  provider: EmbeddingProvider,
): string {
  const key = process.env[envVar]?.trim();
  if (!key) {
    throw new EmbeddingError(
      "missing_api_key",
      `${envVar} environment variable is required for ${provider} embeddings.`,
    );
  }
  return key;
}

/** Encode a numeric embedding vector into a little-endian Float32 BLOB for SQLite storage. */
export function encodeEmbeddingVector(vector: ArrayLike<number>): Buffer {
  const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Decode a SQLite BLOB into a Float32Array embedding vector. */
export function decodeEmbeddingVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new EmbeddingError(
      "invalid_response",
      `Invalid embedding BLOB byte length (${blob.byteLength}); expected multiple of 4.`,
    );
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

function toFloat32Vector(raw: unknown, expectedDims?: number): Float32Array {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new EmbeddingError(
      "invalid_response",
      "Provider returned an empty or non-array embedding.",
    );
  }
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbeddingError(
        "invalid_response",
        "Provider returned non-finite embedding values.",
      );
    }
    out[i] = value;
  }
  if (expectedDims !== undefined && out.length !== expectedDims) {
    throw new EmbeddingError(
      "invalid_response",
      `Expected embedding dimensions ${expectedDims}, received ${out.length}.`,
    );
  }
  return out;
}

async function postJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: EmbedClientOptions,
): Promise<unknown> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EmbeddingError("timeout", `Invalid embedding timeoutMs: ${String(timeoutMs)}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new EmbeddingError("timeout", `Embedding request timed out after ${timeoutMs}ms.`, {
        cause: error,
      });
    }
    throw new EmbeddingError(
      "network_error",
      `Embedding request failed: ${scrubText(error instanceof Error ? error.message : String(error))}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const safeDetail = detail ? ` ${scrubText(detail).slice(0, 200)}` : "";
    throw new EmbeddingError(
      "provider_error",
      `Embedding provider returned HTTP ${response.status}.${safeDetail}`,
      { status: response.status },
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new EmbeddingError("invalid_response", "Embedding provider returned invalid JSON.", {
      cause: error,
    });
  }
}

async function requestOllama(
  baseUrl: string,
  model: string,
  texts: readonly string[],
  dimensions: number | undefined,
  options: EmbedClientOptions,
): Promise<Float32Array[]> {
  const payload = {
    model,
    input: texts,
    ...(dimensions !== undefined ? { dimensions } : {}),
  };
  const data = (await postJsonWithTimeout(`${baseUrl}/api/embed`, {}, payload, options)) as {
    embeddings?: unknown;
    embedding?: unknown;
  };

  if (Array.isArray(data?.embeddings)) {
    if (data.embeddings.length !== texts.length) {
      throw new EmbeddingError(
        "invalid_response",
        `Expected ${texts.length} embeddings from ollama, received ${data.embeddings.length}.`,
      );
    }
    return data.embeddings.map((vec) => toFloat32Vector(vec, dimensions));
  }
  if (texts.length === 1 && Array.isArray(data?.embedding)) {
    return [toFloat32Vector(data.embedding, dimensions)];
  }
  throw new EmbeddingError("invalid_response", "Ollama response missing `embeddings` array.");
}

async function requestOpenAI(
  baseUrl: string,
  model: string,
  texts: readonly string[],
  dimensions: number | undefined,
  apiKey: string,
  options: EmbedClientOptions,
): Promise<Float32Array[]> {
  const payload = {
    model,
    input: texts,
    ...(dimensions !== undefined ? { dimensions } : {}),
  };
  const data = (await postJsonWithTimeout(
    `${baseUrl}/embeddings`,
    { Authorization: `Bearer ${apiKey}` },
    payload,
    options,
  )) as { data?: Array<{ index?: unknown; embedding?: unknown }> };

  if (!Array.isArray(data?.data) || data.data.length !== texts.length) {
    throw new EmbeddingError(
      "invalid_response",
      `OpenAI response missing expected ${texts.length} embedding entries.`,
    );
  }

  const ordered = [...data.data].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  return ordered.map((entry) => toFloat32Vector(entry.embedding, dimensions));
}

async function requestGemini(
  baseUrl: string,
  model: string,
  texts: readonly string[],
  dimensions: number | undefined,
  apiKey: string,
  options: EmbedClientOptions,
): Promise<Float32Array[]> {
  const modelName = model.startsWith("models/") ? model.slice("models/".length) : model;
  const fullModel = `models/${modelName}`;
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(modelName)}:batchEmbedContents`;
  const payload = {
    requests: texts.map((text) => ({
      model: fullModel,
      content: { parts: [{ text }] },
      ...(dimensions !== undefined ? { outputDimensionality: dimensions } : {}),
    })),
  };

  const data = (await postJsonWithTimeout(url, { "x-goog-api-key": apiKey }, payload, options)) as {
    embeddings?: Array<{ values?: unknown }>;
  };

  if (!Array.isArray(data?.embeddings) || data.embeddings.length !== texts.length) {
    throw new EmbeddingError(
      "invalid_response",
      `Gemini response missing expected ${texts.length} embeddings.`,
    );
  }
  return data.embeddings.map((entry) => toFloat32Vector(entry?.values, dimensions));
}

/** Create a zero-dependency embedding client from validated `EmbeddingsConfig`. */
export function createEmbeddingClient(
  config: EmbeddingsConfig,
  defaultOptions: EmbedClientOptions = {},
): EmbeddingClient {
  const provider = config.provider;
  const model = config.model ?? DEFAULT_EMBEDDING_MODELS[provider];
  const endpoint = normalizeBaseUrl(config.endpoint ?? DEFAULT_EMBEDDING_ENDPOINTS[provider]);
  const dimensions = config.dimensions;

  return {
    provider,
    model,
    dimensions,
    endpoint,
    async embed(
      texts: readonly string[],
      callOptions: EmbedClientOptions = {},
    ): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const scrubbed = texts.map((text) => scrubText(text));
      const mergedOptions: EmbedClientOptions = { ...defaultOptions, ...callOptions };

      switch (provider) {
        case "ollama":
          return requestOllama(endpoint, model, scrubbed, dimensions, mergedOptions);
        case "openai":
          return requestOpenAI(
            endpoint,
            model,
            scrubbed,
            dimensions,
            requireApiKey("OPENAI_API_KEY", "openai"),
            mergedOptions,
          );
        case "gemini":
          return requestGemini(
            endpoint,
            model,
            scrubbed,
            dimensions,
            requireApiKey("GEMINI_API_KEY", "gemini"),
            mergedOptions,
          );
      }
    },
  };
}
