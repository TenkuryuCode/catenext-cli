import { ConfigError, findProjectRoot, readConfig } from "../config.js";
import { checkpointDatabaseFile } from "../db/open.js";
import { LocalService } from "../local-service.js";
import { type McpRole, mcpCrudEnabled } from "./catalog.js";
import { createCatenextMcpServer, type ServerContext } from "./server.js";
import { StdioServerTransport } from "./stdio.js";

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
export async function runMcpServer(opts: {
  root?: string;
  role?: McpRole;
  version: string;
  allowCrud?: boolean;
}) {
  const allowCrud = mcpCrudEnabled(opts.role, opts.allowCrud);
  let cached: Promise<ServerContext> | undefined;
  let stateFile: string | undefined;

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
      const service = new LocalService(root, config, "agent", { allowCrud });
      stateFile = service.stateFile;
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
    role: opts.role,
    allowCrud,
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

  let shuttingDown = false;
  const runCheckpoint = () => {
    if (!stateFile) return;
    try {
      checkpointDatabaseFile(stateFile, { onlyIfSidecarExists: true });
    } catch {
      /* ignore checkpoint errors on shutdown */
    }
  };

  const onBeforeExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    void server.close().catch(() => undefined);
    runCheckpoint();
  };

  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off("beforeExit", onBeforeExit);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    void server
      .close()
      .catch(() => undefined)
      .finally(() => {
        runCheckpoint();
        process.exit(0);
      });
  };

  process.once("beforeExit", onBeforeExit);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  await server.connect(new StdioServerTransport());
}
