# Changelog

Semua perubahan penting Catenext dicatat di sini, satu bagian per versi rilis CLI
(`catenext` di npm). Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/)
dan versi memakai [SemVer](https://semver.org/lang/id/).

Aturan: setiap PR yang mengubah perilaku menambah baris di **Belum dirilis**. Saat rilis, bagian
itu diganti judul versi + tanggal (`## [X.Y.Z] - YYYY-MM-DD`), dan workflow *Release CLI* menolak
tag yang versinya belum ada di file ini. Perbarui juga [docs/STATUS.md](docs/STATUS.md).

## [Belum dirilis]

## [0.14.1] - 2026-11-27

### Diperbaiki
- Mengganti regex tag `<script>` di `extractSfcScriptBlocks` (`apps/cli/src/db/graph-index.ts`) dengan linear character/index scanner (`findTagClose`, `isAllowedScriptType`) untuk menutup alert CodeQL `js/bad-tag-filter`, menangani variasi penutup (`</script >`, `</SCRIPT ...>`), quoted `>` pada atribut, dan batas nama tag (`<scripture>`).

## [0.14.0] - 2026-11-27

### Ditambahkan
- Polyglot code graph & FTS5 search: dukungan `.php` (resolusi `use` via `composer.json` PSR-4 `autoload`/`autoload-dev` dalam batas `realRoot`), `.vue`/`.svelte` (ekstraksi blok `<script>` dengan offset baris), ekstraksi simbol `.java`/`.kt`, serta resolusi import lokal untuk Go (`go.mod`), Rust (`mod`, `crate::`, `super::`, `self::`), dan Python lokal/relatif tanpa membuat edge palsu ke stdlib/dependensi eksternal.
- Ekstensi FTS5 `TEXT_EXT` di `code-search.ts`: `.php`, `.vue`, `.svelte`, `.astro`, `.graphql`, dan `.proto`.
- Peta arsitektur hemat-token: tool MCP read-only `graph_summary` (`depth`, `max_hubs`, `include_mermaid`) pada katalog `orchestrator` & `worker` (total 28 tool default; 32 dengan `--allow-crud`), serta flag `catenext index --summary`, `--write-doc [slug]` (default `architecture`, `kind: "architecture"`), `--depth <n>`, `--max-hubs <n>`, dan `--json`.
- Smoke check bundle terisolasi (`--version`, `init`, dan `mcp` JSON-RPC `initialize`) pada `apps/cli/mirror/.github/workflows/ci.yml`.

### Diubah
- Penutupan handle SQLite mandiri di `code-search.ts`, `graph-index.ts`, dan `graph-summary.ts` memakai `checkpointWalAndClose` untuk mencegah file `-wal`/`-shm` tertinggal, serta sanitasi cell tabel Markdown (`|`, backtick, CR/LF) di `renderArchitectureMarkdown`.
- Penyelarasan dokumentasi `README.md`, `apps/cli/README.md`, `apps/cli/mirror/README.md`, `docs/blueprint.md`, dan `docs/STATUS.md`.

## [0.13.0] - 2026-11-27

### Ditambahkan
- SQLite schema v6 (`code_search_files` + `code_search_fts` FTS5 `unicode61` dengan fallback `LIKE` via `SAVEPOINT`) menggantikan cache JSON `.catenext/cache/*.json` (pruning aman dengan mempertahankan `cli-session-id`).
- Shared `.gitignore`-aware `workspace-walk` untuk graph indexing & code search (root + nested `.gitignore`, extra skip dir, batas 256 KiB per file, serta guard `lstat`/`realpath` terhadap symlink loop).
- `catenext backup <out>` (`VACUUM INTO`, rename atomik, izin `0o600`, guard `--force`) dan `catenext restore <file>` (validasi file reguler non-symlink, header SQLite, `integrity_check`, verifikasi tabel Catenext, serta salinan cadangan sebelum swap `--force`).
- CI lintas-platform (`Linux ARM64`, `macOS`, `Windows`) dan smoke check bundle CLI (`.github/scripts/smoke-cli-bundle.mjs` + `.gitattributes` LF).

### Diubah
- Lifecycle SQLite WAL: `PRAGMA wal_checkpoint(TRUNCATE)` pada `postAction` CLI (kecuali `doctor`/`watch`/`mcp`/`config`/`verify`) dan shutdown MCP (`beforeExit`/`SIGINT`/`SIGTERM`).
- Keamanan & stdio MCP: perluasan pola sensor `scrubber.ts` (`url_password` + token provider sambil menjaga link PR, SHA commit, UUID), batas frame stdio 1 MiB (`STDIO_DEFAULT_MAX_LINE_SIZE`) dengan `StdioBufferError` + pemulihan JSON-RPC `-32600`, serta penghapusan `apps/cli/AGENTS.md` yang usang.
- Upgrade **Master Prompt** di `apps/cli/mirror/README.md` serta penyelarasan `README.md` dan `apps/cli/README.md`.

## [0.12.0] - 2026-11-27

Rilis tunggal Epic A (DX onboarding) + Epic B (siklus dokumen) + Epic C (CRUD persona/skill).

### Ditambahkan
- `catenext init --dry-run`: pratinjau seed persona SQLite dan rencana stub agen lewat helper yang sama dengan apply, tanpa menulis config, state, atau file stub.
- `catenext doctor` dan `catenext verify`: inventori read-only artefak onboarding (`CATENEXT.md`, blok `AGENTS.md`, entry pointer platform, stub agen) plus tips perbaikan bernomor (`sync --force`, `verify`, …); juga melaporkan skill tidak valid dan stub persona hilang.
- Dukungan VS Code kelas pertama: `.vscode/CATENEXT.md`, stub `.github/agents` (Copilot-native), baris **Mulai cepat** di README; `init`/`sync` tidak lagi memperlakukan `vscode` sebagai MCP-only.
- SQLite schema v5: kolom `documents.archived_at` untuk soft-archive dokumen proyek (migrasi idempoten; baris lama tetap aktif).
- MCP `archive_document` / `restore_document`; filter opsional `include_archived` pada `get_project_context` dan `search_context` (default menyembunyikan terarsip).
- CLI `catenext doc archive|restore`, `doc list --include-archived`, serta `doc get --outline` / `--section` terhubung ke pembacaan MCP yang sama.
- Skill repo `docs-hygiene`: arsip/restore nyata, audit lewat `get_project_context` + `include_archived`, dan panduan memecah dokumen panjang.
- `catenext persona remove` (CLI + MCP) dengan guard lease aktif / pemilik workspace root; regenerasi stub IDE setelah `persona set|remove` (`--no-sync` / `--platform`).
- CLI `catenext skill list|create|set|remove` (+ `load`) untuk skill Markdown di `.catenext/skills/`.

### Diubah
- Interview `init`: rekomendasi platform mengikuti platform terdeteksi; default seed persona **`matched`**; entry pointer platform hanya direncanakan lewat `planInit` (satu jalur perencanaan).
- Dokumentasi: paste master prompt pendek selaras `renderMasterPrompt` / `CATENEXT.md`; tips locale (`session_prefs.locale`) di README mirror serta baris platform VS Code di panduan platform.
- Indeks dokumen default (`doc list`, konteks MCP, pencarian) mengecualikan slug terarsip; `save_document` mempertahankan `archived_at`.
- README mirror: baris **Mulai cepat** dan bagian **Dokumen dan skill** menjelaskan outline, section, arsip/restore, CRUD persona/skill, filter import template, serta pemetaan perintah CLI ↔ tool MCP.

## [0.11.1] - 2026-11-27

### Diubah
- Dokumentasi publik (README mirror): **Mulai cepat**, panduan starter prompt untuk manusia, diagram alur agen, serta dokumentasi `template export|import` dan `catenext watch`.
- README CLI internal: contoh `catenext watch`.

## [0.11.0] - 2026-11-27

### Ditambahkan
- `catenext template export` / `catenext template import` untuk bundle personas + skill repo (JSON `catenext.persona-skills` v1) dengan scrubbing secret; opsi `--dry-run`, `--personas-only`, `--skills-only`.
- Stub agen IDE lebih native: Cursor (`model: inherit`), Antigravity (`.agents/agents` + flag subagent), Codex (`.codex/agents/*.toml`), serta entry pointer Claude Code yang diperkaya.
- `catenext watch` (`--interval`, `--once`, `--epic`, `--json`): ringkasan terminal board, lease/worktree aktif, pending approval, dan `task_events` terbaru lewat polling SQLite read-only tanpa mengunci writer.

## [0.10.0] - 2026-11-27

### Ditambahkan
- Managed worktrees: `claim --create-worktree` / `--worktree`, `worktree list`, dan `worktree prune` (preview default; `--apply` hanya menghapus checkout managed yang eligible — bukan primary/active/dirty/unmanaged, dan tidak menghapus branch).
- `catenext doctor` (read-only; `--fix` hanya perbaikan aman mode/izin file state; tidak pernah prune worktree).
- Stable Node launcher: `init`/`sync` memilih ServBay/nvm `current` atau `node` di PATH daripada `process.execPath` yang berversi; override dengan `--mcp-command`.
- MCP planning CRUD (`update_task`, `update_epic`, `set_dependencies`, `cancel_task`) tersembunyi/ditolak kecuali proses diluncurkan dengan `--allow-crud` eksplisit (role worker tetap ditolak); approval tetap CLI-human-only.
- SQLite schema v4: persistensi `position` task serta resolusi persona ID namespace proyek.

### Diubah
- Doctor memakai inventori registrasi Git worktree (bukan lifecycle inventory penuh) agar tetap read-only dan independen dari ketersediaan SQLite.

## [0.9.0] - 2026-11-27

### Ditambahkan
- Filter katalog MCP opsional lewat `catenext mcp --role <orchestrator|worker>`; tanpa flag, semua tool tetap tersedia.
- `get_document` dapat mengembalikan outline heading Markdown (`outline_only`) atau satu bagian (`section`). `claim_task` dengan `compact: true` mengembalikan ringkasan handoff dependensi; handoff lengkap tetap menjadi default dan bisa dibaca lewat `get_project_context` dengan lease aktif.
- `catenext log` mendukung filter `--event`, `--actor`, dan `--since`, serta keluaran `--format table|json|csv`. Opsi `--json` tetap tersedia.

### Diubah
- Katalog `tools/list` MCP lebih ringkas: deskripsi dipendekkan dan metadata JSON Schema yang berulang dikurangi, tanpa melonggarkan validasi input.
- Server MCP memakai implementasi stdio internal yang ringan. Paket CLI dibundel tanpa dependensi npm runtime.
- Kebijakan MCP konsisten menolak `approve_plan` dan `approve`, serta mengarahkan pengguna ke `catenext task approve` dan `catenext review approve` di CLI.
- Validasi skill repo diperketat: indeks melaporkan nama duplikat atau skill tidak valid, dan pembacaan serta penulisan memeriksa path, isi skill, dan indikasi secret.

## [0.8.0] - 2026-11-27

### Ditambahkan
- Task & Epic CRUD lokal: `catenext epic update`, `catenext task update` (`--title`, `--prompt`, `--persona`, `--role`, `--repo`, `--clear-stale`), `catenext task cancel`, dan `catenext task deps` dengan validasi dependensi dan deteksi siklus DAG serta audit event `task_events`.
- Template epic siap pakai (`EPIC_TEMPLATES`: `fitur-login`, `crud-api`) lewat `catenext epic templates` dan `catenext epic create --template <id>`, serta pembuatan task inline via flag pada `catenext task create` (`--title`, `--prompt`, `--persona`, `--role`, `--repo`, `--depends-on`, `--requires-approval`).
- Paparan opsional `session_prefs.locale` pada respons MCP `session_brief` dan `get_project_context`.
- Flag `--force` pada `catenext sync` untuk memaksa pembaruan entri MCP, blok `AGENTS.md`, `CATENEXT.md`, pointer platform, dan stub agen.
- Rangkaian unit test dedicated untuk `verify.ts`, `interview.ts`, `planning.ts`, dan `agents/entry-pointers.ts`, plus cakupan test baru untuk CRUD, `sync --force`, `planRemove`, `SUBAGENT_DIRS`, dan validasi URL PR multi-Git.

### Diubah
- `planRemove` kini membersihkan stub di semua platform terpilih beserta `CATENEXT.md` dan `PLATFORM_ENTRY_FILES`; `planSync` memakai perbandingan `Set` untuk perubahan platform; dan `SUBAGENT_DIRS` untuk `codex`/`vscode` tidak lagi jatuh ke `.claude/agents`.
- `PullRequestUrlSchema` digeneralisasi untuk GitHub, GitLab (`/merge_requests/`, `/-/merge_requests/`), Bitbucket (`/pull-requests/`), dan Gitea (`/pulls/`), serta `PullRequestRefSchema.url` menjadi opsional untuk mendukung review lokal tanpa URL PR.

## [0.7.0] - 2026-11-27

### Ditambahkan
- MCP tool `search_code` dengan cuplikan kode kontekstual (`context_lines`), plus dukungan `workspace_roots` pada `catenext index` dan fallback Node.js saat `rg` tidak tersedia.
- Metadata worktree pada lease (`worktree.session`, `worktree.branch`, `worktree.base_branch`, `integrated_commit`), pembersihan otomatis lease kedaluwarsa, serta peringatan dirty tree saat handoff.
- SQLite `WAL` mode, `busy_timeout = 5000`, `foreign_keys = ON`, permission file `0o600` (`.sqlite`, `-wal`, `-shm`), recovery lock stale berbasis PID + timestamp + symlink/hardlink check, path baca read-only tanpa `.lock`, partial diff write (`saveProjectDiff`), serta migrasi skema idempoten (`v1 -> v2 -> v3`).
- Tabel audit `task_events` di SQLite untuk mencatat `claim`, `release`, `block`, `handoff`, `manage_task`, `review_pull_request`, dan `lease_expired`, beserta perintah CLI `catenext log [task_id] [-n/--limit] [--json]`.
- Subcommand CLI `catenext permission` (`list`, `set`, `grant`, `revoke`) untuk mengelola matriks permission lokal, serta pemeriksaan mode `0o600` file SQLite pada `catenext verify` di POSIX.

### Diubah
- Perbaikan code graph: resolusi ekstensi `.js`/`.ts`/`.tsx`/`.jsx` dan `index.*`, `graph_neighbors` depth=2 yang akurat, incremental re-index berdasarkan mtime/hash, dan ekstraksi simbol multi-bahasa (TS/JS, Python, Go, Rust).
- `scrubber.ts`: sensor nilai secret pada key JSON/objek terpetik (`"api_key": "..."`, `'token': '...'`) tanpa merusak JSON valid atau melakukan redaksi ganda; penyatuan `SCRUB_TOOL_FIELDS` dan `DEFAULT_SCRUB_SKIP_KEYS` (termasuk `path` dan `query`) di MCP server dan `LocalService`.
- Penegakan matriks permission pada `upsert_persona` dan pengaturan via agent, serta validasi `manage_roots add` agar hanya menerima direktori nyata non-symlink.

## [0.6.2] - 2026-11-27

### Ditambahkan
- README: bagian **Memperbarui Catenext** (upgrade CLI + `sync --force` + restart IDE).

### Diubah
- README mirror publik: logo/wordmark Catenext + badge npm di header.
- Master prompt / aturan orchestrator: jika research, fetch, browser, atau akses lain
  tidak tersedia, minta izin/bantuan user (`ACCESS NEEDED`) — jangan mengarang hasil.
- Aturan eksplisit: **jangan pernah mempublikasikan** kredensial atau secret krusial
  (handoff, docs, git, PR, issues) — cukup path; scrubber tetap best-effort.
- Cheat sheet master prompt: baris upgrade CLI.

## [0.6.1] - 2026-11-27

### Diubah
- Seed persona default **`matched`**: hanya subagent yang cocok dengan stack/repo
  (mis. React → `fe`+`reviewer`; API Go → `be`+`reviewer`). Role lain (`tester`,
  `security`, `scribe`, …) ditambah nanti lewat `catenext persona set` + `sync`.
- Interview `init` / `interview_setup`: opsi `matched` (rekomendasi), `minimal`, `all`, `none`.
- Deteksi stack Android (`build.gradle`, `AndroidManifest.xml`, …).

## [0.6.0] - 2026-11-27

### Ditambahkan
- SQLite state default `.catenext/catenext.sqlite` (migrasi sekali dari `state.json` → `*.bak`).
- `catenext init` interview (TTY) + `--yes`; seed persona `be`/`fe`/`tester`/`android`/`security`/`reviewer`/`scribe`.
- MCP/CLI: `interview_setup`, `session_brief` / `catenext brief`, `manage_roots` / `catenext root`, `graph_neighbors`, `symbol_search`, `catenext index`.
- Agent stubs English multi-platform (Claude/Cursor/Antigravity/OpenCode) + orchestrator stubs; stack in agent context.
- Root `CATENEXT.md` master prompt for new sessions; platform entry files (`CLAUDE.md`, `.cursor/CATENEXT.md`, …) redirect there, then `AGENTS.md`.
- `session_brief.pending_approvals` with approve/revise/next options for human chat gates.
- README Master Prompt awal untuk cold-start chat (salin-tempel), termasuk **Bootstrap (install/init)**.
- Parallel subagents wajib worktree terpisah; orchestrator memantau semua worktree, mengintegrasikan, lalu bertanya manusia: PR | merge | revise | next.
- Kickoff brainstorm + `sync-board` / skill `cross-agent-sync`; persona `scribe` + skill `docs-hygiene` untuk merapikan dokumen.

### Changed
- CLI and stdio MCP share local task, handoff, persona, and document state in SQLite.
- Compact MCP JSON (no pretty-print); board titles/blockers truncated unless `verbose`.
- `init`, `sync`, `verify`, and `remove` accept `--platform` for MCP setup.
- `approve` / `approve_plan` hanya lewat CLI manusia; jalur MCP agen ditolak.
- Token lease task/review di-hash (`sha256.…`) di state; pemanggil tetap memakai token plaintext.
- README mirror publik (`catenext-cli`): panduan lokal SQLite, master prompt `CATENEXT.md`,
  worktree paralel, approval manusia; hilangkan alur Cloud/login/dashboard.
- Master prompt (`renderMasterPrompt` / README): bagian Bootstrap agar agen bisa `npm install -g catenext`
  + `init`/`verify` dari chat sebelum orkestrasi.

### Removed
- Web dashboard, Cloud API, browser login, premium quotas, and deployment configuration.
- Existing cloud data is not migrated automatically.
- Default JSON `state.json` as canonical store (legacy migrate only).

## [0.5.0] - 2026-11-26

### Ditambahkan
- Semantic search: embedding cache (`embedding_cache`) + indeks proyek
  (`embedding_index`), tool MCP `search_context`, `POST /api/v1/agent/search`, Web **Cari**,
  CLI `catenext search`, indeks kode lokal di `.catenext/cache/code-embeddings/`.
- Rerank opsional (`CATENEXT_RERANK_API_KEY`); tanpa key → degraded (cosine saja).
- Kuota `search_queries_per_day` dan `indexed_chars`.
- Docs `/docs/search`. Migrasi API `0009_embedding_search.sql`.

## [0.4.0] - 2026-11-26

### Ditambahkan
- Proyek: `layout` `monorepo` | `polyrepo` (default). Monorepo: `claim_task` / `catenext claim`
  wajib worktree (`worktree_required`). Polyrepo: worktree tetap opsional. Diset di Web
  (pengaturan proyek), bukan autodetect.
- `complete_handoff` / `catenext done` wajib `pull_request` (`--pr` + `--base`); status selalu
  `NEEDS_REVIEW` sampai manusia approve/merge PR. Tanpa status ship tambahan sebelum commit.
- Web: tombol **Salin prompt orchestrator** per task (prompt delegasi ke subagent, termasuk
  worktree/PR bila monorepo).
- Web: halaman dokumentasi produk `/docs` (konsep, mulai cepat, orchestrator & subagent, multi-repo,
  revisi, dokumen proyek, review PR, daftar perintah, data, kuota, dan pemecahan masalah), ditautkan
  dari header dan footer landing. Header/footer/font halaman publik dipindah ke
  `components/site/chrome.tsx`.
- Migrasi API `0008_project_layout.sql`.

### Diubah
- CLI: `catenext doc save` memakai `--expected-version` (bukan `--version`, bentrok flag versi CLI).
- Kanban: kolom **Menunggu review PR**; DONE dari NEEDS_REVIEW lewat panel PR, bukan drag Approve.
- MCP/CLI/subagent: instruksi claim/handoff selaras (commit di branch OK; serahkan lewat PR).
- README mirror publik `catenext-cli`: alur master prompt, orchestrator dan persona, multi-repo,
  revisi, dokumen proyek, tabel perintah CLI ↔ MCP, data yang dikirim, dan pemecahan masalah.

## [0.3.0] - 2026-11-25

### Ditambahkan
- Orchestrator: agen utama sesi menjadi orchestrator, persona menjadi subagent. `catenext init`
  menulis aturan orchestrator di blok `AGENTS.md`; Web menampilkan **master prompt** yang sama
  setelah proyek dibuat (tombol *Master prompt* di halaman proyek).
- MCP `manage_task` (CLI `catenext revise`, `catenext assign`): revisi memindahkan task
  NEEDS_REVIEW/DONE ke kolom Revisi tanpa membuat task baru, opsional mengganti persona;
  `assign` menetapkan persona/role task yang belum dikerjakan.
- Multi-repo: persona proyek memegang repo (`repos`, CLI `catenext persona set --repo be`); task
  tanpa `target_repo` diarahkan ke repo persona; claim dari checkout repo lain ditolak
  (`persona_repo_mismatch`). MCP `get_project_board` (CLI `catenext board`) menampilkan papan
  lintas repo untuk orchestrator.
- Dokumen proyek di Cloud (blueprint, ERD, arsitektur, kontrak API, keputusan): MCP
  `get_document`/`save_document` (CLI `catenext doc list|get|save`) dengan `expected_version`
  agar sesi lain tidak tertimpa; tab *Dokumen* di Web. `get_project_context` membawa
  `project_repos` dan indeks dokumen.
- Kuota Free per fitur: 2 dokumen (maks. 5.000 karakter), 2 repo per proyek, 5 revisi per bulan,
  1 task dikerjakan bersamaan. Pro/Team longgar.

### Diubah
- `upsert_persona` / `catenext persona set` tanpa aturan kini mempertahankan aturan lama; persona
  proyek baru mewarisi aturan persona master (workspace) beralias sama. Kirim `rules: []` untuk
  mengosongkan.
- Subagent Claude Code (`catenext sync`) memuat repo yang dipegang dan batas subagent.
- Web: landing `/` menegaskan value prop literal (orkestrasi task antar-agen AI coding), brand
  Catenext di hero, bagian masalah→solusi, fitur dirapikan, tipografi Bricolage/Figtree hanya di
  landing (dashboard tetap system stack), dan metadata SEO diselaraskan.

## [0.2.0] - 2026-11-25

### Ditambahkan
- CLI dan MCP: antrean, klaim, keputusan, dan pengecekan merge PR GitHub. Handoff lewat PR menahan
  task hilir sampai merge terverifikasi dan persetujuan pada SHA yang tepat terpenuhi.
- `catenext claim --worktree` memakai lease sesi dan reservasi branch sehingga task independen
  dapat berjalan paralel dalam satu repo. `catenext release` melepas lease untuk sesi lain.
- `catenext skill load --revision <sha>` dan MCP `load_skill` membaca versi skill yang sama dari Git.
  Indeks bersama diterbitkan lewat `sync` dari default branch origin yang sudah diperbarui.
- Dashboard: tab Pull request, progres implementasi hingga merge, dan persetujuan per commit.
- Persona penanggung jawab per task (`persona_id`). Role task mengikuti persona; bila hanya satu
  persona yang cocok dengan role, persona itu dipasang otomatis. Dipilih di form task baru dan drawer
  task, tampil sebagai badge di kartu.
- Agen: `get_ready_tasks`/`claim_task` dengan `agent_alias` hanya mengambil task milik persona itu
  (claim task milik persona lain ditolak 403); `claim_task` mengembalikan aturan persona; `create_tasks`
  menerima `persona` (alias). CLI: `catenext next --as <alias>` dan `catenext claim <id> --as <alias>`.
- `catenext sync` membuat subagent Claude Code per persona di `.claude/agents/<alias>.md`, sehingga
  orchestrator cukup memanggil persona (mis. "adel, kerjakan"). `catenext remove` ikut membersihkannya.
- Web: landing page publik di `/` (sebelumnya redirect ke `/projects`): hero, cara kerja, fitur,
  mulai cepat dengan perintah CLI, harga dari `PLAN_LIMITS`, dan footer ke mirror CLI + npm.
  Header menampilkan "Buka dashboard" bila sudah login. Dashboard tetap di `/projects`.
- Web: metadata SEO untuk landing (title, description, OpenGraph, Twitter) dengan `metadataBase`
  dari `PUBLIC_URL`; `app/robots.ts` dan `app/sitemap.ts` (izinkan `/`, `/login`, `/signup`;
  blokir dashboard dan `/api`).
- Dashboard: ubah nama proyek (ikon pensil di samping judul), serta edit dan hapus epic dari kartu
  epic. Hapus epic meminta konfirmasi dan menyebut jumlah task yang ikut terhapus.
- API: `DELETE /epics/:id` menolak (409 `epic_in_progress`) bila ada task di epic itu yang sedang
  dikerjakan agen, sama seperti hapus task.

### Diperbaiki
- API: `PATCH /projects/:id` dan `PATCH /personas/:id` tidak lagi mengosongkan `detected_stack` /
  `rules` yang tidak dikirim (skema update dari `.partial()` Zod 4 tetap mengisi nilai default).
- Workflow Release CLI: typecheck/test lewat turbo sehingga `@catenext/shared` di-build lebih dulu;
  root monorepo diganti nama `catenext-monorepo` agar `--filter catenext` tidak ikut menjalankan root.
- `scripts/build-cli-mirror.mjs` menyalin file dengan baca/tulis biasa, bukan `fs.cpSync`, yang gagal
  EACCES di workspace runner self-hosted.
- CI dan Release CLI memakai `shell: bash` (di container, default `sh` gagal "Bad substitution"
  pada `${GITHUB_SHA::7}` saat push ke mirror).

### Diubah
- Web: halaman Paket & kuota (`/upgrade`) kini menampilkan retensi handoff untuk setiap paket;
  label harga & fitur paket dipindah ke `apps/web/lib/plans.ts` dan dipakai bersama landing page.
- CI dan Release CLI di repo `catenext` berjalan di runner self-hosted (`docs/runner.md`);
  job berjalan di container `node:22-bookworm` (Postgres lewat nama service, store pnpm di volume Docker lokal tanpa cache GitHub). Publish npm tetap di runner GitHub demi provenance.

## [0.1.2] - 2026-11-25

### Diperbaiki
- `npx catenext init` kini menulis entri MCP `npx -y catenext mcp`. Di 0.1.1 entri menunjuk ke
  skrip di cache `~/.npm/_npx/...` yang bisa terhapus kapan saja, sehingga server MCP berhenti
  jalan. Pasang ulang dengan `npx -y catenext@latest sync --fix` atau `init` ulang.

### Diubah
- README CLI: alur pemasangan per repo tanpa instalasi global.

## [0.1.1] - 2026-11-25

### Diperbaiki
- CLI kini terhubung ke server resmi `https://catenext.mapan.digital` secara default. Di 0.1.0
  default-nya `http://localhost:8787`, sehingga `catenext login` perlu `--api-url`.
  Server lokal tetap bisa dipakai lewat `--api-url http://localhost:8787` atau `CATENEXT_API_URL`.

### Ditambahkan
- `CHANGELOG.md` dan `docs/STATUS.md`; rilis CLI gagal bila versinya belum dicatat di changelog.
- Paket npm menyertakan `CHANGELOG.md`.

## [0.1.0] - 2026-11-25

Rilis publik pertama. Web + API live di https://catenext.mapan.digital (paket Free; Pro/Team
sudah dibangun tetapi terkunci, "Segera hadir").

