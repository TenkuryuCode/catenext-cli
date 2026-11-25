# Catenext CLI

Catenext membantu agen coding meneruskan tugas antar-IDE, terminal, dan perangkat. CLI dan server
MCP lokal mengambil task dari antrean proyek, mencatat lease dan handoff, lalu menunjukkan kapan
pekerjaan siap direview atau dipakai task hilir.

[Dashboard](https://catenext.mapan.digital) · [Paket npm](https://www.npmjs.com/package/catenext) ·
[Changelog](CHANGELOG.md) · [Laporkan masalah](https://github.com/TenkuryuCode/catenext-cli/issues)

## Mulai dari repo Anda

Butuh Node.js **22 atau lebih baru** dan satu proyek Catenext. Buat proyek dan epic di Dashboard,
lalu buat task atau setujui rencana yang diajukan agen. Salin ID proyek untuk langkah berikutnya.

```bash
npx -y catenext login
cd /path/ke/repo
PROJECT_ID='ganti-dengan-id-proyek'
npx -y catenext init --project "$PROJECT_ID" --dry-run
npx -y catenext init --project "$PROJECT_ID"
npx -y catenext next
```

`login` meminta persetujuan lewat browser. Gunakan `--no-browser` untuk melihat tautan di terminal,
atau `--with-key` untuk memakai API key dari **Keamanan & Akses**. Untuk server sendiri,
tambahkan `--api-url` saat login, atau pakai `CATENEXT_API_URL`.

`init` memasang MCP untuk Claude Code dan Cursor, mencatat identitas repo di `.catenext/config.yaml`,
dan menambahkan petunjuk ke `AGENTS.md`. Mulai ulang klien setelah setup. Untuk klien MCP stdio
lain, arahkan server ke perintah `npx -y catenext mcp` dengan folder kerja di root repo, atau
berikan `--root` saat klien memakai folder kerja lain. Gunakan `--repo` untuk menetapkan nama repo
yang sama pada perangkat dan checkout berbeda.

Jika lebih sering memakai terminal, instal dengan `npm install -g catenext`. Contoh di bawah
memakai perintah `catenext`, yang juga bisa dijalankan dengan awalan `npx -y`.
Perintah review, worktree, dan skill berbasis SHA memakai CLI **0.2.0 atau lebih baru**.
Cek versi aktif dengan `catenext --version`.

## Ambil dan serahkan task

```bash
catenext next
TASK_ID='ganti-dengan-id-task'
catenext claim "$TASK_ID"
# Kerjakan task, jalankan tes, lalu commit.
catenext done "$TASK_ID" --notes "Endpoint siap dipakai UI." --verify "pnpm test"
```

Gunakan `next --as bambang` dan `claim "$TASK_ID" --as bambang` untuk mengambil task sesuai
persona yang sudah dibuat di proyek. Jika pekerjaan buntu, laporkan dengan
`catenext block "$TASK_ID" --category missing_env --reason "Konfigurasi SMTP_HOST belum tersedia."`.

## Kerja paralel dan review PR

Dari worktree dengan branch kerja sendiri, klaim task memakai `--worktree`. Salin ID lease dari
hasil claim, lalu sertakan saat menyerahkan task, melaporkan blocker, atau melepasnya.
`catenext next --lease "$LEASE_ID"` memperpanjang lease aktif.

```bash
TASK_ID='ganti-dengan-id-task-untuk-pr'
catenext claim "$TASK_ID" --worktree
LEASE_ID='ganti-dengan-id-lease-worktree'
PR_URL='https://github.com/owner/repo/pull/42'
# Setelah commit didorong dan PR dibuat.
catenext done "$TASK_ID" --lease "$LEASE_ID" --notes "Kontrak API siap direview." \
  --verify "pnpm test" --pr "$PR_URL" --base main
```

Handoff dengan PR masuk `NEEDS_REVIEW`. Reviewer agen memakai API key berbeda dari implementer.
Manusia juga bisa review melalui tab **Pull request** di Dashboard. Jika pindah perangkat,
isi `TASK_ID` dari hasil `review list`.

```bash
catenext review list
catenext review claim "$TASK_ID"
REVIEW_LEASE='ganti-dengan-lease-review'
HEAD_SHA='ganti-dengan-sha-lengkap-dari-claim'
catenext review submit "$TASK_ID" --lease "$REVIEW_LEASE" --sha "$HEAD_SHA" \
  --decision approve --feedback "Kontrak API dan hasil tes sudah diperiksa."
# Sesudah PR di-merge di GitHub.
catenext review refresh "$TASK_ID"
```

Gunakan `--decision request_changes` untuk meminta revisi. Commit baru perlu review baru.
Task hilir terbuka setelah persetujuan yang diwajibkan terpenuhi dan merge GitHub terverifikasi.
PR privat memerlukan akses baca dari server Catenext ke repo GitHub tersebut.

## Skill, konfigurasi, dan MCP

- Bagikan skill melalui Git di `.catenext/skills/`. Gunakan `catenext skill load nama-skill` untuk
  membaca versi checkout atau tambahkan `--revision "$HEAD_SHA"` untuk membaca versi commit PR.
- `catenext sync` memperbarui konfigurasi yang dikelola CLI dan membuat file subagent Claude Code
  dari persona proyek. Indeks skill bersama diperbarui dari checkout default branch `origin` yang
  sejajar dengan ref remote. Gunakan `sync --dry-run` untuk meninjau perubahan atau `sync --fix`
  untuk memperbaiki entri MCP yang basi atau duplikat.
- `catenext remove --dry-run` menampilkan perubahan sebelum `remove` membersihkan setup repo.
  Opsi `--all` ikut menghapus skill repo. Kredensial login tetap disimpan di luar repo.
- `catenext epic`, `task create`, dan `persona` tersedia untuk merencanakan dari terminal.
  Rencana agen masuk sebagai draft untuk ditinjau di Dashboard.

Tool MCP utama untuk eksekusi adalah `get_project_context`, `get_ready_tasks`, `claim_task`,
`complete_handoff`, `report_blocker`, dan `release_task`. Gunakan `review_pull_request` untuk
siklus review, serta `load_skill` dan `save_repo_skill` untuk skill. Jalankan `catenext --help`
atau `catenext review --help` untuk opsi terminal.

## Data yang dibagikan

Kode sumber dan isi skill tetap di Git atau di perangkat. Catenext Cloud menerima metadata task,
indeks skill, dan ringkasan handoff. CLI menyensor pola kredensial yang dikenal sebelum mengirim
teks handoff. Simpan API key secara lokal di `~/.catenext/credentials.json`.

## Build dari source

Repo ini adalah mirror publik CLI. Rilis npm dibangun dari mirror ini dengan
[npm provenance](https://docs.npmjs.com/generating-provenance-statements). Direktori `src/`
berisi CLI dan server MCP. `shared/src/` berisi skema dan kontrak yang dipakai saat build.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node dist/index.js --help
```

## Lisensi

[MIT](LICENSE)
