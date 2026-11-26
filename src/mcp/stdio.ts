export const JSONRPC_VERSION = "2.0";
export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, never>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, never>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: { _meta?: never };
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export interface McpTransport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onparseerror?: (() => void) | undefined;
  onmessage?: ((message: unknown) => void) | undefined;
}

/**
 * Buffers an incoming stdio stream and extracts newline-delimited JSON-RPC messages.
 */
export class ReadBuffer {
  private buffer: Buffer | undefined;
  private readonly maxBufferSize: number;

  constructor(options?: { maxBufferSize?: number }) {
    this.maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
  }

  append(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const nextSize = (this.buffer?.length ?? 0) + buf.length;
    if (nextSize > this.maxBufferSize) {
      this.clear();
      throw new Error(`ReadBuffer exceeded maximum size of ${this.maxBufferSize} bytes`);
    }
    this.buffer = this.buffer ? Buffer.concat([this.buffer, buf]) : buf;
  }

  /** Returns the next non-empty line without trailing CR/LF, or null when incomplete. */
  readLine(): string | null {
    while (this.buffer) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) return null;
      const line = this.buffer.toString("utf8", 0, nl).replace(/\r$/, "");
      this.buffer = nl + 1 < this.buffer.length ? this.buffer.subarray(nl + 1) : undefined;
      if (line.trim().length > 0) return line;
    }
    return null;
  }

  clear(): void {
    this.buffer = undefined;
  }
}

/**
 * Minimal NDJSON stdio transport for MCP servers (reads stdin, writes stdout).
 */
export class StdioServerTransport implements McpTransport {
  private readonly readBuffer: ReadBuffer;
  private started = false;
  private closed = false;

  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onparseerror?: (() => void) | undefined;
  onmessage?: ((message: unknown) => void) | undefined;

  constructor(
    private readonly stdin: NodeJS.ReadableStream = process.stdin,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    options?: { maxBufferSize?: number },
  ) {
    this.readBuffer = new ReadBuffer(options);
  }

  private readonly handleData = (chunk: Buffer | string) => {
    try {
      this.readBuffer.append(chunk);
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      void this.close();
      return;
    }

    while (!this.closed) {
      let line: string | null;
      try {
        line = this.readBuffer.readLine();
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        break;
      }
      if (line === null) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.onparseerror?.();
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      this.onmessage?.(parsed);
    }
  };

  private readonly handleError = (err: Error) => {
    this.onerror?.(err);
  };

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("StdioServerTransport already started.");
    }
    this.started = true;
    this.stdin.on("data", this.handleData);
    this.stdin.on("error", this.handleError);
  }

  send(message: JsonRpcMessage): Promise<void> {
    const serialized = `${JSON.stringify(message)}\n`;
    return new Promise((resolve) => {
      if (this.stdout.write(serialized)) {
        resolve();
      } else {
        this.stdout.once("drain", resolve);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off("data", this.handleData);
    this.stdin.off("error", this.handleError);
    if (
      "listenerCount" in this.stdin &&
      typeof this.stdin.listenerCount === "function" &&
      this.stdin.listenerCount("data") === 0 &&
      "pause" in this.stdin &&
      typeof this.stdin.pause === "function"
    ) {
      this.stdin.pause();
    }
    this.readBuffer.clear();
    this.onclose?.();
  }
}
