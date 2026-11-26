<p align="center">
  <img src="docs/assets/catenext-wordmark.svg" alt="Catenext" width="320" />
</p>

<h1 align="center">Catenext CLI</h1>

<p align="center">
  Satu antrean lokal untuk agen AI coding — claim, handoff, dan task berikutnya tanpa Cloud.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/catenext"><img alt="npm" src="https://img.shields.io/npm/v/catenext?color=0D9488" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/catenext?color=0F766E" /></a>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/node/v/catenext?color=0D9488" /></a>
</p>

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
prompt), pointer platform, blok di `AGENTS.md`, dan seed persona **yang cocok dengan
stack/repo** (mis. hanya `fe`+`reviewer` untuk Next.js). Role lain ditambah nanti:
`catenext persona set <alias> --role <role>` lalu `catenext sync`.
`catenext remove` membersihkan setup (bukan file state SQLite, kecuali Anda hapus sendiri).

```bash
catenext sync --platform cursor --dry-run
catenext sync --platform cursor --force
```

## Master prompt (salin ke chat)

Tempel blok di bawah sebagai **pesan pertama** di chat agen (repo kosong atau sudah ada
kode). Agen akan **menginstall CLI + `init`** bila belum ada, lalu jadi orchestrator.

Setelah `init`, file **`CATENEXT.md`** di root berisi teks yang sama. Pointer platform
(`CLAUDE.md`, `.cursor/CATENEXT.md`, …) mengarahkan ke situ, lalu ke `AGENTS.md`.

````markdown
# Catenext · Master Prompt

You are starting a **new Catenext session** in this repo. Follow this file first, then open **[AGENTS.md](./AGENTS.md)** for full orchestrator rules.

## Who you are

- You are the **orchestrator** (main agent). Do **not** use `agent_alias`.
- Persona subagents (`be`, `fe`, `tester`, `android`, `security`, `reviewer`, …) do the implementation work.
- Ask the human first; mirror **their language**. Agent stubs and tool names stay English.

## Bootstrap (install if missing)

If `.catenext/config.yaml` is missing, or `catenext` / MCP is not usable yet, **set up first** — do not invent a cloud login.

1. Require **Node.js ≥ 22.12**. If missing, tell the human how to install it.
2. Install CLI: `npm install -g catenext` (or `npx -y catenext …` for one-off).
3. Detect IDE/CLI and **ask the human** which `--platform` to use (recommend what you detect):
   `cursor` · `claude-code` · `codex` · `antigravity` · `opencode` · `vscode`
4. Show a dry-run, wait for OK, then apply:
   `catenext init --platform <id> --dry-run`
   `catenext init --platform <id>` (TTY interview) or `catenext init --platform <id> --yes`
5. `catenext verify --platform <id>` — then ask the human to **restart the IDE/CLI** and trust the `catenext` MCP server.
6. Only after verify: continue with **First 60 seconds** below (read this file / `AGENTS.md`, then `catenext brief`).

## First 60 seconds

1. Read **AGENTS.md** (detailed rules) and note project stack from `.catenext/config.yaml` / context.
2. Call MCP/CLI `session_brief` (`catenext brief`) — compact only.
3. If `pending_approvals` is non-empty, **present options to the human** before coding:
   - `1` approve · `2` revise (with feedback) · `3` next
4. Only then plan or delegate. Prefer `interview_setup` when IDE/CLI setup is still undecided.
5. Before parallel coding: short cross-persona brainstorm → save `sync-board` (skill `cross-agent-sync`).

## How work flows

```text
human goal
  → orchestrator clarifies (user language)
  → kickoff brainstorm (relevant personas) → sync-board
  → DRAFT tasks (persona + depends_on)
  → human approve_plan
  → parallel subagents each in their own worktree/branch
  → mid-flight asks via orchestrator + sync-board
  → handoff → NEEDS_REVIEW
  → orchestrator reviews all worktrees, integrates if needed
  → human: PR | merge to main | revise | next
```

## Parallel worktrees

- Concurrent personas **must** use different git worktrees (unique session/branch).
- Orchestrator tracks every active worktree and does **not** let subagents merge `main`.
- After handoffs, orchestrator combines/edits only as needed, then asks: **PR**, **merge**, **revise**, or **next**.

