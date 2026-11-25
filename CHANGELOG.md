# Changelog

Semua perubahan penting Catenext dicatat di sini, satu bagian per versi rilis CLI
(`catenext` di npm). Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/)
dan versi memakai [SemVer](https://semver.org/lang/id/).

Aturan: setiap PR yang mengubah perilaku menambah baris di **Belum dirilis**. Saat rilis, bagian
itu diganti judul versi + tanggal (`## [X.Y.Z] - YYYY-MM-DD`), dan workflow *Release CLI* menolak
tag yang versinya belum ada di file ini. Perbarui juga [docs/STATUS.md](docs/STATUS.md).

## [Belum dirilis]

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
