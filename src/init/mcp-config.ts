import { applyEdits, type FormattingOptions, modify, type ParseError, parse } from "jsonc-parser";

/** Entri server MCP stdio yang ditulis ke konfigurasi IDE. */
export interface McpServerEntry {
  command: string;
  args: string[];
}

export const MCP_SERVER_KEY = "catenext";

/** Variabel Cursor untuk root workspace (literal, bukan template string JS). */
export const CURSOR_WORKSPACE_FOLDER = "$" + "{workspaceFolder}";

/** Adapter per klien MCP (pola Adapter di blueprint). */
export interface ClientAdapter {
  id: "claude-code" | "cursor";
  label: string;
  /** Path relatif terhadap root repo. */
  path: string;
  /** Argumen tambahan untuk klien ini (mis. root workspace). */
  extraArgs: string[];
}

export const ADAPTERS: ClientAdapter[] = [
  { id: "claude-code", label: "Claude Code", path: ".mcp.json", extraArgs: [] },
  {
    id: "cursor",
    label: "Cursor",
    path: ".cursor/mcp.json",
    // Cursor mengganti variabel ini dengan root workspace saat menjalankan server.
    extraArgs: ["--root", CURSOR_WORKSPACE_FOLDER],
  },
];

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

function detectFormatting(source: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(source)?.[1];
  return {
    insertSpaces: !indent?.startsWith("\t"),
    tabSize: indent && !indent.startsWith("\t") ? indent.length : 2,
    eol: source.includes("\r\n") ? "\r\n" : "\n",
  };
}

/**
 * Sisipkan/perbarui satu entri "catenext" di mcpServers tanpa menyentuh entri lain dan
 * tanpa membuang komentar JSONC. Idempoten: entri yang sudah sama tidak diubah.
 */
export function upsertMcpEntry(source: string | null, entry: McpServerEntry, file: string): string {
  const base = source && source.trim() !== "" ? source : "{}\n";
  const errors: ParseError[] = [];
  const doc = parse(base, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new McpConfigError(
      `${file} bukan JSON/JSONC objek yang valid, jadi tidak disentuh. Perbaiki manual lalu jalankan ulang \`catenext init\`.`,
    );
  }
  const servers = (doc as Record<string, unknown>).mcpServers;
  if (
    servers !== undefined &&
    (servers === null || typeof servers !== "object" || Array.isArray(servers))
  ) {
    throw new McpConfigError(`${file}: "mcpServers" harus berupa objek. Perbaiki manual dulu.`);
  }
  const current = (servers as Record<string, unknown> | undefined)?.[MCP_SERVER_KEY];
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(entry)) return base;

  const edits = modify(base, ["mcpServers", MCP_SERVER_KEY], entry, {
    formattingOptions: detectFormatting(base),
  });
  let out = applyEdits(base, edits);
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/** Baca entri "catenext" (untuk verifikasi 3 baris). */
export function readMcpEntry(source: string): McpServerEntry | null {
  const errors: ParseError[] = [];
  const doc = parse(source, errors, { allowTrailingComma: true }) as
    | { mcpServers?: Record<string, McpServerEntry> }
    | undefined;
  if (errors.length > 0) return null;
  const entry = doc?.mcpServers?.[MCP_SERVER_KEY];
  return entry && typeof entry.command === "string" && Array.isArray(entry.args) ? entry : null;
}
