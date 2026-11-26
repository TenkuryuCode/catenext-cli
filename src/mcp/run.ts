import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, findProjectRoot, readConfig } from "../config.js";
import { LocalService } from "../local-service.js";
import { createCatenextMcpServer, type ServerContext } from "./server.js";

/**
 * Tentukan titik awal pencarian project. Fail closed: --root yang kosong atau tidak ter-expand
 * (mis. "${CLAUDE_PROJECT_DIR}") tidak boleh diam-diam jatuh ke cwd, karena state bisa tertulis
 * ke project yang salah. Mengembalikan null bila --root tidak valid.
 */
export function resolveStart(root: string | undefined, cwd: string): string | null {
  if (root === undefined) return cwd;
  if (root.trim() === "" || root.includes("${")) return null;
  return root;
}

/** stdout khusus protokol MCP. Muat config secara lazy agar tool memberi petunjuk bila belum init. */
export async function runMcpServer(opts: { root?: string; version: string }) {
  let cached: Promise<ServerContext> | undefined;

  const load = async (): Promise<ServerContext> => {
    try {
      const start = resolveStart(opts.root, process.cwd());
      if (start === null) {
        return {
          ok: false,
          error: `--root "${opts.root}" tidak ter-resolve. Isi dengan path absolut repo, mis. \`--root /path/ke/repo\`.`,
        };
      }
      const root = await findProjectRoot(start);
      if (!root) {
        return {
          ok: false,
          error: `Tidak ada .catenext/config.yaml di ${start} atau folder induknya. Jalankan \`catenext init\` di root repo.`,
        };
      }
      const config = await readConfig(root);
      // MCP selalu agen: approve/approve_plan ditolak di LocalService.
      const service = new LocalService(root, config, "agent");
      process.stderr.write(
        `[catenext] repo "${config.repo_name}" (project ${config.project_id}) dari ${root}\n`,
      );
      return { ok: true, service, root };
    } catch (err) {
      if (err instanceof ConfigError) return { ok: false, error: err.message };
      throw err;
    }
  };

  const server = createCatenextMcpServer({
    version: opts.version,
    context: async () => {
      cached ??= load();
      const pending = cached;
      try {
        const ctx = await pending;
        if (!ctx.ok && cached === pending) cached = undefined;
        return ctx;
      } catch (err) {
        if (cached === pending) cached = undefined;
        throw err;
      }
    },
  });
  await server.connect(new StdioServerTransport());
}
