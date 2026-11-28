import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingsConfigSchema, isValidEmbeddingEndpoint } from "@catenext/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexCodeEmbeddings } from "./code-search.js";
import { ConfigError, configuredEmbeddings, parseConfig } from "./config.js";
import { openDatabaseAt } from "./db/open.js";
import {
  createEmbeddingClient,
  decodeEmbeddingVector,
  EmbeddingError,
  encodeEmbeddingVector,
  validateEmbeddingEndpoint,
} from "./embeddings.js";

const BASE_CONFIG = `
schema_version: 1
project_id: 6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f
repo_name: catenext
`;

describe("embeddings config schema", () => {
  it("accepts optional embeddings config for ollama, gemini, and openai", () => {
    const parsed = parseConfig(`
${BASE_CONFIG}
embeddings:
  provider: ollama
  model: nomic-embed-text
  dimensions: 768
  endpoint: http://127.0.0.1:11434
`);
    expect(configuredEmbeddings(parsed)).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      endpoint: "http://127.0.0.1:11434",
    });
  });

  it("rejects unknown keys such as api_key inside embeddings config", () => {
    expect(() =>
      parseConfig(`
${BASE_CONFIG}
embeddings:
  provider: openai
  api_key: sk-should-never-be-in-config
`),
    ).toThrow(ConfigError);
  });

  it("rejects invalid or credential-bearing endpoint URLs in config", () => {
    expect(() =>
      parseConfig(`
${BASE_CONFIG}
embeddings:
  provider: ollama
  endpoint: http://user:pass@127.0.0.1:11434
`),
    ).toThrow(ConfigError);

    expect(() =>
      parseConfig(`
${BASE_CONFIG}
embeddings:
  provider: ollama
  endpoint: file:///etc/passwd
`),
    ).toThrow(ConfigError);
  });
});

describe("validateEmbeddingEndpoint", () => {
  it("allows http and https URLs without credentials", () => {
    expect(validateEmbeddingEndpoint("http://127.0.0.1:11434").origin).toBe(
      "http://127.0.0.1:11434",
    );
    expect(validateEmbeddingEndpoint("https://api.openai.com/v1").href).toBe(
      "https://api.openai.com/v1",
    );
  });

  it("rejects non-http(s) protocols, malformed URLs, and embedded credentials", () => {
    for (const bad of [
      "ftp://example.com",
      "file:///tmp/socket",
      "not-a-url",
      "https://user:secret@api.openai.com/v1",
      "http://token@localhost:11434",
    ]) {
      expect(() => validateEmbeddingEndpoint(bad)).toThrow(EmbeddingError);
    }
  });
});

describe("createEmbeddingClient", () => {
  const savedOpenAiKey = process.env.OPENAI_API_KEY;
  const savedGeminiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;

    if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGeminiKey;

    vi.restoreAllMocks();
  });

  it("returns empty array without calling fetch when input is empty", async () => {
    const fetchMock = vi.fn();
    const client = createEmbeddingClient({ provider: "ollama" }, { fetchImpl: fetchMock });
    expect(await client.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scrubs secrets from input text before sending to provider", async () => {
    let capturedBody: unknown;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createEmbeddingClient({ provider: "ollama" }, { fetchImpl: fetchMock });
    const result = await client.embed([
      "token=ghp_1234567890abcdefghij1234567890 and postgres://app:s3cr3tPass@localhost:5432/db",
    ]);

    expect(result).toHaveLength(1);
    expect(Array.from(result[0] ?? [])).toEqual([expect.closeTo(0.1, 5), expect.closeTo(0.2, 5)]);
    const sent = JSON.stringify(capturedBody);
    expect(sent).not.toContain("ghp_1234567890abcdefghij1234567890");
    expect(sent).not.toContain("s3cr3tPass");
    expect(sent).toContain("[REDACTED:");
  });

  it("reads OPENAI_API_KEY from process.env at call time and sorts OpenAI response by index", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-test-openai-key");
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0.3, 0.4] },
            { index: 0, embedding: [0.1, 0.2] },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = createEmbeddingClient(
      { provider: "openai", dimensions: 2 },
      { fetchImpl: fetchMock },
    );

    await expect(client.embed(["first", "second"])).rejects.toMatchObject({
      code: "missing_api_key",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.OPENAI_API_KEY = "sk-test-openai-key";
    const vectors = await client.embed(["first", "second"]);
    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0] ?? [])).toEqual([expect.closeTo(0.1, 5), expect.closeTo(0.2, 5)]);
    expect(Array.from(vectors[1] ?? [])).toEqual([expect.closeTo(0.3, 5), expect.closeTo(0.4, 5)]);
  });

  it("reads GEMINI_API_KEY from process.env at call time and sends x-goog-api-key header", async () => {
    delete process.env.GEMINI_API_KEY;
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe("gemini-secret-key");
      return new Response(JSON.stringify({ embeddings: [{ values: [0.5, 0.6, 0.7] }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = createEmbeddingClient(
      { provider: "gemini", model: "text-embedding-004", dimensions: 3 },
      { fetchImpl: fetchMock },
    );

    await expect(client.embed(["hello"])).rejects.toMatchObject({ code: "missing_api_key" });

    process.env.GEMINI_API_KEY = "gemini-secret-key";
    const vectors = await client.embed(["hello"]);
    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents",
    );
    expect(capturedUrl).not.toContain("gemini-secret-key");
    expect(capturedBody).toEqual({
      requests: [
        {
          model: "models/text-embedding-004",
          content: { parts: [{ text: "hello" }] },
          outputDimensionality: 3,
        },
      ],
    });
    expect(Array.from(vectors[0] ?? [])).toEqual([
      expect.closeTo(0.5, 5),
      expect.closeTo(0.6, 5),
      expect.closeTo(0.7, 5),
    ]);
  });

  it("aborts and throws timeout EmbeddingError when provider exceeds timeoutMs", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    const client = createEmbeddingClient(
      { provider: "ollama" },
      { fetchImpl: fetchMock, timeoutMs: 20 },
    );

    await expect(client.embed(["slow text"])).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("scrubs secrets from provider HTTP error responses", async () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-key";
    const fetchMock = vi.fn(async () => {
      return new Response("upstream error for key sk-ant-secret1234567890", { status: 502 });
    }) as unknown as typeof fetch;

    const client = createEmbeddingClient({ provider: "openai" }, { fetchImpl: fetchMock });
    try {
      await client.embed(["hello"]);
      expect.fail("expected EmbeddingError");
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingError);
      const err = error as EmbeddingError;
      expect(err.code).toBe("provider_error");
      expect(err.status).toBe(502);
      expect(err.message).not.toContain("sk-ant-secret1234567890");
    }
  });
});

