import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentApi } from "../api-client.js";
import { ConfigError, findProjectRoot, readConfig } from "../config.js";
import { CredentialsError, loadCredentials, resolveApiUrl } from "../credentials.js";
import { createCatenextMcpServer, type ServerContext } from "./server.js";

/**
 * `catenext mcp`: server MCP stdio. stdout khusus protokol MCP, jadi semua log ke stderr.
 * Config & kredensial dibaca sekali saat tool pertama dipanggil; bila gagal, tool
 * membalas pesan perbaikan alih-alih membuat server mati diam-diam di IDE.
 */
export async function runMcpServer(opts: { root?: string; version: string }) {
  let agentName: string | undefined;
  let cached: Promise<ServerContext> | undefined;

  const load = async (): Promise<ServerContext> => {
    try {
      const start = opts.root && !opts.root.includes("${") ? opts.root : process.cwd();
      const root = await findProjectRoot(start);
      if (!root) {
        return {
          ok: false,
          error: `Tidak ada .catenext/config.yaml di ${start} atau folder induknya. Jalankan \`catenext init\` di root repo.`,
        };
      }
      const config = await readConfig(root);
      const creds = await loadCredentials();
      const api = new AgentApi({
        baseUrl: resolveApiUrl(config.api_url, creds.api_url),
        apiKey: creds.api_key,
        projectId: config.project_id,
        repoName: config.repo_name,
        agentName: () => agentName,
      });
      process.stderr.write(
        `[catenext] repo "${config.repo_name}" (project ${config.project_id}) dari ${root}\n`,
      );
      return { ok: true, api, config, root };
    } catch (err) {
      if (err instanceof ConfigError || err instanceof CredentialsError) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  };

  const server = createCatenextMcpServer({
    version: opts.version,
    context: () => {
      cached ??= load();
      return cached.then((ctx) => {
        if (!ctx.ok) cached = undefined; // coba lagi setelah pengguna memperbaiki
        return ctx;
      });
    },
  });
  server.server.oninitialized = () => {
    agentName = server.server.getClientVersion()?.name;
  };

  await server.connect(new StdioServerTransport());
}
