<p align="center">
  <img src="docs/assets/catenext-wordmark.svg" alt="Catenext" width="320" />
</p>

<h1 align="center">Catenext CLI</h1>

<p align="center">
  Antrean lokal untuk agen AI coding — claim, handoff, task berikutnya. Tanpa Cloud.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/catenext"><img alt="npm" src="https://img.shields.io/npm/v/catenext?color=0D9488" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/catenext?color=0F766E" /></a>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/node/v/catenext?color=0D9488" /></a>
</p>

Catenext mengunci task agar dua agen tidak bentrok, meneruskan handoff ke agen berikutnya,
dan membuka task baru hanya setelah dependensinya selesai. Semua state ada di komputer Anda
(SQLite) — tanpa akun, tanpa login, tanpa dashboard.

Paket ini berisi CLI `catenext` dan server MCP stdio untuk Claude Code, Cursor, Codex,
Antigravity, OpenCode, dan agen lain.

[npm](https://www.npmjs.com/package/catenext) ·
[Changelog](CHANGELOG.md) ·
[Laporkan masalah](https://github.com/TenkuryuCode/catenext-cli/issues)

<p align="center">
  <img src="docs/assets/catenext-agent-flow.jpg" alt="Alur Catenext: manusia, orchestrator, persona di worktree terpisah, SQLite lokal" width="720" />
</p>

<p align="center"><em>Manusia → orchestrator → persona (bisa ditambah) di worktree sendiri → SQLite lokal.</em></p>

## Mulai cepat

Butuh Node.js **22.12+**.

```bash
npm install -g catenext
cd ~/code/proyek-anda
catenext init --platform cursor          # tip: tambah --dry-run dulu, atau --yes untuk default
catenext verify --platform cursor
```

Restart IDE/CLI, lalu percayai server MCP `catenext` jika diminta.
`catenext mcp` adalah proses **stdio** (bukan HTTP).

| Klien | `--platform` | Konfigurasi |
| --- | --- | --- |
| Claude Code | `claude-code` | `.mcp.json` + `CLAUDE.md` |
| Cursor | `cursor` | `.cursor/mcp.json` + `.cursor/CATENEXT.md` |
| Codex | `codex` | `.codex/config.toml` + `.codex/CATENEXT.md` |
| Antigravity | `antigravity` | `.agents/mcp_config.json` + `.agents/CATENEXT.md` |
| OpenCode | `opencode` | setup OpenCode + `.opencode/CATENEXT.md` |

`init` menulis config, entri MCP, `.gitignore`, **`CATENEXT.md`**, pointer platform, blok
`AGENTS.md`, dan seed persona **yang cocok** dengan stack/repo. Tambah role lain kapan saja:
`catenext persona set <alias> --role <role>` lalu `catenext sync`.
`catenext remove` membersihkan setup (file SQLite tetap, kecuali Anda hapus sendiri).

## Memperbarui Catenext

**1. Paket CLI**

```bash
catenext --version
npm install -g catenext@latest
```

**2. Setup di setiap repo** (setelah CLI baru)

```bash
catenext sync --platform cursor --force
catenext verify --platform cursor
```

Lalu **restart IDE**. Lihat [CHANGELOG.md](CHANGELOG.md).

| Ikut `sync` | Tidak disentuh |
| --- | --- |
| MCP, pointer, `AGENTS.md`/`CATENEXT.md` (bertanda Catenext), stub persona, skill bawaan baru | SQLite (task/docs), skill yang sudah Anda edit |

Tips: setelah 0.10/0.11 cek worktree, doctor, template, dan watch di changelog.
Jangan commit `.catenext/catenext.sqlite` atau cache.

## Master prompt (salin ke chat)

**Untuk Anda (manusia):**

1. Tempel blok di bawah sebagai **pesan pertama** di chat agen (repo kosong atau sudah ada kode).
2. Izinkan agen menjalankan `init` / install bila diminta.
3. Setelah `verify`, **restart IDE** dan percayai MCP `catenext`.
4. Bila agen meminta approval, balas `1` / `2` / `3` (approve · revise · next).

Setelah `init`, file root **`CATENEXT.md`** berisi pointer boot yang sama arahnya.
Pointer platform (`CLAUDE.md`, `.cursor/CATENEXT.md`, …) mengarah ke situ, lalu ke `AGENTS.md`.

````markdown
# Catenext · Master Prompt

You are starting a **new Catenext session** in this repo. Follow this file first, then open **[AGENTS.md](./AGENTS.md)** for full orchestrator rules.

## Who you are

- You are the **orchestrator** (main agent). Do **not** use `agent_alias`.
- Persona subagents (`be`, `fe`, `tester`, `android`, `security`, `reviewer`, `scribe`, or custom via `persona set`) do the implementation work.
- Ask the human first; mirror **their language**. Agent stubs and tool names stay English.

## Bootstrap (install if missing)

If `.catenext/config.yaml` is missing, or `catenext` / MCP is not usable yet, **set up first** — do not invent a cloud login.

1. Require **Node.js ≥ 22.12**. If missing, tell the human how to install it.
2. Install CLI: `npm install -g catenext` (or `npx -y catenext …` for one-off).
3. Ask which `--platform`: `cursor` · `claude-code` · `codex` · `antigravity` · `opencode` · `vscode`
4. Dry-run, wait for OK, then apply: `catenext init --platform <id> --dry-run` → `catenext init --platform <id>` (or `--yes`)
5. `catenext verify --platform <id>` — ask the human to **restart the IDE/CLI** and trust MCP `catenext`.
6. Continue with **First 60 seconds** below.

## First 60 seconds

1. Read **AGENTS.md** and note stack from `.catenext/config.yaml`.
2. Call `session_brief` (`catenext brief`) — compact only.
3. If `pending_approvals` exist, present **1 approve · 2 revise · 3 next** before coding.
4. Kickoff brainstorm → `sync-board`, then DRAFT tasks; wait for human plan approval before parallel work.

## How work flows

```text
human goal
  → orchestrator clarifies (user language)
  → kickoff brainstorm → sync-board
  → DRAFT tasks (persona + depends_on)
  → human: task approve
  → parallel subagents, each in own worktree/branch
  → handoff → NEEDS_REVIEW
  → orchestrator integrates if needed
  → human: PR | merge | revise | next
```

## Parallel worktrees

- Concurrent personas **must** use different git worktrees.
- Subagents never merge `main`. After handoffs ask: **PR**, **merge**, **revise**, or **next**.

## Missing tools / access

Stop guessing. Ask the human (their language). Wait for OK / paste / enable-tool.
Never copy pasted secrets into docs, handoffs, commits, or PRs.

```text
ACCESS NEEDED
need: <research | fetch | browser | login | other>
why: <one line>
Options: 1) allow / enable tool  2) paste the info yourself  3) skip this path  4) other
```

## Human approval template

```text
APPROVAL NEEDED
task: <id> · <title> · status=<DRAFT|NEEDS_REVIEW>
worktree/branch: <if any>
summary: <one line>
verify: <command if any>
Options: 1) approve  2) revise <feedback>  3) next
```

## Commands (cheat sheet)

| Need | Command |
| --- | --- |
| Install / upgrade | `npm install -g catenext@latest` then `catenext sync --force` + restart IDE |
| Setup | `catenext init --platform <id>` (`--dry-run` / `--yes`) |
| Verify | `catenext verify --platform <id>` |
| Session / board | `catenext brief` · `catenext board` · `catenext watch --once` |
| Persona | `catenext persona set <alias> --role <role>` then `catenext sync` |
| Claim (parallel) | `catenext claim <id> --as <alias> --worktree` (or `--create-worktree`) |
| Worktrees | `catenext worktree list` · `catenext worktree prune` |
| Template bundle | `catenext template export` · `catenext template import <file>` |
| Doctor | `catenext doctor` |
| Approve plan / handoff | `catenext task approve <id>` · `catenext review approve <id>` |
| Revise | `catenext revise <id> --feedback "…"` |

## Do / Don't

- **Do** install/init when missing; seed matched personas; add more with `persona set`.
- **Do** ask when research/fetch/browser is missing — never fake results.
- **Don't** invent cloud accounts or credentials — local SQLite only.
- **Don't** publish secrets (paths only). Don't merge `main` without explicit human choice.
- **Don't** invent test/merge results.

Full rules → [AGENTS.md](./AGENTS.md).
````

## Orchestrator dan persona

- **Orchestrator** (agen utama): pecah tujuan, DRAFT, delegasi, tinjau worktree, tanya sebelum PR/merge.
- **Persona** = subagent (alias + role + repo). Seed awal **matched** ke stack; catalog contoh:
  `be`, `fe`, `tester`, `android`, `security`, `reviewer`, `scribe` — atau buat sendiri.

```bash
catenext persona list
catenext persona set tester --role testing
catenext persona set bambang --role backend --repo api
catenext sync --platform cursor
catenext brief
catenext board
```

## Rencana, claim, handoff

```bash
catenext epic templates
catenext epic create "Tambah ekspor billing"   # atau: --template fitur-login
catenext task create --epic <epic_id> --file tasks.json
catenext task approve <task_id>          # manusia: DRAFT → TODO
catenext next --as bambang
catenext claim <task_id> --as bambang --worktree
catenext done <task_id> --lease <lease_id> --notes "Exporter siap" --verify "pnpm test"
catenext review approve <task_id>        # manusia: NEEDS_REVIEW → DONE
```

Persetujuan hanya lewat CLI manusia (`task approve` / `review approve`) — MCP agen tidak boleh approve.
Buntu: `catenext block <task_id> --category missing_env --reason "…"`.
Lepas lease: `catenext release <task_id> --lease <lease_id>`.

## Kerja paralel (worktree)

Persona paralel **wajib** worktree/branch terpisah. Orchestrator bertanya: **PR** · **merge** · **revise** · **next**.

```bash
catenext claim <task_id> --as bambang --create-worktree --branch feat/api --path ../api-lane
catenext claim <task_id> --as bambang --worktree
catenext worktree list                 # inventori Git + lease (read-only)
catenext worktree prune                # pratinjau (default)
catenext worktree prune --apply        # hapus checkout managed yang eligible; branch tetap
```

`prune` melindungi primary, aktif, kotor, dan unmanaged.

## Template lintas proyek

**Apa:** ekspor/impor personas + skill repo sebagai JSON bundle.
**Kapan:** salin setup tim ke repo lain tanpa menyalin secret.

```bash
catenext template export -o team.json
catenext template import team.json              # upsert
catenext template import team.json --dry-run
catenext template export --personas-only -o p.json
catenext template import team.json --skills-only
```

Secret di-scrub saat export/import. Jangan commit bundle yang masih berisi kredensial.

## Watch (monitor board)

**Apa:** ringkasan terminal board, lease/worktree, pending approval, dan `task_events`.
**Kapan:** pantau sesi tanpa membuka SQLite dengan writer lock.

```bash
catenext watch --once                  # satu snapshot
catenext watch --interval 2000         # polling (default 2000 ms, min 250)
catenext watch --once --epic <epic_id>
catenext watch --once --json
```

Read-only — tidak mengunci writer dan tidak mengubah state.

## Doctor dan MCP CRUD

```bash
catenext doctor            # diagnostik read-only (SQLite, MCP, registrasi Git)
catenext doctor --fix      # perbaikan aman mode/izin — tidak pernah prune
catenext mcp               # CRUD disembunyikan + ditolak
catenext mcp --allow-crud  # opt-in lokal (bukan untuk --role worker)
```

## Revisi tanpa task baru

```bash
catenext revise <task_id> --feedback "Validasi email belum menolak spasi."
catenext revise <task_id> --feedback "Perlu tes E2E." --to mira
catenext assign <task_id> --to mira
```

## Banyak repo / monorepo

```bash
# polyrepo
cd ~/code/api && catenext init --platform cursor --repo api
cd ~/code/web && catenext init --platform cursor --repo web

# monorepo: layout=monorepo di .catenext/config.yaml; claim paralel wajib --worktree
```

State bersama di satu mesin: set `state_file` ke SQLite yang sama (filesystem lokal).

## Dokumen dan skill

```bash
catenext doc list
catenext doc get blueprint
catenext doc save erd --kind erd --file erd.md --version 0
catenext skill load cross-agent-sync
```

## Indeks kode lokal

```bash
catenext index
catenext search "login handler" --code
```

## Data lokal

| Path | Isi |
| --- | --- |
| `.catenext/config.yaml` | Proyek, repo, layout, `state_file` |
| `.catenext/catenext.sqlite` | Task, handoff, persona, dokumen, graf |
| `.catenext/skills/` | Skill Markdown repo |
| `.catenext/cache/` | Cache pencarian |
| `CATENEXT.md` | Master prompt sesi baru |
| `AGENTS.md` | Aturan orchestrator |

Jangan commit state/cache. Backup SQLite sendiri bila perlu.

## Daftar perintah

| CLI | Tool MCP | Fungsi |
| --- | --- | --- |
| `init` / `sync` / `verify` / `remove` | - | Setup MCP + stub |
| `brief` | `session_brief` | Ringkasan sesi + pending approval |
| `board` | `get_project_board` | Papan lintas repo |
| `watch` | - | Monitor board/lease/approval/events (read-only) |
| `next` / `claim` / `done` | `get_ready_tasks` / `claim_task` / `complete_handoff` | Ambil & serahkan task |
| `worktree list\|prune` | - | Inventori / prune preview-first |
| `template export\|import` | - | Bundle persona + skill (scrub secret) |
| `block` / `release` | `report_blocker` / `release_task` | Blokir / lepas lease |
| `task approve` / `review approve` | - (manusia) | Setujui rencana / handoff |
| `revise` / `assign` | `manage_task` | Revisi / ganti penanggung jawab |
| `persona list\|set` | `list_personas` / `upsert_persona` | Persona proyek |
| `doc …` | `get_document` / `save_document` | Dokumen lokal |
| `epic` / `task create\|update\|cancel\|deps` | planning tools (+ CRUD opt-in) | Rencana lokal |
| `doctor` | - | Diagnostik read-only |
| `mcp` | - | Stdio MCP (`--allow-crud` opt-in) |
| `index` / `search` | code search tools | Graf & pencarian |
| `log` / `permission …` / `root …` / `skill …` | - | Audit, izin, roots, skill |

Semua perintah CLI menerima `--json`. `catenext --help` untuk opsi lengkap.

## Kalau macet

| Gejala | Yang perlu dilakukan |
| --- | --- |
| Task tidak muncul di `next` | `task approve`, dependensi `DONE`, folder/`--as` cocok |
| `repo_busy` / bentrok paralel | `release` atau wajib `--worktree` |
| Approve ditolak dari MCP | Pakai CLI: `task approve` / `review approve` |
| Tool MCP tidak terbaca | Restart IDE + `catenext sync --platform … --force` |
| Perilaku lama setelah rilis | `npm install -g catenext@latest` → `sync --force` → restart |
| `watch` kosong / filter aneh | Cek state SQLite; coba tanpa `--epic` |
| Import template menolak secret | Bundle masih berisi kredensial — scrub/export ulang |

## Build dari source

Repo ini adalah mirror publik CLI. Rilis npm memakai
[npm provenance](https://docs.npmjs.com/generating-provenance-statements).

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
node dist/index.js --help
```

## Lisensi

[MIT](LICENSE)