describe("embedding vector BLOB codec", () => {
  it("round-trips Float32Array through SQLite Buffer BLOB", () => {
    const input = [0.25, -0.5, 1.125, 0];
    const blob = encodeEmbeddingVector(input);
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob.byteLength).toBe(16);
    const decoded = decodeEmbeddingVector(blob);
    expect(Array.from(decoded)).toEqual([0.25, -0.5, 1.125, 0]);
  });
});

describe("security regression: outbound scrubbing, env-only keys, and endpoint bounds", () => {
  const savedOpenAiKey = process.env.OPENAI_API_KEY;
  const savedGeminiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;

    if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGeminiKey;

    vi.restoreAllMocks();
  });

  const syntheticGoogleKey = ["AIza", "SyTestFixture", "0123456789abcdef012345"].join("");
  const syntheticOpenAiToken = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz1234"].join("");
  const syntheticGhToken = ["ghp_", "1234567890abcdefghij1234567890"].join("");
  const syntheticBearer = ["Bearer ", "syntheticBearerToken1234567890"].join("");

  it.each([
    {
      provider: "ollama" as const,
      responseBody: { embeddings: [[0.1, 0.2]] },
    },
    {
      provider: "openai" as const,
      responseBody: { data: [{ index: 0, embedding: [0.1, 0.2] }] },
    },
    {
      provider: "gemini" as const,
      responseBody: { embeddings: [{ values: [0.1, 0.2] }] },
    },
  ])(
    "scrubs quoted multi-word secrets and provider tokens before outbound $provider fetch",
    async ({ provider, responseBody }) => {
      process.env.OPENAI_API_KEY = syntheticOpenAiToken;
      process.env.GEMINI_API_KEY = syntheticGoogleKey;

      let capturedUrl = "";
      let capturedBody = "";
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedBody = String(init?.body ?? "");
        return new Response(JSON.stringify(responseBody), { status: 200 });
      }) as unknown as typeof fetch;

      const client = createEmbeddingClient({ provider }, { fetchImpl: fetchMock });
      const payloadText = [
        'PASSWORD="my synthetic secret pass 123"',
        "API_SECRET='correct horse battery staple'",
        '{"password": "my synthetic json secret 456"}',
        `token=${syntheticGhToken}`,
        `openai=${syntheticOpenAiToken}`,
        `google=${syntheticGoogleKey}`,
        `Authorization: ${syntheticBearer}`,
        "postgres://app:s3cr3tPass@localhost:5432/db",
      ].join("\n");

      await client.embed([payloadText]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      for (const forbidden of [
        "my synthetic secret pass 123",
        "correct horse battery staple",
        "my synthetic json secret 456",
        syntheticGhToken,
        syntheticOpenAiToken,
        syntheticGoogleKey,
        "syntheticBearerToken1234567890",
        "s3cr3tPass",
      ]) {
        expect(capturedBody).not.toContain(forbidden);
        expect(capturedUrl).not.toContain(forbidden);
      }
      expect(capturedBody).toContain("[REDACTED:assignment]");
      expect(capturedBody).toContain("[REDACTED:github_token]");
      expect(capturedBody).toContain("[REDACTED:llm_api_key]");
      expect(capturedBody).toContain("[REDACTED:google_api_key]");
      expect(capturedBody).toContain("[REDACTED:bearer_token]");
      expect(capturedBody).toContain("[REDACTED:url_password]");
    },
  );

  it("never persists env-var API keys in config.yaml, client objects, error messages, or SQLite embedding_chunks", async () => {
    process.env.OPENAI_API_KEY = syntheticOpenAiToken;
    process.env.GEMINI_API_KEY = syntheticGoogleKey;

    // 1. config.yaml schema rejects any embedded API key fields and never surfaces env keys.
    for (const [key, val] of [
      ["api_key", syntheticOpenAiToken],
      ["openai_api_key", syntheticOpenAiToken],
      ["gemini_api_key", syntheticGoogleKey],
    ] as const) {
      expect(() =>
        parseConfig(`
${BASE_CONFIG}
embeddings:
  provider: openai
  ${key}: ${val}
`),
      ).toThrow(ConfigError);
      expect(
        EmbeddingsConfigSchema.safeParse({
          provider: "openai",
          [key]: val,
        }).success,
      ).toBe(false);
    }

    const validConfig = parseConfig(`
${BASE_CONFIG}
embeddings:
  provider: gemini
  model: text-embedding-004
`);
    const extracted = configuredEmbeddings(validConfig);
    expect(JSON.stringify(extracted)).not.toContain(syntheticOpenAiToken);
    expect(JSON.stringify(extracted)).not.toContain(syntheticGoogleKey);

    // 2. Client metadata never exposes env-var keys.
    const openaiClient = createEmbeddingClient(
      { provider: "openai", dimensions: 2 },
      {
        fetchImpl: vi.fn(async () => {
          return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.25, 0.75] }] }), {
            status: 200,
          });
        }) as unknown as typeof fetch,
      },
    );
    expect(JSON.stringify(openaiClient)).not.toContain(syntheticOpenAiToken);
    expect(JSON.stringify(openaiClient)).not.toContain(syntheticGoogleKey);

    // 3. Provider HTTP error responses scrub echoed env-var keys.
    const failingClient = createEmbeddingClient(
      { provider: "gemini" },
      {
        fetchImpl: vi.fn(async () => {
          return new Response(
            `Upstream rejected key ${syntheticGoogleKey} and ${syntheticOpenAiToken}`,
            { status: 401 },
          );
        }) as unknown as typeof fetch,
      },
    );
    await expect(failingClient.embed(["hello"])).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(EmbeddingError);
      const msg = (err as EmbeddingError).message;
      expect(msg).not.toContain(syntheticGoogleKey);
      expect(msg).not.toContain(syntheticOpenAiToken);
      return true;
    });

    // 4. SQLite embedding_chunks stores only metadata + Float32 BLOB, never API keys.
    const root = await mkdtemp(join(tmpdir(), "catenext-embed-sec-"));
    try {
      await writeFile(join(root, "sample.ts"), "export const answer = 42;\n");
      const db = openDatabaseAt(join(root, "state.sqlite"));
      try {
        await indexCodeEmbeddings(root, { db, client: openaiClient });

        const cols = db.prepare("PRAGMA table_info(embedding_chunks)").all() as Array<{
          name: string;
        }>;
        const colNames = cols.map((c) => c.name);
        expect(colNames).not.toContain("api_key");
        expect(colNames).not.toContain("credentials");
        expect(colNames).not.toContain("secret");

        const rows = db.prepare("SELECT * FROM embedding_chunks").all() as Array<
          Record<string, unknown>
        >;
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          for (const value of Object.values(row)) {
            const asText =
              value instanceof Uint8Array
                ? Buffer.from(value).toString("utf8")
                : String(value ?? "");
            expect(asText).not.toContain(syntheticOpenAiToken);
            expect(asText).not.toContain(syntheticGoogleKey);
          }
        }
      } finally {
        db.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe endpoint URLs in isValidEmbeddingEndpoint, EmbeddingsConfigSchema, and client", () => {
    const unsafeUrls = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/plain,hello",
      "ftp://example.com/embed",
      "ws://127.0.0.1:11434",
      "https://user:pass@api.openai.com/v1",
      "http://user@127.0.0.1:11434",
      "https://:secret@generativelanguage.googleapis.com",
      "not-a-url",
      "",
    ];

    for (const bad of unsafeUrls) {
      expect(isValidEmbeddingEndpoint(bad)).toBe(false);
      expect(EmbeddingsConfigSchema.safeParse({ provider: "ollama", endpoint: bad }).success).toBe(
        false,
      );
      expect(() => validateEmbeddingEndpoint(bad)).toThrow(EmbeddingError);
      expect(() => createEmbeddingClient({ provider: "ollama", endpoint: bad })).toThrow(
        EmbeddingError,
      );
    }

    for (const safe of ["http://127.0.0.1:11434", "https://api.openai.com/v1"]) {
      expect(isValidEmbeddingEndpoint(safe)).toBe(true);
      expect(EmbeddingsConfigSchema.safeParse({ provider: "openai", endpoint: safe }).success).toBe(
        true,
      );
    }
  });
});