## Docs

- Tidy pass: persona `scribe` + skill `docs-hygiene`.

## Missing tools / access

If you lack a capability the work needs (web research, fetch/HTTP, browser, private URL, login, paid API, OS permission, etc.):
1. **Stop guessing** — do not invent page contents, API responses, or “I browsed it”.
2. **Ask the human** (their language) for permission or help, with a concrete ask.
3. Wait for OK / paste / enable-tool before continuing that path.
4. If the human pastes a secret into chat, **do not** copy it into docs, handoffs, commits, PRs, or issues — use env/local files they control.

```text
ACCESS NEEDED
need: <research | fetch | browser | login | other>
why: <one line>
Options: 1) allow / enable tool  2) paste the info yourself  3) skip this path  4) other
Reply with 1 / 2 / 3 / 4.
```

## Secrets & credentials (never publish)

Never publish or persist credentials or other critical secrets anywhere durable or shared:
handoffs, docs, `sync-board`, commits, PRs, issues, chat logs meant for others, screenshots, CI logs.
Includes: API keys, tokens, passwords, private keys, cookies, `.env` values, connection strings with passwords,
OTA/signing keys, session cookies, personal data that must stay private.
Cite **paths** (e.g. `.env`, `secrets/…`) only. Prefer env vars / secret managers the human already uses.
Catenext scrubbing is best-effort — you still must not paste secrets on purpose.

## Human approval template

```text
APPROVAL NEEDED
task: <id> · <title> · status=<DRAFT|NEEDS_REVIEW>
worktree/branch: <if any>
summary: <one line>
verify: <command if any>
Options: 1) approve  2) revise <feedback>  3) next
Reply with 1 / 2 / 3 (or the same words in chat).
```

## Commands (cheat sheet)

| Need | Command |
| --- | --- |
| Install CLI | `npm install -g catenext` |
| First-time setup | `catenext init --platform <id>` (`--dry-run` / `--yes`) |
| Verify MCP | `catenext verify --platform <id>` |
| Add persona | `catenext persona set <alias> --role <role>` then `catenext sync` |
| Session snapshot | `catenext brief` |
| Board | `catenext board` |
| Claim (parallel-safe) | `catenext claim <id> --as <alias> --worktree` |
| Approve plan | `catenext task approve <id>` |
| Approve handoff | `catenext review approve <id>` |
| Revise | `catenext revise <id> --feedback "…"` |
| Sync agents | `catenext sync` |

## Do / Don't

- **Do** install/init when setup is missing; seed only personas that match this repo; add more with `persona set` when needed.
- **Do** ask the human when research/fetch/browser (or any required access) is missing — never fake the result.
- **Don't** invent cloud accounts, dashboards, or fake credentials — this CLI is local SQLite only.
- **Don't** publish credentials or critical secrets (handoffs, docs, git, PR, issues) — paths only.
- **Don't** implement persona tasks yourself unless the human explicitly asks.
- **Don't** merge to main without explicit human choice; prefer PR when unsure.
- **Don't** invent test/merge results.

Full rules → [AGENTS.md](./AGENTS.md). Persona stubs → platform `agents/` folders (English, stack-aware).
````

Alur: agen install/`init` bila perlu → restart IDE → `catenext brief` → approval jika ada →
rencana / delegasi. Bahasa tanya-jawab mengikuti manusia; stub agen tetap Inggris.

## Orchestrator dan persona

- **Orchestrator** memecah tujuan, menyusun DRAFT, mendelegasikan, meninjau worktree, dan
  bertanya ke manusia sebelum merge/PR.
- **Persona** adalah subagent (alias + role + repo). Setelah `init`, hanya yang **matched**
  ke repo (plus `reviewer`). Catalog penuh tetap tersedia: `be`, `fe`, `tester`, `android`,
  `security`, `reviewer`, `scribe`.

```bash
catenext persona list
catenext persona set tester --role testing    # tambah role yang kurang
catenext persona set bambang --role backend --repo api
catenext sync --platform cursor               # tulis stub agen untuk persona baru
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
