import type { z } from "zod";
import type { RoleSchema } from "./common.js";

/**
 * Template epic siap pakai untuk onboarding (Aha! Moment: 1 epic -> 3 task berdependensi).
 * Task dibuat sebagai DRAFT agar pengguna langsung mengalami langkah "Setujui rencana".
 */
export interface EpicTemplateTask {
  /** Referensi lokal untuk depends_on. */
  ref: string;
  title: string;
  prompt_instruction: string;
  role?: z.infer<typeof RoleSchema>;
  depends_on: string[];
}

export interface EpicTemplate {
  id: string;
  name: string;
  summary: string;
  epic: { title: string; description: string };
  tasks: EpicTemplateTask[];
}

export const EPIC_TEMPLATES: EpicTemplate[] = [
  {
    id: "fitur-login",
    name: "Fitur login",
    summary: "Backend auth, form login, lalu tes E2E. Contoh estafet backend -> UI -> QA.",
    epic: {
      title: "Fitur login email + password",
      description:
        "Pengguna bisa mendaftar, login, dan logout dengan email + password.\n\nSelesai bila: password di-hash, sesi bertahan setelah reload, pesan error jelas, dan alur utama punya tes.",
    },
    tasks: [
      {
        ref: "api",
        title: "Skema user & endpoint auth",
        role: "backend",
        depends_on: [],
        prompt_instruction:
          "Buat tabel/model user (email unik, hash password) dan endpoint daftar, login, logout, serta 'me'. Pakai library hashing standar di stack ini. Tulis tes unit untuk validasi input dan password salah. Di handoff, catat path route, bentuk respons, dan cara sesi disimpan (cookie/token).",
      },
      {
        ref: "ui",
        title: "Form login & state sesi di UI",
        role: "ui",
        depends_on: ["api"],
        prompt_instruction:
          "Baca handoff task backend untuk path & bentuk respons. Buat halaman daftar dan login, tampilkan error dari API, simpan state sesi, dan arahkan pengguna yang belum login ke halaman login. Jangan mengubah kontrak API; bila perlu perubahan, laporkan lewat report_blocker.",
      },
      {
        ref: "e2e",
        title: "Tes E2E alur login",
        role: "testing",
        depends_on: ["api", "ui"],
        prompt_instruction:
          "Tulis tes end-to-end: daftar -> logout -> login -> reload tetap login -> password salah menampilkan error. Gunakan runner tes yang sudah ada di repo bila ada. Di handoff, tulis perintah persis untuk menjalankan tes ini.",
      },
    ],
  },
  {
    id: "crud-api",
    name: "Resource CRUD + dokumentasi",
    summary: "Model & migrasi, endpoint CRUD dengan validasi, lalu dokumentasi & tes integrasi.",
    epic: {
      title: "Resource CRUD baru",
      description:
        "Tambah satu resource (ganti nama 'item' sesuai kebutuhan) dengan operasi buat, baca, ubah, hapus.\n\nSelesai bila: migrasi bisa dijalankan ulang, input divalidasi, daftar mendukung paginasi, dan endpoint terdokumentasi.",
    },
    tasks: [
      {
        ref: "model",
        title: "Model & migrasi resource",
        role: "backend",
        depends_on: [],
        prompt_instruction:
          "Buat model dan migrasi untuk resource 'item' (id, nama, deskripsi, timestamps). Ikuti konvensi ORM/migrasi yang sudah ada. Di handoff, catat nama tabel, kolom, dan perintah migrasi.",
      },
      {
        ref: "endpoints",
        title: "Endpoint CRUD dengan validasi",
        role: "backend",
        depends_on: ["model"],
        prompt_instruction:
          "Buat endpoint list (paginasi cursor), detail, create, update, delete untuk 'item' dengan validasi input dan kode status yang tepat (400/404/409). Tambahkan tes unit untuk validasi.",
      },
      {
        ref: "docs",
        title: "Dokumentasi & tes integrasi",
        role: "testing",
        depends_on: ["endpoints"],
        prompt_instruction:
          "Dokumentasikan setiap endpoint (contoh request/response) di README atau file docs yang ada, dan tulis tes integrasi untuk alur buat -> ubah -> hapus. Simpan konvensi penting sebagai skill repo lewat save_repo_skill.",
      },
    ],
  },
];

export function findEpicTemplate(id: string): EpicTemplate | undefined {
  return EPIC_TEMPLATES.find((t) => t.id === id);
}
