import {
  applyEdits,
  createScanner,
  type Edit,
  getNodeValue,
  type Node,
  type ParseError,
  parseTree,
} from "jsonc-parser";
import type { ClientAdapter } from "./mcp-config.js";
import {
  type EntryInspection,
  entryBase,
  MCP_SERVER_KEY,
  McpConfigError,
  type McpServerEntry,
  object,
  stdioEntry,
} from "./mcp-entry.js";

// jsonc-parser publishes SyntaxKind as an ambient const enum.
const COMMA_TOKEN = 5;

const keyOf = (node: Node): unknown => node.children?.[0]?.value;
const endOf = (node: Node): number => node.offset + node.length;

function readTree(source: string, adapter: ClientAdapter) {
  const errors: ParseError[] = [];
  const doc = parseTree(source, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length || (doc && doc.type !== "object")) {
    throw new McpConfigError(
      `${adapter.path} bukan objek JSON/JSONC yang valid. Perbaiki manual; file tidak disentuh.`,
    );
  }
  const key = adapter.kind === "opencode" ? "mcp" : adapter.vscode ? "servers" : "mcpServers";
  const maps = doc?.children?.filter((node) => keyOf(node) === key) ?? [];
  const map = maps[0]?.children?.[1];
  if (maps.length > 1 || (map && map.type !== "object")) {
    throw new McpConfigError(
      `${adapter.path}: ${key} harus satu objek. Perbaiki manual; file tidak disentuh.`,
    );
  }
  const entries = map?.children?.filter((node) => keyOf(node) === MCP_SERVER_KEY) ?? [];
  return { doc, key, map, entries };
}

function decode(node: Node, adapter: ClientAdapter) {
  const value = object(getNodeValue(node));
  if (adapter.kind === "opencode") {
    const cmd: unknown = value?.command;
    return value?.type === "local" && Array.isArray(cmd) ? stdioEntry(cmd[0], cmd.slice(1)) : null;
  }
  return value &&
    (value.type === undefined || value.type === "stdio") &&
    !("url" in value || "serverUrl" in value || "httpUrl" in value)
    ? stdioEntry(value.command, value.args)
    : null;
}

function enabled(node: Node, adapter: ClientAdapter): boolean {
  const value = object(getNodeValue(node));
  return value?.enabled !== false && (!adapter.vscode || value?.type === "stdio");
}

export function inspectJson(source: string | null, adapter: ClientAdapter): EntryInspection {
  const { entries } = readTree(source ?? "", adapter);
  const values = entries.flatMap((property) => property.children?.[1] ?? []);
  const value = values.at(-1);
  const entry = value ? decode(value, adapter) : null;
  return {
    count: entries.length,
    entry,
    managed:
      values.length > 0 &&
      values.every((node) => {
        const decoded = decode(node, adapter);
        return decoded !== null && entryBase(decoded) !== null;
      }),
    compatible: !!value && enabled(value, adapter),
  };
}

function encode(adapter: ClientAdapter, entry: McpServerEntry, prior?: Node) {
  const props = prior ? object(getNodeValue(prior)) : null;
  if (adapter.kind === "opencode") {
    return { ...props, type: "local", command: [entry.command, ...entry.args], enabled: true };
  }
  return {
    ...props,
    ...entry,
    ...(props?.enabled === false ? { enabled: true } : {}),
    ...(adapter.vscode ? { type: "stdio" } : {}),
  };
}

function scanNext(source: string, from: number) {
  const scanner = createScanner(source, true);
  scanner.setPosition(from);
  const kind = scanner.scan();
  return { kind, offset: scanner.getTokenOffset() };
}

function eraseProperty(source: string, map: Node, property: Node): string {
  const members = map.children ?? [];
  const position = members.indexOf(property);
  const next = scanNext(source, endOf(property));
  const prev = members[position - 1];
  const comma = next.kind === COMMA_TOKEN ? next : prev ? scanNext(source, endOf(prev)) : undefined;
  const edits: Edit[] = [{ offset: property.offset, length: property.length, content: "" }];
  if (comma?.kind === COMMA_TOKEN) edits.push({ offset: comma.offset, length: 1, content: "" });
  return applyEdits(source, edits);
}

function insertProperty(source: string, parent: Node, key: string, value: unknown): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^([ \t]+)"/m.exec(source)?.[1] ?? "  ";
  const close = endOf(parent) - 1;
  const lineStart = source.lastIndexOf("\n", close - 1) + 1;
  const closingIndent = source.slice(lineStart, close);
  const nested = /^\s*$/.test(closingIndent) ? closingIndent : parent.parent ? indent : "";
  const memberIndent = nested + indent;
  const body = JSON.stringify(value, null, indent).replace(/\n/g, `${eol}${memberIndent}`);
  const property = `${memberIndent}${JSON.stringify(key)}: ${body}`;
  const last = parent.children?.at(-1);
  const edits: Edit[] = [];
  if (last && scanNext(source, endOf(last)).kind !== COMMA_TOKEN) {
    edits.push({ offset: endOf(last), length: 0, content: "," });
  }
  // Insert after earlier comments; avoid changing their text, punctuation or positions.
  if (/^[ \t]*$/.test(closingIndent) && lineStart > parent.offset) {
    edits.push({ offset: lineStart, length: 0, content: `${property}${eol}` });
  } else {
    edits.push({ offset: close, length: 0, content: `${eol}${property}${eol}${nested}` });
  }
  return applyEdits(source, edits);
}

export function editJson(
  source: string | null,
  adapter: ClientAdapter,
  entry: McpServerEntry | null,
): string | null {
  const before = source ?? "";
  let text = before;
  let { doc, key, map, entries } = readTree(text, adapter);
  if (entries.length && !inspectJson(source, adapter).managed) {
    throw new McpConfigError(
      `${adapter.path}: entri ${MCP_SERVER_KEY} bukan peluncur Catenext yang dikelola. File tidak disentuh.`,
    );
  }
  while (map && entries.length > (entry ? 1 : 0)) {
    const property = entries[0];
    if (!property) break;
    text = eraseProperty(text, map, property);
    ({ doc, key, map, entries } = readTree(text, adapter));
  }
  if (!entry) return source === null ? null : text;
  const old = entries[0]?.children?.[1];
  const value = encode(adapter, entry, old);
  if (old) {
    if (JSON.stringify(getNodeValue(old)) === JSON.stringify(value)) return text;
    // Edit individual launch fields, not the whole entry (which may contain comments/env).
    for (const [name, item] of Object.entries(value)) {
      const current = readTree(text, adapter).entries[0]?.children?.[1];
      if (!current) throw new McpConfigError(`${adapter.path}: entri ${MCP_SERVER_KEY} hilang.`);
      const field = current.children?.find((property) => keyOf(property) === name)?.children?.[1];
      if (field && JSON.stringify(getNodeValue(field)) === JSON.stringify(item)) continue;
      text = field
        ? applyEdits(text, [
            { offset: field.offset, length: field.length, content: JSON.stringify(item) },
          ])
        : insertProperty(text, current, name, item);
    }
    return text;
  }
  if (map) return insertProperty(text, map, MCP_SERVER_KEY, value);
  if (doc) return insertProperty(text, doc, key, { [MCP_SERVER_KEY]: value });
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${JSON.stringify({ [key]: { [MCP_SERVER_KEY]: value } }, null, 2)}\n`;
}
