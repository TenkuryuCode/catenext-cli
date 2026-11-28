export interface McpServerEntry {
  command: string;
  args: string[];
}

export const MCP_SERVER_KEY = "catenext";

export class McpConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpConfigError";
  }
}

export interface EntryInspection {
  count: number;
  entry: McpServerEntry | null;
  managed: boolean;
  compatible: boolean;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stdioEntry(command: unknown, args: unknown): McpServerEntry | null {
  return typeof command === "string" &&
    command.trim() !== "" &&
    Array.isArray(args) &&
    args.every((arg): arg is string => typeof arg === "string")
    ? { command, args }
    : null;
}

export type McpRole = "orchestrator" | "worker" | "reviewer";

function isMcpRole(value: string | undefined): value is McpRole {
  return value === "orchestrator" || value === "worker" || value === "reviewer";
}

/** Extract explicit `--role <role>` override from a managed entry, if present. */
export function entryRole(entry: McpServerEntry): McpRole | null {
  const args = entry.args.slice();
  if (args.at(-2) === "--root") args.splice(-2);
  if (args.length >= 2 && args.at(-2) === "--role") {
    const role = args.at(-1);
    if (isMcpRole(role)) return role;
  }
  return null;
}

/** Recognize generated local launches; never take over another server named catenext. */
export function entryBase(entry: McpServerEntry): McpServerEntry | null {
  const args = entry.args.slice();
  if (args.at(-2) === "--root") args.splice(-2);
  // Optional flags after `mcp`: --role <orchestrator|worker|reviewer>, --allow-crud
  if (args.length >= 2 && args.at(-2) === "--role" && isMcpRole(args.at(-1))) {
    args.splice(-2);
  }
  if (args.at(-1) === "--allow-crud") args.pop();
  if (args.pop() !== "mcp") return null;
  return { command: entry.command, args };
}
