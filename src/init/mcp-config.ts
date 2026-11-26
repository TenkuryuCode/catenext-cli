import { isAbsolute, resolve } from "node:path";
import type { PlatformId } from "@catenext/shared";
import {
  type EntryInspection,
  McpConfigError,
  type McpServerEntry,
  stdioEntry,
} from "./mcp-entry.js";
import { editJson, inspectJson } from "./mcp-json.js";
import { editToml, inspectToml } from "./mcp-toml.js";
import { readRepoFile } from "./repo-files.js";

export {
  type EntryInspection,
  entryBase,
  McpConfigError,
  type McpServerEntry,
} from "./mcp-entry.js";
export const CURSOR_WORKSPACE_FOLDER = "$" + "{workspaceFolder}";

export interface ClientAdapter {
  ids: PlatformId[];
  label: string;
  path: string;
  kind: "json" | "toml" | "opencode";
  workspaceToken?: string;
  vscode?: boolean;
}

const CLAUDE = {
  path: ".mcp.json",
  kind: "json",
  workspaceToken: "$" + "{CLAUDE_PROJECT_DIR}",
} as const;
export const WINDSURF_UNSUPPORTED =
  "Windsurf lama hanya mendokumentasikan konfigurasi MCP global; Catenext tidak mengubahnya. Pasang manual bila diperlukan.";

/** Current workspace formats; no home paths or shell commands are generated. */
export async function selectedAdapters(
  root: string,
  platforms: readonly PlatformId[],
): Promise<ClientAdapter[]> {
  const out: ClientAdapter[] = [];
  const selected = new Set(platforms);
  if (selected.has("claude-code")) {
    // https://code.claude.com/docs/en/mcp
    out.push({ ...CLAUDE, ids: ["claude-code"], label: "Claude Code" });
  }
  if (selected.has("vscode")) {
    // VS Code editor-managed workspace configuration (Local harness).
    // https://code.visualstudio.com/docs/agents/reference/mcp-configuration
    out.push({
      ids: ["vscode"],
      label: "VS Code",
      path: ".vscode/mcp.json",
      kind: "json",
      vscode: true,
    });
  }
  if (selected.has("cursor")) {
    // https://cursor.com/docs/context/mcp
    out.push({
      ids: ["cursor"],
      label: "Cursor",
      path: ".cursor/mcp.json",
      kind: "json",
      workspaceToken: CURSOR_WORKSPACE_FOLDER,
    });
  }
  if (selected.has("codex")) {
    // https://developers.openai.com/codex/mcp
    out.push({ ids: ["codex"], label: "Codex", path: ".codex/config.toml", kind: "toml" });
  }
  if (selected.has("antigravity")) {
    // https://antigravity.google/docs/mcp
    out.push({
      ids: ["antigravity"],
      label: "Antigravity",
      path: ".agents/mcp_config.json",
      kind: "json",
    });
  }
  if (selected.has("opencode")) {
    // https://opencode.ai/docs/config/ and https://opencode.ai/docs/mcp-servers/
    const paths = [
      ".opencode/opencode.jsonc",
      ".opencode/opencode.json",
      "opencode.jsonc",
      "opencode.json",
    ];
    const existing: ClientAdapter[] = [];
    const withEntry: ClientAdapter[] = [];
    for (const path of paths) {
      const source = await readRepoFile(root, path);
      if (source === null) continue;
      const adapter: ClientAdapter = {
        ids: ["opencode"],
        label: "OpenCode",
        path,
        kind: "opencode",
      };
      existing.push(adapter);
      try {
        if (inspectMcp(source, adapter).count) withEntry.push(adapter);
      } catch (error) {
        if (!(error instanceof McpConfigError)) throw error;
        withEntry.push(adapter); // diagnostics must not silently skip malformed files
      }
    }
    out.push(
      ...(withEntry.length
        ? withEntry
        : [
            existing[0] ?? {
              ids: ["opencode"],
              label: "OpenCode",
              path: "opencode.jsonc",
              kind: "opencode",
            },
          ]),
    );
  }
  return out;
}

export function scopedEntry(
  root: string,
  adapter: ClientAdapter,
  base: McpServerEntry,
): McpServerEntry {
  const result = stdioEntry(base.command, base.args);
  if (!result || [result.command, ...result.args].some((value) => value.includes("\0"))) {
    throw new McpConfigError("Perintah MCP harus berupa program dan daftar argumen tanpa NUL.");
  }
  return {
    command: result.command,
    args: [...result.args, "mcp", "--root", adapter.workspaceToken ?? resolve(root)],
  };
}

export function entryMatchesRoot(
  entry: McpServerEntry,
  root: string,
  adapter: ClientAdapter,
): boolean {
  if (entry.args.at(-2) !== "--root") return false;
  const target = entry.args.at(-1);
  return (
    !!target &&
    (target === adapter.workspaceToken || (isAbsolute(target) && resolve(target) === resolve(root)))
  );
}

export function inspectMcp(source: string | null, adapter: ClientAdapter): EntryInspection {
  return adapter.kind === "toml" ? inspectToml(source, adapter.path) : inspectJson(source, adapter);
}

export function changeMcp(
  source: string | null,
  adapter: ClientAdapter,
  entry: McpServerEntry | null,
): string | null {
  return adapter.kind === "toml"
    ? editToml(source, adapter.path, entry)
    : editJson(source, adapter, entry);
}
