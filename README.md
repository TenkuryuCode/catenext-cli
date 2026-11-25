# Catenext CLI

Satu antrean untuk semua agen AI coding Anda. Catenext mengunci task agar dua agen tidak mengerjakan
hal yang sama, meneruskan catatan serah terima (handoff) ke agen berikutnya, dan membuka task baru
hanya setelah dependensinya selesai. Kode sumber tetap di repo Anda.

Paket ini berisi CLI `catenext` dan server MCP lokal untuk Claude Code, Cursor, Codex, OpenCode,
dan agen lain.

[Dokumentasi](https://catenext.mapan.digital/docs) ·
[Dashboard](https://catenext.mapan.digital) ·
[npm](https://www.npmjs.com/package/catenext) ·
[Changelog](CHANGELOG.md) ·
[Laporkan masalah](https://github.com/TenkuryuCode/catenext-cli/issues)

## Mulai dalam 10 menit

Butuh Node.js **22 atau lebih baru** dan akun di [catenext.mapan.digital](https://catenext.mapan.digital/signup).

1. **Buat proyek di Dashboard.** Setelah proyek dibuat, Dashboard menampilkan *master prompt*.
2. **Login dari terminal**, sekali per komputer:

   ```bash
   npx -y catenext login
   ```

3. **Tempel master prompt ke agen utama Anda.** Agen itu menjadi *orchestrator*: menjalankan `init`
   di setiap folder repo, mengusulkan persona, membuat subagent, dan menyusun blueprint bersama Anda.
4. **Setujui rencana di Dashboard.** Task yang diajukan agen masuk DRAFT sampai Anda setujui.

Lebih suka menjalankan sendiri? Ini setara dengan langkah 3:

```bash
cd ~/code/backend
npx -y catenext init --project <project_id> --repo be --dry-run   # lihat perubahan dulu
npx -y catenext init --project <project_id> --repo be
npx -y catenext sync                                               # subagent Claude Code per persona
```

`init` hanya menulis `.catenext/config.yaml`, entri MCP di `.mcp.json` dan `.cursor/mcp.json`,
satu baris `.gitignore`, dan satu blok di `AGENTS.md`. Mulai ulang IDE setelahnya.
`catenext remove` membersihkan semuanya.

## Orchestrator dan subagent

- **Orchestrator** adalah agen utama di IDE atau CLI Anda. Aturannya ditulis `init` ke `AGENTS.md`:
  baca konteks proyek, pecah fitur menjadi task, delegasikan ke subagent, tinjau hasilnya, dan minta
  revisi bila perlu.
- **Persona** adalah subagent dengan nama, role, aturan, dan repo yang dipegang (mis. `bambang`,
  backend, repo `be`). Persona tingkat workspace berlaku sebagai master; persona proyek dengan alias
  yang sama mewarisi aturannya dan menambahkan repo.

```bash
catenext persona set bambang --role backend --repo be
catenext persona set mira --role frontend --repo fe
catenext board                      # semua task lintas repo
```

## Ambil dan serahkan task

```bash
catenext next --as bambang
catenext claim <task_id> --as bambang
# kerjakan, jalankan tes, commit
catenext done <task_id> --notes "Endpoint /login siap dipakai UI." --verify "pnpm test"
```

Buntu? `catenext block <task_id> --category missing_env --reason "SMTP_HOST belum diisi."`
Perlu berhenti tanpa blocker? `catenext release <task_id>`.

## Banyak repo dalam satu proyek

Jalankan `init` di setiap folder dengan nama repo berbeda:

```bash
cd ~/code/api && npx -y catenext init --project <project_id> --repo be
cd ~/code/web && npx -y catenext init --project <project_id> --repo fe
```

Task milik persona yang memegang satu repo otomatis diarahkan ke repo itu. Persona hanya bisa
mengambil task dari folder repo yang ia pegang, jadi subagent selalu bekerja di checkout yang benar.

## Revisi tanpa task baru

Hasil yang perlu diperbaiki kembali ke kolom **Revisi** sebagai task yang sama, lengkap dengan
feedback, branch, dan PR-nya:

```bash
catenext revise <task_id> --feedback "Validasi email belum menolak spasi."
catenext revise <task_id> --feedback "Perlu tes E2E." --to qori   # ganti penanggung jawab
catenext assign <task_id> --to mira                                # untuk task yang belum dikerjakan
```

## Dokumen proyek

Blueprint, ERD, kontrak API, dan keputusan arsitektur disimpan di Cloud agar sesi berikutnya, di
IDE atau komputer mana pun, membaca konteks yang sama.

```bash
catenext doc list
catenext doc get blueprint
catenext doc save erd --kind erd --file erd.md --expected-version 0
```

`--version` diisi versi yang terakhir Anda baca (`0` untuk dokumen baru). Bila sesi lain sudah
menyimpan lebih dulu, simpanan ditolak alih-alih menimpa.

## Kerja paralel dan review PR

Dua agen bisa bekerja di repo yang sama bila branch-nya berbeda:

```bash
catenext claim <task_id> --worktree
catenext done <task_id> --lease <lease_id> --notes "Kontrak API siap direview." \
  --verify "pnpm test" --pr https://github.com/owner/repo/pull/42 --base main
catenext review list
catenext review claim <task_id>
catenext review submit <task_id> --lease <review_lease> --sha <head_sha> \
  --decision approve --feedback "Kontrak API dan tes sudah diperiksa."
```

Task hilir terbuka setelah persetujuan terpenuhi dan merge di GitHub terverifikasi. Commit baru di
PR butuh review baru.

## Daftar perintah

| CLI | Tool MCP | Fungsi |
| --- | --- | --- |
| `login` | - | Masuk lewat browser (`--no-browser`, `--with-key`, `--api-url`) |
| `init --project ID --repo NAMA` | - | Hubungkan folder repo |
| `sync` | - | Perbarui setup, indeks skill, subagent per persona (`--dry-run`, `--fix`) |
| `board` | `get_project_board` | Papan lintas repo untuk orchestrator |
| `next` | `get_ready_tasks` | Task siap untuk repo ini |
| `claim ID` | `claim_task` | Kunci task, baca instruksi dan handoff sebelumnya |
| `done ID` | `complete_handoff` | Selesaikan dengan handoff |
| `block ID` / `release ID` | `report_blocker` / `release_task` | Laporkan buntu / lepas task |
| `revise ID` / `assign ID` | `manage_task` | Kembalikan ke Revisi / ganti penanggung jawab |
| `persona list` / `persona set` | `list_personas` / `upsert_persona` | Kelola persona proyek |
| `doc list` / `doc get` / `doc save` | `get_document` / `save_document` | Dokumen proyek di Cloud |
| `epic`, `task create` | `list_epics`, `create_epic`, `create_tasks` | Rencanakan dari terminal (masuk DRAFT) |
| `review` | `review_pull_request` | Antrean dan keputusan review PR |
| `skill load NAMA` | `load_skill`, `save_repo_skill` | Skill repo di `.catenext/skills/` |
| `remove` | - | Hapus setup Catenext dari repo |

Semua perintah menerima `--json`. Jalankan `catenext --help` untuk opsi lengkap.

## Data yang dikirim

| Disimpan di Cloud | Tetap di repo atau komputer Anda |
| --- | --- |
| Rencana, status, dan lock task | Seluruh kode sumber |
| Ringkasan handoff (path file, keputusan, perintah tes) | Isi skill repo |
| Indeks skill (nama dan kapan dipakai) | API key (`~/.catenext/credentials.json`) |
| Dokumen proyek yang Anda simpan | Konfigurasi MCP IDE |

CLI menyensor pola secret yang dikenal sebelum mengirim teks apa pun.

## Kalau ada yang macet

| Gejala | Yang perlu dilakukan |
| --- | --- |
| Task tidak muncul di `next` | Pastikan rencana sudah disetujui, dependensi sudah DONE, dan Anda di folder repo yang sesuai |
| `repo_busy` | Selesaikan (`done`) atau lepas (`release`) task yang sedang dipegang, atau pakai `--worktree` |
| `persona_repo_mismatch` | Pindah ke folder repo yang dipegang persona itu |
| `document_version_conflict` | Baca ulang dokumen, gabungkan perubahan, lalu simpan lagi |
| `quota_exceeded` | Kuota paket habis; pesan error menyebut kuota mana dan kapan direset |
| Tool MCP tidak terbaca | Mulai ulang IDE, lalu `catenext sync --fix` |

Panduan lengkap: [catenext.mapan.digital/docs](https://catenext.mapan.digital/docs).

## Build dari source

Repo ini adalah mirror publik CLI. Rilis npm dibangun dari sini dengan
[npm provenance](https://docs.npmjs.com/generating-provenance-statements). `src/` berisi CLI dan
server MCP; `shared/src/` berisi skema yang dipakai saat build.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node dist/index.js --help
```

## Lisensi

[MIT](LICENSE)
