import { PassThrough } from "node:stream";
import type { McpToolName } from "@catenext/shared";
import { describe, expect, it } from "vitest";
import { createCatenextMcpServer, LOCAL_TOOLS, type ServerContext } from "./server.js";
import { ReadBuffer, StdioServerTransport } from "./stdio.js";

function createTestServer(ctxOverride?: ServerContext) {
  const calls: Array<{ name: McpToolName; body: unknown }> = [];
  const service = {
    async callTool(name: McpToolName, body: unknown) {
      calls.push({ name, body });
      return { ok: true, tool: name };
    },
  } as Extract<ServerContext, { ok: true }>["service"];
  const server = createCatenextMcpServer({
    version: "0.9.0-test",
    context: async () => ctxOverride ?? { ok: true, service, root: "/tmp/test-repo" },
    log: () => {},
  });
  return { server, calls };
}

async function sendAndCollect(
  lines: string[],
  expectedResponses: number,
  ctxOverride?: ServerContext,
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const errors: Error[] = [];
  const received: Array<Record<string, unknown>> = [];

  const transport = new StdioServerTransport(stdin, stdout);
  const { server, calls } = createTestServer(ctxOverride);

  let outBuf = "";
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for ${expectedResponses} responses, got ${received.length}: ${outBuf}`,
          ),
        ),
      3000,
    );
    stdout.on("data", (chunk: Buffer) => {
      outBuf += chunk.toString("utf8");
      const parts = outBuf.split("\n");
      outBuf = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        received.push(JSON.parse(part) as Record<string, unknown>);
        if (received.length >= expectedResponses) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });

  await server.connect(transport);
  // Install error hook after connect so we also observe parse errors in tests.
  const prevOnError = transport.onerror;
  transport.onerror = (err) => {
    errors.push(err);
    prevOnError?.(err);
  };

  for (const chunk of lines) {
    stdin.write(chunk);
  }

  await done;
  await server.close();
  stdin.end();
  stdout.end();
  return { received, errors, calls };
}

describe("ReadBuffer & StdioServerTransport", () => {
  it("merangkai chunk parsial UTF-8, CRLF, dan baris kosong", () => {
    const rb = new ReadBuffer();
    const msg = JSON.stringify({ jsonrpc: "2.0", id: 1, text: "halo 🚀" });
    const bytes = Buffer.from(`\r\n  \r\n${msg}\r\n`, "utf8");
    // Split across multi-byte emoji boundary
    rb.append(bytes.subarray(0, bytes.length - 4));
    expect(rb.readLine()).toBeNull();
    rb.append(bytes.subarray(bytes.length - 4));
    expect(rb.readLine()).toBe(msg);
    expect(rb.readLine()).toBeNull();
  });

  it("menolak chunk yang melampaui maxBufferSize", () => {
    const rb = new ReadBuffer({ maxBufferSize: 16 });
    expect(() => rb.append("x".repeat(17))).toThrow(/maximum size/i);
  });

  it("melayani initialize, notifications/initialized, ping, tools/list, dan tools/call lewat NDJSON", async () => {
    const { received, calls } = await sendAndCollect(
      [
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "call-1",
          method: "tools/call",
          params: { name: "list_epics" },
        })}\n`,
      ],
      4,
    );

    expect(received).toHaveLength(4);
    expect(received[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "catenext", version: "0.9.0-test" },
      },
    });
    expect(received[1]).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    const listResult = received[2]?.result as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    expect(listResult.tools.map((t) => t.name).sort()).toEqual([...LOCAL_TOOLS].sort());
    expect(received[3]).toEqual({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        content: [{ type: "text", text: JSON.stringify({ ok: true, tool: "list_epics" }) }],
      },
    });
    expect(calls).toEqual([{ name: "list_epics", body: {} }]);
  });

  it("reports parse and envelope errors and continues processing NDJSON", async () => {
    const invalidEnvelopes = [
      [null, null],
      [true, null],
      [[], null],
      [{ jsonrpc: "2.0", id: "missing-method" }, "missing-method"],
      [{ jsonrpc: "2.0", id: 0, method: false }, 0],
      [{ jsonrpc: "1.0", id: 10, method: "ping" }, 10],
      [{ jsonrpc: "2.0", id: true, method: "ping" }, null],
      [{ jsonrpc: "2.0", id: null, method: "ping" }, null],
      [{ jsonrpc: "1.0", method: "notifications/initialized" }, null],
      [{ jsonrpc: "2.0", method: "notifications/initialized", params: 42 }, null],
      [{ jsonrpc: "2.0", id: "bad-params", method: "ping", params: 42 }, "bad-params"],
      [{ jsonrpc: "2.0", id: "mixed", method: "ping", result: {} }, "mixed"],
    ] as const;
    const { received, errors, calls } = await sendAndCollect(
      [
        '{"jsonrpc":"2.0","id":99,"method":\n',
        ...invalidEnvelopes.map(([envelope]) => `${JSON.stringify(envelope)}\n`),
        '{"jsonrpc":"2.0","method":"notifications/initialized"}\r\n',
        '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_epics"}}\n',
        '{"jsonrpc":"2.0","method":"unknown/notification","params":{}}\n',
        '{"jsonrpc":"2.0","id":"","method":"ping"}\n',
      ],
      invalidEnvelopes.length + 2,
    );

    expect(errors).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(received).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: expect.any(String) } },
      ...invalidEnvelopes.map(([, id]) => ({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: expect.any(String) },
      })),
      { jsonrpc: "2.0", id: "", result: {} },
    ]);
  });

  it("maintains method and tool parameter errors for valid envelopes", async () => {
    const { received, errors } = await sendAndCollect(
      [
        `${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "unknown/method" })}\n`,
        `${JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "nope" } })}\n`,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: { name: "list_epics", arguments: "bad" },
        })}\n`,
      ],
      3,
    );

    expect(errors).toEqual([]);
    expect(received[0]).toMatchObject({ jsonrpc: "2.0", id: 11, error: { code: -32601 } });
    expect(received[1]).toMatchObject({ jsonrpc: "2.0", id: 12, error: { code: -32602 } });
    expect(received[2]).toMatchObject({ jsonrpc: "2.0", id: 13, error: { code: -32602 } });
  });

  it("menolak start ganda dan menutup secara idempoten", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    let closeCount = 0;
    transport.onclose = () => {
      closeCount += 1;
    };
    await transport.start();
    await expect(transport.start()).rejects.toThrow(/already started/i);
    await transport.close();
    await transport.close();
    expect(closeCount).toBe(1);
    stdin.end();
    stdout.end();
  });
});
