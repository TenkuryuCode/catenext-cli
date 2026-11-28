import { DOCUMENT_KINDS } from "@catenext/shared";
import type { Command } from "commander";
import { configuredEmbeddings, readConfig, stateFilePath } from "../config.js";
import { permissionGrant, permissionList, permissionRevoke, permissionSet } from "../fallback.js";
import { LocalServiceError } from "../local-service.js";
import { PERMISSION_ACTIONS } from "../local-state.js";
import {
  cliService,
  docArchive,
  docGet,
  docList,
  docRestore,
  docSave,
  requireRoot,
  searchShow,
} from "../planning.js";
import { friendly, parseIntRange } from "./shared.js";

/** Register `root`, `permission`, `index`, `doc`, and `search` commands. */
export function registerProjectCommands(program: Command) {
  const rootCmd = program
    .command("root")
    .description("Workspace roots di luar (atau di dalam) checkout; dimiliki persona");
  rootCmd
    .command("list")
    .option("--json", "Keluaran JSON")
    .action((opts: { json?: boolean }) =>
      friendly(async () => {
        const res = await (await cliService()).callTool("manage_roots", { action: "list" });
        if (opts.json) return console.log(JSON.stringify(res, null, 2));
        if (!res.roots.length) return console.log("Belum ada workspace root.");
        for (const row of res.roots) {
          console.log(
            `${row.id}  ${row.path}  owner=${row.owner_persona ?? "-"}  ${row.label ?? ""}`.trim(),
          );
        }
      }),
    );
  rootCmd
    .command("add")
    .argument("<path>", "Path absolut atau relatif")
    .option("--persona <alias>", "Persona pemilik root")
    .option("--label <text>", "Label singkat")
    .option("--json", "Keluaran JSON")
    .action((path: string, opts: { persona?: string; label?: string; json?: boolean }) =>
      friendly(async () => {
        const res = await (await cliService()).callTool("manage_roots", {
          action: "add",
          path,
          persona: opts.persona,
          label: opts.label,
        });
        if (opts.json) return console.log(JSON.stringify(res, null, 2));
        console.log(`✓ ${res.roots.length} root terdaftar`);
      }),
    );
  rootCmd
    .command("remove")
    .argument("<pathOrId>", "Path atau root id")
    .option("--json", "Keluaran JSON")
    .action((pathOrId: string, opts: { json?: boolean }) =>
      friendly(async () => {
        const asId = /^[0-9a-f-]{36}$/i.test(pathOrId);
        const res = await (await cliService()).callTool("manage_roots", {
          action: "remove",
          ...(asId ? { root_id: pathOrId } : { path: pathOrId }),
        });
        if (opts.json) return console.log(JSON.stringify(res, null, 2));
        console.log(`✓ ${res.roots.length} root tersisa`);
      }),
    );

  const permCmd = program
    .command("permission")
    .description("Lihat dan atur matriks izin proyek ini");
  permCmd
    .command("list", { isDefault: true })
    .description("Daftar izin saat ini per aksi")
    .option("--json", "Keluaran JSON")
    .action((opts: { json?: boolean }) =>
      friendly(async () => permissionList(await cliService(), Boolean(opts.json))),
    );
  permCmd
    .command("set")
    .description(`Atur principal untuk aksi (${PERMISSION_ACTIONS.join(", ")})`)
    .argument("<action>", `Salah satu: ${PERMISSION_ACTIONS.join(", ")}`)
    .argument("<principals...>", "Principal yang diizinkan (mis. human orchestrator)")
    .option("--json", "Keluaran JSON")
    .action((action: string, principals: string[], opts: { json?: boolean }) =>
      friendly(async () =>
        permissionSet(await cliService(), action, principals, Boolean(opts.json)),
      ),
    );
  permCmd
    .command("grant")
    .description("Tambahkan principal ke aksi permission")
    .argument("<action>", `Salah satu: ${PERMISSION_ACTIONS.join(", ")}`)
    .argument("<principal>", "Principal yang ditambahkan (mis. human, orchestrator)")
    .option("--json", "Keluaran JSON")
    .action((action: string, principal: string, opts: { json?: boolean }) =>
      friendly(async () =>
        permissionGrant(await cliService(), action, principal, Boolean(opts.json)),
      ),
    );
  permCmd
    .command("revoke")
    .description("Cabut principal dari aksi permission")
    .argument("<action>", `Salah satu: ${PERMISSION_ACTIONS.join(", ")}`)
    .argument("<principal>", "Principal yang dicabut (mis. orchestrator)")
    .option("--json", "Keluaran JSON")
    .action((action: string, principal: string, opts: { json?: boolean }) =>
      friendly(async () =>
        permissionRevoke(await cliService(), action, principal, Boolean(opts.json)),
      ),
    );

  program
    .command("index")
    .description("Bangun ulang indeks graf kode lokal (file/symbol/import) di SQLite")
    .option("--summary", "Cetak ringkasan arsitektur graf kode")
    .option(
      "--write-doc [slug]",
      "Simpan ringkasan arsitektur ke dokumen proyek (default: architecture)",
    )
    .option("--impact <path>", "Analisis file terdampak secara transitif untuk <path>")
    .option(
      "--depth <n>",
      "Kedalaman kelompok direktori (1-5) atau hop dampak (1-3)",
      parseIntRange("--depth", 1, 5),
      2,
    )
    .option(
      "--limit <n>",
      "Jumlah maksimal file terdampak untuk --impact (1-40)",
      parseIntRange("--limit", 1, 40),
      20,
    )
    .option(
      "--max-hubs <n>",
      "Jumlah maksimal hub arsitektur (1-30)",
      parseIntRange("--max-hubs", 1, 30),
      12,
    )
    .option("--include-tests", "Sertakan file test pada ringkasan dan analisis dampak")
    .option(
      "--embeddings",
      "Bangun indeks vektor embedding inkremental (memerlukan config.embeddings)",
    )
    .option("--force", "Paksa re-index penuh meskipun indeks masih fresh")
    .option("--json", "Keluaran JSON")
    .action(
      (opts: {
        summary?: boolean;
        writeDoc?: string | boolean;
        impact?: string;
        depth: number;
        limit: number;
        maxHubs: number;
        includeTests?: boolean;
        embeddings?: boolean;
        force?: boolean;
        json?: boolean;
      }) =>
        friendly(async () => {
          if (opts.impact && opts.depth > 3) {
            throw new LocalServiceError(
              "invalid_input",
              "--impact hanya mendukung --depth 1-3 (gunakan --depth 1..3; --summary mendukung 1..5).",
            );
          }

          const root = await requireRoot();
          const config = await readConfig(root);
          const dbPath = stateFilePath(root, config);
          const service = await cliService(root);
          // Ensure DB + project row exist.
          await service.callTool("session_brief", {});
          const rootsRes = await service.callTool("manage_roots", { action: "list" });
          const rootDirs = [
            { rootId: null, dir: root },
            ...rootsRes.roots.map((r) => ({ rootId: r.id, dir: r.path })),
          ];

          const {
            getGraphCounts,
            getGraphIndexFastPathState,
            indexProjectGraph,
            MICRO_REINDEX_MAX_FILES,
            microReindexModifiedFiles,
          } = await import("../db/graph-index.js");
          const canFastPath = Boolean((opts.summary || opts.impact) && !opts.force);
          const fastState = canFastPath
            ? getGraphIndexFastPathState(dbPath, config.project_id, rootDirs)
            : undefined;
          const skippedIndex = Boolean(
            fastState && fastState.indexed_files > 0 && !fastState.stale,
          );
          let result: Awaited<ReturnType<typeof indexProjectGraph>>;
          if (skippedIndex) {
            result = getGraphCounts(dbPath, config.project_id);
          } else if (
            canFastPath &&
            fastState &&
            fastState.indexed_files > 0 &&
            fastState.reason === "modified_files" &&
            fastState.modified_files &&
            fastState.modified_files.length > 0 &&
            fastState.modified_files.length <= MICRO_REINDEX_MAX_FILES
          ) {
            const micro = await microReindexModifiedFiles(
              dbPath,
              config.project_id,
              rootDirs,
              fastState.modified_files,
            );
            result = micro.applied
              ? micro.counts
              : await indexProjectGraph(dbPath, config.project_id, root, {
                  rebuildEdges: opts.force,
                });
          } else {
            result = await indexProjectGraph(dbPath, config.project_id, root, {
              rebuildEdges: opts.force,
            });
          }

          const includeTests = Boolean(opts.includeTests);
          const wantDoc = opts.writeDoc !== undefined && opts.writeDoc !== false;
          const wantSummary = Boolean(opts.summary || wantDoc);
          let summary: Awaited<ReturnType<typeof service.callTool<"graph_summary">>> | undefined;
          let impact: Awaited<ReturnType<typeof service.callTool<"graph_impact">>> | undefined;
          let savedDoc: Awaited<ReturnType<typeof service.callTool<"save_document">>> | undefined;

          if (wantSummary) {
            summary = await service.callTool("graph_summary", {
              depth: opts.depth,
              max_hubs: opts.maxHubs,
              include_mermaid: true,
              include_tests: includeTests,
            });
          }

          if (opts.impact) {
            impact = await service.callTool("graph_impact", {
              path: opts.impact,
              depth: opts.depth,
              limit: opts.limit,
              include_tests: includeTests,
            });
          }

          if (wantDoc && summary) {
            const { renderArchitectureMarkdown } = await import("../db/graph-summary.js");
            const docSlug =
              typeof opts.writeDoc === "string" && opts.writeDoc.trim()
                ? opts.writeDoc.trim()
                : "architecture";
            const content = renderArchitectureMarkdown(summary, {
              depth: opts.depth,
              includeTests,
            });
            let expectedVersion: number | undefined;
            try {
              const existing = await service.callTool("get_document", {
                slug: docSlug,
                outline_only: true,
              });
              expectedVersion = existing.version;
            } catch (error) {
              if (!(error instanceof LocalServiceError && error.code === "not_found")) {
                throw error;
              }
            }
            savedDoc = await service.callTool("save_document", {
              slug: docSlug,
              title: "Project architecture",
              kind: "architecture",
              content,
              ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
            });
          }

          let embeddingsResult:
            | Awaited<ReturnType<typeof import("../code-search.js")["indexCodeEmbeddings"]>>
            | undefined;
          if (opts.embeddings) {
            const embConfig = configuredEmbeddings(config);
            if (!embConfig) {
              throw new LocalServiceError(
                "invalid_input",
                "Konfigurasi `embeddings` belum diatur di .catenext/config.yaml.",
              );
            }
            const [
              { indexCodeEmbeddings },
              { checkpointWalAndClose, openDatabaseAt },
              { createEmbeddingClient },
            ] = await Promise.all([
              import("../code-search.js"),
              import("../db/open.js"),
              import("../embeddings.js"),
            ]);
            const client = createEmbeddingClient(embConfig);
            const db = openDatabaseAt(dbPath);
            try {
              embeddingsResult = await indexCodeEmbeddings(root, {
                db,
                projectId: config.project_id,
                roots: rootsRes.roots.map((r) => ({ id: r.id, path: r.path, label: r.label })),
                client,
              });
            } finally {
              checkpointWalAndClose(db);
            }
          }

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  ...result,
                  ...(skippedIndex ? { skipped: true } : {}),
                  ...(summary ? { summary } : {}),
                  ...(impact ? { impact } : {}),
                  ...(savedDoc ? { document: savedDoc.document, created: savedDoc.created } : {}),
                  ...(embeddingsResult ? { embeddings: embeddingsResult } : {}),
                },
                null,
                2,
              ),
            );
            return;
          }

          console.log(
            skippedIndex
              ? `✓ index fresh (skipped re-index) files=${result.files} symbols=${result.symbols} edges=${result.edges}`
              : `✓ indexed files=${result.files} symbols=${result.symbols} edges=${result.edges}`,
          );
          if (embeddingsResult) {
            console.log(
              `✓ embeddings (${embeddingsResult.provider}/${embeddingsResult.model}) indexed=${embeddingsResult.indexed} skipped=${embeddingsResult.skipped} deleted=${embeddingsResult.deleted} total=${embeddingsResult.totalChunks}`,
            );
          }
          if (opts.summary && summary) {
            const { renderArchitectureMarkdown } = await import("../db/graph-summary.js");
            console.log(
              `\n${renderArchitectureMarkdown(summary, { depth: opts.depth, includeTests }).trimEnd()}`,
            );
          }
          if (impact) {
            const { renderImpactMarkdown } = await import("../db/graph-summary.js");
            console.log(`\n${renderImpactMarkdown(impact).trimEnd()}`);
          }
          if (savedDoc) {
            console.log(
              `✓ Dokumen "${savedDoc.document.slug}" ${savedDoc.created ? "dibuat" : "diperbarui"} (v${savedDoc.document.version}).`,
            );
          }
        }),
    );

  const doc = program
    .command("doc")
    .description("Dokumen proyek lokal (blueprint, ERD, arsitektur, keputusan)");
  doc
    .command("list")
    .option("--include-archived", "Sertakan dokumen yang sudah diarsipkan")
    .option("--json", "Keluaran JSON")
    .action((opts: { json?: boolean; includeArchived?: boolean }) =>
      friendly(async () =>
        docList(await cliService(), {
          json: opts.json,
          includeArchived: opts.includeArchived,
        }),
      ),
    );
  doc
    .command("get")
    .argument("<slug>")
    .option("--outline", "Hanya daftar heading Markdown (tanpa isi lengkap)")
    .option("--section <title>", "Hanya satu bagian yang cocok dengan judul heading")
    .option("--json", "Keluaran JSON")
    .action((slug: string, opts: { json?: boolean; outline?: boolean; section?: string }) =>
      friendly(async () =>
        docGet(await cliService(), slug, {
          json: opts.json,
          outline: opts.outline,
          section: opts.section,
        }),
      ),
    );
  doc
    .command("archive")
    .argument("<slug>")
    .option("--json", "Keluaran JSON")
    .action((slug: string, opts: { json?: boolean }) =>
      friendly(async () => docArchive(await cliService(), slug, Boolean(opts.json))),
    );
  doc
    .command("restore")
    .argument("<slug>")
    .option("--json", "Keluaran JSON")
    .action((slug: string, opts: { json?: boolean }) =>
      friendly(async () => docRestore(await cliService(), slug, Boolean(opts.json))),
    );
  doc
    .command("save")
    .argument("<slug>", "Slug dokumen, mis. blueprint atau erd")
    .requiredOption("--file <path>", "File Markdown berisi dokumen")
    .option("--title <text>", "Judul dokumen (default: slug)")
    .option("--kind <kind>", `Salah satu: ${DOCUMENT_KINDS.join(", ")}`, "other")
    .option(
      "--expected-version <n>",
      "Versi yang Anda baca (0 = dokumen baru); mencegah menimpa sesi lain. Jangan pakai --version (bentrok flag versi CLI).",
    )
    .option("--json", "Keluaran JSON")
    .action(
      (
        slug: string,
        opts: {
          file: string;
          title?: string;
          kind: string;
          expectedVersion?: string;
          json?: boolean;
        },
      ) =>
        friendly(async () =>
          docSave(await cliService(), slug, {
            file: opts.file,
            title: opts.title,
            kind: opts.kind,
            version: opts.expectedVersion,
            json: opts.json,
          }),
        ),
    );

  program
    .command("search")
    .description("Cari dokumen, skill, task, atau kode lokal")
    .argument("<query>", "Query pencarian")
    .option(
      "--source <src>",
      "Sumber: document|skill|task|code (bisa diulang)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("-n, --limit <n>", "Jumlah hasil", (v) => Number.parseInt(v, 10), 8)
    .option("--json", "Keluaran JSON")
    .action((query: string, opts: { source: string[]; limit: number; json?: boolean }) =>
      friendly(async () =>
        searchShow(query, {
          source: opts.source.length ? opts.source : undefined,
          limit: opts.limit,
          json: opts.json,
        }),
      ),
    );
}
