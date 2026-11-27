export const JSONRPC_VERSION = "2.0";
export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;
export const STDIO_DEFAULT_MAX_LINE_SIZE = 1024 * 1024;

export class StdioBufferError extends Error {
  readonly code: "BUFFER_OVERFLOW" | "LINE_TOO_LARGE";
  readonly incomplete: boolean;

  constructor(code: "BUFFER_OVERFLOW" | "LINE_TOO_LARGE", message: string, incomplete = false) {
    super(message);
    this.name = "StdioBufferError";
    this.code = code;
    this.incomplete = incomplete;
  }
}

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
  onframeerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: unknown) => void) | undefined;
}

export interface ReadBufferOptions {
  maxBufferSize?: number;
  maxLineSize?: number;
}

/**
 * Buffers an incoming stdio stream and extracts newline-delimited JSON-RPC messages.
 */
export class ReadBuffer {
  private buffer: Buffer | undefined;
  private readonly maxBufferSize: number;
  private readonly maxLineSize: number;

  constructor(options?: ReadBufferOptions) {
    const maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
    if (!Number.isFinite(maxBufferSize) || maxBufferSize <= 0) {
      throw new RangeError("maxBufferSize must be a positive finite number");
    }
    const maxLineSize =
      options?.maxLineSize ?? Math.min(STDIO_DEFAULT_MAX_LINE_SIZE, maxBufferSize);
    if (!Number.isFinite(maxLineSize) || maxLineSize <= 0 || maxLineSize > maxBufferSize) {
      throw new RangeError("maxLineSize must be a positive finite number <= maxBufferSize");
    }
    this.maxBufferSize = maxBufferSize;
    this.maxLineSize = maxLineSize;
  }

  append(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const nextSize = (this.buffer?.length ?? 0) + buf.length;
    if (nextSize > this.maxBufferSize) {
      this.clear();
      throw new StdioBufferError(
        "BUFFER_OVERFLOW",
        `ReadBuffer exceeded maximum size of ${this.maxBufferSize} bytes`,
        true,
      );
    }
    this.buffer = this.buffer ? Buffer.concat([this.buffer, buf]) : buf;
  }

  /** Returns the next non-empty line without trailing CR/LF, or null when incomplete. */
  readLine(): string | null {
    while (this.buffer) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1) {
        if (this.buffer.length > this.maxLineSize) {
          this.clear();
          throw new StdioBufferError(
            "LINE_TOO_LARGE",
            `ReadBuffer line exceeded maximum size of ${this.maxLineSize} bytes`,
            true,
          );
        }
        return null;
      }
      const lineEnd = nl > 0 && this.buffer[nl - 1] === 0x0d ? nl - 1 : nl;
      const slice = this.buffer.subarray(0, lineEnd);
      this.buffer = nl + 1 < this.buffer.length ? this.buffer.subarray(nl + 1) : undefined;
      if (lineEnd > this.maxLineSize) {
        throw new StdioBufferError(
          "LINE_TOO_LARGE",
          `ReadBuffer line exceeded maximum size of ${this.maxLineSize} bytes`,
          false,
        );
      }
      const line = slice.toString("utf8");
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
  private discardingOversizedLine = false;

  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onparseerror?: (() => void) | undefined;
  onframeerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: unknown) => void) | undefined;

  constructor(
    private readonly stdin: NodeJS.ReadableStream = process.stdin,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    options?: ReadBufferOptions,
  ) {
    this.readBuffer = new ReadBuffer(options);
  }

  private readonly handleData = (chunk: Buffer | string) => {
    if (this.closed) return;
    let remaining: Buffer | undefined =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;

    while (remaining && remaining.length > 0 && !this.closed) {
      const current: Buffer = remaining;
      if (this.discardingOversizedLine) {
        const nl: number = current.indexOf(0x0a);
        if (nl === -1) return;
        remaining = nl + 1 < current.length ? current.subarray(nl + 1) : undefined;
        this.discardingOversizedLine = false;
        continue;
      }

      try {
        this.readBuffer.append(current);
        remaining = undefined;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onframeerror?.(error);
        this.onerror?.(error);
        const nl: number = current.indexOf(0x0a);
        if (nl === -1) {
          this.discardingOversizedLine = true;
          return;
        }
        remaining = nl + 1 < current.length ? current.subarray(nl + 1) : undefined;
        continue;
      }

      while (!this.closed) {
        let line: string | null;
        try {
          line = this.readBuffer.readLine();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.onframeerror?.(error);
          this.onerror?.(error);
          if (err instanceof StdioBufferError && err.incomplete) {
            this.discardingOversizedLine = true;
            break;
          }
          continue;
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
    this.stdout.on("error", this.handleError);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw new Error("StdioServerTransport is closed.");
    }
    const serialized = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.stdout.off("drain", onDrain);
        this.stdout.off("error", onError);
        this.stdout.off("close", onClose);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("StdioServerTransport stdout closed before drain."));
      };

      this.stdout.on("error", onError);
      this.stdout.on("close", onClose);
      if (this.stdout.write(serialized)) {
        settled = true;
        cleanup();
        resolve();
      } else {
        this.stdout.once("drain", onDrain);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.discardingOversizedLine = false;
    this.stdin.off("data", this.handleData);
    this.stdin.off("error", this.handleError);
    this.stdout.off("error", this.handleError);
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
