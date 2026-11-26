# Catenext CLI

Satu antrean lokal untuk agen AI coding Anda. Catenext mengunci task agar dua agen tidak
mengerjakan hal yang sama, meneruskan handoff ke agen berikutnya, dan membuka task baru hanya
setelah dependensinya selesai. Semua state ada di komputer Anda (SQLite) — tanpa akun Cloud,
tanpa login, tanpa dashboard.

Paket ini berisi CLI `catenext` dan server MCP stdio untuk Claude Code, Cursor, Codex,
Antigravity, OpenCode, dan agen lain.

[npm](https://www.npmjs.com/package/catenext) ·
[Changelog](CHANGELOG.md) ·
[Laporkan masalah](https://github.com/TenkuryuCode/catenext-cli/issues)

## Mulai dalam 10 menit

Butuh Node.js **22.12** atau lebih baru.

```bash
npm install -g catenext
cd ~/code/proyek-anda
catenext init --platform cursor --dry-run   # lihat perubahan dulu
catenext init --platform cursor             # interview singkat (atau --yes untuk default)
catenext verify --platform cursor
```

Mulai ulang IDE/CLI, lalu percayai server MCP `catenext` jika diminta.
`catenext mcp` adalah proses stdio yang diluncurkan klien — bukan server HTTP.

| Klien | `--platform` | Konfigurasi |
| --- | --- | --- |
| Claude Code | `claude-code` | `.mcp.json` + `CLAUDE.md` |
| Cursor | `cursor` | `.cursor/mcp.json` + `.cursor/CATENEXT.md` |
| Codex | `codex` | `.codex/config.toml` + `.codex/CATENEXT.md` |
| Antigravity | `antigravity` | `.agents/mcp_config.json` + `.agents/CATENEXT.md` |
| OpenCode | `opencode` | sesuai setup OpenCode + `.opencode/CATENEXT.md` |

`init` menulis `.catenext/config.yaml`, entri MCP, `.gitignore`, **`CATENEXT.md`** (master
prompt), pointer platform, blok di `AGENTS.md`, dan seed persona default
(`be`, `fe`, `tester`, `android`, `security`, `reviewer`, `scribe`).
`catenext remove` membersihkan setup (bukan file state SQLite, kecuali Anda hapus sendiri).

```bash
catenext sync --platform cursor --dry-run
catenext sync --platform cursor --force
```

## Sesi baru: baca master prompt dulu

Setiap sesi baru mulai dari **`CATENEXT.md`** (master prompt). Pointer platform
(`CLAUDE.md`, `.cursor/CATENEXT.md`, …) hanya mengarahkan ke file itu, lalu ke `AGENTS.md`
untuk aturan orchestrator lengkap.

Alur singkat:

1. Orchestrator (agen utama, tanpa `agent_alias`) membaca `CATENEXT.md` → `AGENTS.md`.
2. Panggil `catenext brief` / MCP `session_brief` (hemat token).
3. Jika ada `pending_approvals`, tawarkan manusia: **approve** · **revise** · **next**.
4. Baru rencanakan task / delegasikan ke persona.

Bahasa tanya-jawab mengikuti bahasa manusia. Stub agen dan nama tool tetap bahasa Inggris.

## Orchestrator dan persona

- **Orchestrator** memecah tujuan, menyusun DRAFT, mendelegasikan, meninjau worktree, dan
  bertanya ke manusia sebelum merge/PR.
- **Persona** adalah subagent (alias + role + repo). Default setelah `init`: `be`, `fe`,
  `tester`, `android`, `security`, `reviewer`, `scribe`.

```bash
catenext persona list
catenext persona set bambang --role backend --repo api
catenext brief
catenext board
```

## Rencana, claim, handoff

```bash
catenext epic create "Tambah ekspor billing"
catenext task create --epic <epic_id> --file tasks.json
catenext task approve <task_id>          # manusia: DRAFT → TODO
catenext next --as bambang
catenext claim <task_id> --as bambang --worktree
# kerjakan di worktree itu, tes, commit
catenext done <task_id> --lease <lease_id> --notes "Exporter siap" \
  --verify "pnpm test"
catenext review approve <task_id>        # manusia: NEEDS_REVIEW → DONE
```

`tasks.json` boleh array; task dalam batch bisa saling merujuk lewat `ref`:

```json
[
  { "ref": "export", "title": "CSV export", "prompt_instruction": "Tulis exporter + unit test." },
  { "ref": "docs", "title": "Dokumentasi CSV", "prompt_instruction": "Contoh + urutan kolom.", "depends_on": ["export"] }
]
```

Persetujuan rencana dan handoff hanya lewat CLI manusia (`task approve` / `review approve`).
Jalur MCP agen untuk approve ditolak. Catatan verifikasi disimpan sebagai catatan, bukan dijalankan
oleh Catenext.

Buntu? `catenext block <task_id> --category missing_env --reason "SMTP_HOST belum diisi."`
Lepas tanpa blocker: `catenext release <task_id> --lease <lease_id>`.

## Kerja paralel (worktree)

Persona yang jalan bersamaan **wajib** worktree/branch terpisah. Orchestrator memantau semua
worktree, mengintegrasikan bila perlu, lalu bertanya: **PR** · **merge ke main** · **revise** ·
**next**. Subagent tidak boleh merge `main` sendiri.

```bash
catenext claim <task_id> --as bambang --worktree
catenext done <task_id> --lease <lease_id> --notes "…" --verify "pnpm test" \
  --pr https://github.com/owner/repo/pull/42 --base main
```

URL PR opsional — hanya referensi lokal; review lokal tidak membuktikan merge remote.

## Revisi tanpa task baru

```bash
catenext revise <task_id> --feedback "Validasi email belum menolak spasi."
catenext revise <task_id> --feedback "Perlu tes E2E." --to mira
catenext assign <task_id> --to mira
```

## Banyak repo / monorepo

```bash
# polyrepo: init di tiap checkout dengan --repo berbeda
cd ~/code/api && catenext init --platform cursor --repo api
cd ~/code/web && catenext init --platform cursor --repo web

# monorepo: satu state SQLite; atur layout=monorepo di .catenext/config.yaml
# claim paralel wajib --worktree
```

Untuk state bersama lintas checkout di satu mesin, arahkan `state_file` di
`.catenext/config.yaml` ke file SQLite yang sama (path relatif ke root repo). Pakai filesystem
lokal, bukan network mount / folder sync.

## Dokumen dan skill

Dokumen proyek (blueprint, ERD, kontrak, keputusan) disimpan **lokal** di state SQLite.

```bash
catenext doc list
catenext doc get blueprint
catenext doc save erd --kind erd --file erd.md --version 0
catenext skill load cross-agent-sync
```

`--version` = versi yang terakhir Anda baca (`0` untuk baru). Konflik versi menolak timpa buta.
Rapikan dokumen lewat persona `scribe` + skill `docs-hygiene`. Kickoff lintas persona: skill
`cross-agent-sync` → dokumen `sync-board`.

## Indeks kode lokal

```bash
catenext index
catenext search "login handler" --code
```

MCP: `graph_neighbors`, `symbol_search` (hasil ringkas).

## Data lokal

| Path | Isi |
| --- | --- |
| `.catenext/config.yaml` | Proyek, repo, layout, `state_file` |
| `.catenext/catenext.sqlite` | Antrean task, handoff, persona, dokumen, graf kode |
| `.catenext/skills/` | Skill Markdown repo |
| `.catenext/cache/` | Cache pencarian yang bisa dibangun ulang |
| `CATENEXT.md` | Master prompt sesi baru |
| `AGENTS.md` | Aturan orchestrator (blok Catenext) |

State lama `state.json` dimigrasi sekali ke SQLite (backup `*.bak`). Jangan commit state/cache.
Backup SQLite terpisah jika perlu. Data Cloud lama **tidak** dimigrasi otomatis.

## Daftar perintah

| CLI | Tool MCP | Fungsi |
| --- | --- | --- |
| `init` / `sync` / `verify` / `remove` | - | Setup MCP + stub agen (`--platform`, `--dry-run`) |
| `brief` | `session_brief` | Ringkasan sesi + pending approval |
| `board` | `get_project_board` | Papan lintas repo |
| `root list\|add\|remove` | `manage_roots` | Workspace root milik persona |
| `next` / `claim` / `done` | `get_ready_tasks` / `claim_task` / `complete_handoff` | Ambil & serahkan task |
| `block` / `release` | `report_blocker` / `release_task` | Blokir / lepas lease |
| `task approve` / `review approve` | - (manusia) | Setujui rencana / handoff |
| `revise` / `assign` | `manage_task` | Revisi / ganti penanggung jawab |
| `persona list\|set` | `list_personas` / `upsert_persona` | Persona proyek |
| `doc …` | `get_document` / `save_document` | Dokumen lokal |
| `epic` / `task create` | `list_epics` / `create_epic` / `create_tasks` | Rencana (masuk DRAFT) |
| `review …` | `review_pull_request` | Antrean review lokal |
| `skill load` | `load_skill` / `save_repo_skill` | Skill repo |
| `index` / `search` | `graph_neighbors` / `symbol_search` / `search_context` | Graf & pencarian lokal |
| `mcp` | - | Server MCP stdio |
| - | `interview_setup` | Kartu opsi setup untuk interview |

Semua perintah CLI menerima `--json`. `catenext --help` untuk opsi lengkap.

## Kalau macet

| Gejala | Yang perlu dilakukan |
| --- | --- |
| Task tidak muncul di `next` | Pastikan `task approve` sudah jalan, dependensi `DONE`, folder/`--as` cocok |
| `repo_busy` / bentrok paralel | Selesaikan atau `release`; untuk paralel wajib `--worktree` |
| `persona_repo_mismatch` | Pindah ke folder/`--repo` yang dipegang persona |
| `document_version_conflict` | Baca ulang, gabungkan, simpan dengan versi terbaru |
| Approve ditolak dari MCP | Setujui lewat CLI: `task approve` / `review approve` |
| Tool MCP tidak terbaca | Mulai ulang IDE, lalu `catenext sync --platform … --force` |
| State lama JSON | Jalankan perintah apa pun yang membuka store — migrasi sekali ke SQLite |

## Build dari source

Repo ini adalah mirror publik CLI. Rilis npm dibangun dari sini dengan
[npm provenance](https://docs.npmjs.com/generating-provenance-statements).
`src/` = CLI + MCP; `shared/src/` = skema yang ikut di-bundle.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node dist/index.js --help
```

## Lisensi

[MIT](LICENSE)
