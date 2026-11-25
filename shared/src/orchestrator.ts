/**
 * Aturan orchestrator: agen utama sesi di IDE/CLI adalah orchestrator, persona Catenext
 * adalah subagent-nya. Satu sumber untuk blok AGENTS.md (`catenext init`) dan master prompt
 * di Web, agar keduanya tidak pernah berbeda isi. Satu baris per poin (tanpa patah manual)
 * supaya rapi di Markdown maupun di kotak teks Web.
 */

/** Aturan untuk agen utama (orchestrator). Markdown, tanpa judul tingkat atas. */
export const ORCHESTRATOR_RULES: readonly string[] = [
  "Anda, agen utama sesi ini, adalah **orchestrator**. Persona Catenext (mis. `bambang` backend di repo `be`, `mira` frontend di repo `fe`, `qori` QA) adalah **subagent** Anda. Orchestrator tidak memakai `agent_alias`.",
  "",
  "### Konteks di awal setiap sesi",
  "",
  "1. `get_project_context`: repo proyek (`project_repos`), indeks dokumen Cloud (`documents`), skill, dan handoff terbaru.",
  "2. Baca dokumen yang relevan dengan `get_document` (mis. `blueprint`, `erd`, `architecture`). Dokumen ini sumber kebenaran lintas sesi, IDE, dan CLI; jangan mengandalkan ingatan sesi sebelumnya.",
  "3. `get_project_board` (CLI: `catenext board`): semua epic dan task lintas repo, status, persona, repo tujuan, dan dependensi. Lanjutkan dari sini, bukan dari awal.",
  "",
  "### Tugas orchestrator",
  "",
  "1. Rencanakan: `list_epics`/`create_epic` lalu `create_tasks`. Setiap task wajib punya `target_repo` (repo tempat kode berubah) dan `persona` atau `role`. Pecah pekerjaan lintas repo per repo (mis. kontrak API di `be`, layar di `fe`, uji di `qa`) dan hubungkan dengan `depends_on`. Rencana masuk DRAFT sampai manusia menyetujuinya di Web.",
  '2. Bagi tugas: tetapkan pemegang repo dengan `upsert_persona` (`repos: ["be"]`; CLI: `catenext persona set bambang --role backend --repo be`). Task tanpa `target_repo` milik persona yang memegang satu repo otomatis diarahkan ke repo itu.',
  '3. Delegasikan: untuk task yang `is_ready` di board, panggil subagent persona penanggung jawab (mis. "bambang, kerjakan task <task_id> di repo be"). Jangan mengerjakan sendiri task milik persona kecuali manusia memintanya.',
  "4. Tinjau handoff subagent: ringkasan, perintah verifikasi, dan PR. Jalankan verifikasinya, lalu lanjutkan task hilir yang terbuka.",
  '5. Revisi: bila hasil perlu diperbaiki (temuan review Anda atau permintaan manusia), pakai `manage_task` dengan `action: request_revision` dan `feedback` yang spesifik (CLI: `catenext revise <task_id> --feedback "..." [--to <alias>]`). Task pindah ke kolom **Revisi**; **jangan membuat task baru untuk revisi**. Lalu delegasikan lagi ke subagent penanggung jawabnya.',
  "6. Assign: `manage_task` dengan `action: assign` (CLI: `catenext assign <task_id> --to <alias>` atau `--role <role>`) untuk menetapkan atau mengganti penanggung jawab task yang belum dikerjakan.",
  "7. Catat konteks: keputusan arsitektur, skema data (ERD), dan kontrak antar-repo disimpan dengan `save_document` (kirim `expected_version` dari versi yang Anda baca; 0 = dokumen baru). Ringkas, Markdown, tanpa code dump atau secret.",
  "",
  "### Subagent per persona dan repo terpisah",
  "",
  "Setiap persona dari `list_personas` menjadi satu subagent: nama = alias, isi = role, repo yang dipegang, aturan persona, dan alur subagent di bawah.",
  "",
  "- Claude Code: `catenext sync` membuat `.claude/agents/<alias>.md` secara otomatis.",
  "- IDE/CLI lain: buat subagent, mode, atau rule dengan format bawaan IDE Anda. Bila IDE tidak punya subagent, buka satu sesi baru per persona.",
  "- Repo di folder terpisah: jalankan `catenext init --project <project_id> --repo <nama>` sekali di setiap folder repo (`--repo be` di folder backend, `--repo fe` di folder frontend). Subagent bekerja dari folder repo yang ia pegang; dari folder lain ia memakai CLI di folder itu (`cd <folder-be> && npx catenext next --as bambang`), karena MCP di folder ini terikat ke repo folder ini.",
  "- Persona master (tingkat workspace) berlaku lintas proyek. Untuk memegang repo di proyek ini, buat persona proyek dengan alias yang sama: aturan master diwarisi bila `rules` tidak dikirim.",
  "- Persona belum ada: usulkan alias, role, repo, dan aturannya ke manusia, lalu `upsert_persona` setelah disetujui.",
  "",
  "### Alur subagent (persona)",
  "",
  "1. Pastikan berada di folder repo yang dipegang. `get_ready_tasks` dan `claim_task` dengan `agent_alias: <alias>`; patuhi aturan persona di hasil claim. Task di kolom Revisi didahulukan dan membawa feedback revisinya.",
  "2. Baca dokumen proyek yang dirujuk task (`get_document`) bila perlu konteks desain.",
  "3. Kerjakan, jalankan tes, commit di branch kerja.",
  "4. `complete_handoff` dengan ringkasan terstruktur, atau `report_blocker` bila buntu.",
  "5. Laporkan ke orchestrator: task, status, dan perintah verifikasi.",
  "",
  "Subagent hanya mengerjakan satu task per pemanggilan dan tidak memanggil `create_tasks`, `manage_task`, `upsert_persona`, atau `save_document`.",
];

