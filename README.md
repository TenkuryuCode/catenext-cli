# catenext

CLI & server MCP lokal untuk **Catenext**: estafet task dan konteks antar-agen AI coding
(Claude Code, Cursor, Codex, OpenCode, ...) tanpa kehilangan konteks.

- **Zero Source-Code Upload**: Cloud hanya menerima metadata dan ringkasan handoff pendek. Kode
  tetap di repo Anda.
- **Secret-scrubber lokal**: handoff, rencana, dan skill disensor di mesin Anda sebelum dikirim.
- **Setup bersih**: `init --dry-run` menampilkan diff dulu, `remove` membersihkan semuanya.
- Repo ini adalah mirror publik CLI. Setiap rilis npm dibuat oleh GitHub Actions di repo ini
  dengan [npm provenance](https://docs.npmjs.com/generating-provenance-statements), jadi Anda bisa
  memverifikasi bahwa paket dibangun dari source yang terlihat di sini.

## Mulai

```bash
npm install -g catenext          # atau: npx catenext <perintah>
catenext login                   # tempel API key dari Dashboard > Keamanan & Akses
cd ~/code/backend
catenext init --project <project_id> --dry-run   # lihat perubahan dulu
catenext init --project <project_id>
```

`init` menulis `.catenext/config.yaml`, satu entri MCP `"catenext"` untuk Claude Code (`.mcp.json`)
dan Cursor (`.cursor/mcp.json`), satu baris `.gitignore`, dan blok petunjuk di `AGENTS.md`.
Mulai ulang IDE, lalu minta agen: "ambil task Catenext berikutnya".

## Perintah

| Perintah | Fungsi |
| --- | --- |
| `catenext login` | Simpan API key di `~/.catenext/credentials.json` (izin 0600) |
| `catenext init [--dry-run]` | Pasang Catenext di repo ini |
| `catenext sync [--fix] [--dry-run]` | Selaraskan entri MCP & indeks skill; `--fix` memperbaiki entri basi/duplikat |
| `catenext remove [--all]` | Hapus semua jejak Catenext dari repo ini |
| `catenext next` / `claim` / `done` / `block` | Fallback untuk agen tanpa MCP |
| `catenext epic` / `task` / `persona` | Merencanakan dari terminal |
| `catenext mcp` | Server MCP stdio (dijalankan otomatis oleh IDE) |

Tool MCP: `get_project_context`, `get_ready_tasks`, `claim_task`, `complete_handoff`,
`report_blocker`, `create_tasks`, `list_epics`, `create_epic`, `list_personas`, `upsert_persona`,
`load_skill`, `save_repo_skill`.

## Lisensi

MIT