### Ditambahkan
- **CLI `catenext`**: `login` lewat browser (device flow, API key dikirim terenkripsi X25519 +
  AES-GCM, opsi `--with-key`/`--no-browser`), `init` (konfigurasi MCP untuk Claude Code, Cursor,
  OpenCode + blok `AGENTS.md`), `verify`, `sync` (`--dry-run`/`--fix`), `remove`, perintah
  epic/task/persona, dan fallback tanpa MCP: `next`, `claim`, `done`, `block`.
- **Server MCP (stdio)**: konteks proyek dan handoff hulu, ambil/klaim/selesaikan task, rencana
  epic → task, persona, `load_skill` dan `save_repo_skill` (skill repo di `.catenext/skills/`).
- **API** (Hono + Better-Auth + Drizzle, Postgres dengan RLS per workspace): proyek, epic, task
  dengan dependensi (`is_ready`, `blocked_by`), handoff, persona, API key, activity dengan nama
  agen, SSE.
- **Kuota paket Free** (1 proyek, 1 epic aktif, 25 task/bulan, 500 panggilan tulis, 5.000 baca,
  60 req/menit, retensi 14 hari) dengan 402/429 dan header peringatan ≥80%.
- **Web**: dashboard proyek, onboarding 6 langkah, 2 template epic (fitur login, CRUD API), kartu
  kuota, halaman paket, Keamanan & Akses, halaman persetujuan `/device` untuk login CLI.
- **Deploy**: Docker Compose + Caddy, skrip VPS, `.env` acak, backup terenkripsi harian, restore,
  update; runbook untuk VPS bersama di belakang nginx.
- **Rilis npm** lewat mirror publik `TenkuryuCode/catenext-cli` dengan provenance SLSA.

### Catatan
- Default API URL 0.1.0 masih `http://localhost:8787` (diperbaiki di 0.1.1).