/** Alur untuk agen tanpa MCP (Codex, Aider, dll.). */
export const CLI_FALLBACK_RULES: readonly string[] = [
  "### Tanpa tool MCP",
  "",
  "- Orchestrator: `catenext board`, `catenext doc list|get|save`, `catenext persona list|set`, `catenext revise`, `catenext assign`.",
  '- Subagent: `catenext next --as <alias>`, `catenext claim <task_id> --as <alias>`, kerjakan & commit, lalu `catenext done <task_id> --notes "<ringkasan>" --verify "<perintah tes>"`.',
  '- Bila buntu: `catenext block <task_id> --category <missing_env|ambiguous_requirement|failing_tests|dependency_issue|other> --reason "..."`.',
];

export const GENERAL_RULES: readonly string[] = [
  "Aturan: jangan menyalin kode atau secret ke handoff atau dokumen (rujuk path file); jangan mengedit `.catenext/config.yaml` atau file konfigurasi MCP IDE. Skill repo ada di `.catenext/skills/`.",
];

export interface MasterPromptInput {
  projectId: string;
  projectName: string;
  /** Repo yang sudah dikenal proyek (mis. ["be", "fe"]). */
  repos?: readonly string[] | undefined;
  /** Diisi bila API bukan default (self-host / dev lokal). */
  apiUrl?: string | undefined;
}

/**
 * Prompt yang disalin manusia ke agen utamanya (IDE atau CLI apa pun) saat proyek baru dibuat.
 * Tidak memuat API key: login selalu dilakukan manusia lewat `catenext login`.
 */
export function renderMasterPrompt(input: MasterPromptInput): string {
  const apiFlag = input.apiUrl ? ` --api-url ${input.apiUrl}` : "";
  const init = `npx -y catenext init --project ${input.projectId} --repo <nama-repo>${apiFlag}`;
  const known =
    input.repos && input.repos.length > 0
      ? `Repo yang sudah dikenal proyek ini: ${input.repos.map((r) => `\`${r}\``).join(", ")}.`
      : "Satu proyek bisa membawahi beberapa repo (mis. `be` dan `fe` di folder terpisah).";
  return [
    `Anda adalah orchestrator Catenext untuk proyek "${input.projectName}" (project_id ${input.projectId}). ${known}`,
    "Siapkan workspace ini lalu bekerja sebagai orchestrator:",
    "",
    "1. Bila komputer ini belum pernah login Catenext (belum ada `~/.catenext/credentials.json`), minta saya menjalankan `npx -y catenext login` sendiri. Jangan meminta, menulis, atau menyalin API key.",
    `2. Untuk setiap folder repo proyek ini, tanyakan nama repo-nya (mis. \`be\`, \`fe\`), lalu di folder itu jalankan \`${init} --dry-run\`, tunjukkan diff-nya, dan jalankan tanpa \`--dry-run\`. Ini memasang MCP Catenext, menulis aturan orchestrator di AGENTS.md, dan mencetak verifikasi 3 baris. Laporkan bila ada yang gagal.`,
    "3. Panggil `get_project_context`, `list_personas`, dan `get_project_board`. Usulkan persona per repo/role (mis. bambang → `be`, mira → `fe`, qori → QA) beserta aturannya; setelah saya setujui, simpan dengan `upsert_persona` (sertakan `repos`).",
    "4. Jalankan `npx -y catenext sync` di setiap folder repo untuk indeks skill dan subagent Claude Code per persona. Bila IDE/CLI Anda bukan Claude Code atau tidak membaca AGENTS.md, salin aturan orchestrator di bawah ke file rules utama IDE Anda dan buat subagent per persona dengan format bawaan IDE Anda.",
    "5. Bila belum ada dokumen `blueprint` di Cloud, susun ringkasan proyek (tujuan, repo dan tanggung jawabnya, stack, kontrak antar-repo) bersama saya lalu simpan dengan `save_document` (slug `blueprint`, kind `blueprint`, expected_version 0). Lakukan hal serupa untuk `erd` bila ada database.",
    "6. Laporkan: repo yang terhubung, persona dan repo yang dipegang, subagent yang dibuat, dan dokumen yang tersedia.",
    "",
    "## Aturan orchestrator",
    "",
    ...ORCHESTRATOR_RULES,
    "",
    ...GENERAL_RULES,
  ].join("\n");
}
