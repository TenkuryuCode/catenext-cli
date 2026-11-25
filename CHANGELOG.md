# Changelog

Semua perubahan penting Catenext dicatat di sini, satu bagian per versi rilis CLI
(`catenext` di npm). Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/)
dan versi memakai [SemVer](https://semver.org/lang/id/).

Aturan: setiap PR yang mengubah perilaku menambah baris di **Belum dirilis**. Saat rilis, bagian
itu diganti judul versi + tanggal (`## [X.Y.Z] - YYYY-MM-DD`), dan workflow *Release CLI* menolak
tag yang versinya belum ada di file ini. Perbarui juga [docs/STATUS.md](docs/STATUS.md).

## [Belum dirilis]

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
