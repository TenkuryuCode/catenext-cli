import { applyEdits, type Edit } from "jsonc-parser";
import { type AST, getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import {
  type EntryInspection,
  entryBase,
  MCP_SERVER_KEY,
  McpConfigError,
  type McpServerEntry,
  object,
  stdioEntry,
} from "./mcp-entry.js";

const TABLE_KEY = ["mcp_servers", MCP_SERVER_KEY];
const startsWithEntry = (key: readonly (string | number)[]) =>
  TABLE_KEY.every((part, index) => key[index] === part);

function readToml(source: string, path: string) {
  try {
    const ast = parseTOML(source, { tomlVersion: "1.0" });
    const root = getStaticTOMLValue(ast);
    if (root.mcp_servers !== undefined && !object(root.mcp_servers)) {
      throw new Error("mcp_servers bukan tabel");
    }
    const servers = object(root.mcp_servers);
    const hasEntry = !!servers && Object.hasOwn(servers, MCP_SERVER_KEY);
    const value = hasEntry ? object(servers?.[MCP_SERVER_KEY]) : null;
    const entry = value && !("url" in value) ? stdioEntry(value.command, value.args) : null;
    return {
      ast,
      inspection: {
        count: hasEntry ? 1 : 0,
        entry,
        managed: entry !== null && entryBase(entry) !== null,
        compatible: value !== null && value.enabled !== false,
      },
    };
  } catch (error) {
    throw new McpConfigError(
      `${path} bukan TOML MCP yang valid. Perbaiki manual; file tidak disentuh.`,
      { cause: error },
    );
  }
}

export function inspectToml(source: string | null, path: string): EntryInspection {
  return readToml(source ?? "", path).inspection;
}

function string(value: string): string {
  // JSON escapes also work in TOML basic strings; DEL needs an explicit escape.
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

function erase(range: [number, number]): Edit {
  return { offset: range[0], length: range[1] - range[0], content: "" };
}

function keyParts(field: AST.TOMLKeyValue): string[] {
  return getStaticTOMLValue(field.key);
}

function fieldsIn(table: AST.TOMLTable | AST.TOMLTopLevelTable, source: string): Edit[] {
  return table.body.flatMap((node) => {
    if (node.type !== "TOMLKeyValue") return [];
    const prefix = table.type === "TOMLTable" ? table.resolvedKey : [];
    if (!startsWithEntry([...prefix, ...keyParts(node)])) return [];
    return [erase(wholeLineWhenBare(source, node.range))];
  });
}

function wholeLineWhenBare(source: string, [start, end]: [number, number]): [number, number] {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = source.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? source.length : nextBreak;
  // Leave trailing inline comments intact; with no comment, remove the whole line.
  return /^[ \t]*$/.test(source.slice(lineStart, start)) &&
    /^[ \t\r]*$/.test(source.slice(end, lineEnd))
    ? [lineStart, nextBreak === -1 ? lineEnd : lineEnd + 1]
    : [start, end];
}

export function editToml(
  source: string | null,
  path: string,
  desired: McpServerEntry | null,
): string | null {
  const text = source ?? "";
  const { ast, inspection } = readToml(text, path);
  if (inspection.count && !inspection.managed) {
    throw new McpConfigError(
      `${path}: entri ${MCP_SERVER_KEY} bukan peluncur Catenext yang dikelola. File tidak disentuh.`,
    );
  }
  if (!desired && !inspection.count) return source;
  if (
    desired &&
    inspection.compatible &&
    JSON.stringify(inspection.entry) === JSON.stringify(desired)
  )
    return source;

  const [top] = ast.body;
  const tables = top.body.filter((node): node is AST.TOMLTable => node.type === "TOMLTable");
  const table = tables.find(
    (node) => startsWithEntry(node.resolvedKey) && node.resolvedKey.length === TABLE_KEY.length,
  );
  const container =
    table ??
    tables.find((node) => node.resolvedKey.length === 1 && node.resolvedKey[0] === TABLE_KEY[0]) ??
    top;
  const prefixLength = container.type === "TOMLTable" ? container.resolvedKey.length : 0;
  const fields = (container.body as AST.TOMLNode[]).filter(
    (node): node is AST.TOMLKeyValue => node.type === "TOMLKeyValue",
  );
  const inline = fields.some((node) => {
    const key = keyParts(node);
    return (
      key.length + prefixLength <= TABLE_KEY.length &&
      key.every((part, i) => part === TABLE_KEY[i + prefixLength])
    );
  });
  // An inline mcp_servers/entry might also contain user properties. No broad rewrites.
  if (inspection.count && inline && desired) {
    throw new McpConfigError(
      `${path}: ubah konfigurasi inline Catenext ke [mcp_servers.catenext] secara manual. File tidak disentuh.`,
    );
  }

  const edits: Edit[] = [];
  let tail = "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (!desired) {
    const wholeInlineMap = top.body.some(
      (node) => node.type === "TOMLKeyValue" && keyParts(node).join("\0") === "mcp_servers",
    );
    if (wholeInlineMap) {
      throw new McpConfigError(
        `${path}: hapus entri Catenext dari mcp_servers inline secara manual. File tidak disentuh.`,
      );
    }
    edits.push(...fieldsIn(top, text));
    for (const node of tables) {
      if (startsWithEntry(node.resolvedKey)) {
        const close = ast.tokens.find(
          (token) => token.range[0] >= node.key.range[1] && token.value === "]",
        );
        if (!close) throw new McpConfigError(`${path}: batas tabel Catenext tidak ditemukan.`);
        edits.push(erase(wholeLineWhenBare(text, [node.range[0], close.range[1]])));
      }
      edits.push(...fieldsIn(node, text));
    }
  } else {
    const values: [string, string][] = [
      ["command", string(desired.command)],
      ["args", `[${desired.args.map(string).join(", ")}]`],
    ];
    if (inspection.count) {
      if (!inspection.compatible) values.push(["enabled", "true"]);
      for (const [key, value] of values) {
        const full = [...TABLE_KEY.slice(prefixLength), key];
        const field = fields.find((node) => keyParts(node).join("\0") === full.join("\0"));
        if (!field)
          throw new McpConfigError(
            `${path}: perbarui ${full.join(".")} secara manual. File tidak disentuh.`,
          );
        if (text.slice(...field.value.range) !== value) {
          edits.push({ ...erase(field.value.range), content: value });
        }
      }
    } else {
      const separator =
        !text || text.endsWith(`${eol}${eol}`) ? "" : text.endsWith(eol) ? eol : eol + eol;
      tail = `${separator}[${TABLE_KEY.join(".")}]${eol}${values.map(([key, value]) => `${key} = ${value}`).join(eol)}${eol}`;
    }
  }
  const updated = applyEdits(text, edits) + tail;
  const actual = inspectToml(updated, path);
  if (
    (desired && (!actual.compatible || JSON.stringify(actual.entry) !== JSON.stringify(desired))) ||
    (!desired && actual.count)
  ) {
    throw new McpConfigError(
      `${path}: tidak dapat mengubah entri Catenext secara aman. File tidak disentuh.`,
    );
  }
  return updated;
}
