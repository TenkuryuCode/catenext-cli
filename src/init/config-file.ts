import { CONFIG_SCHEMA_VERSION } from "@catenext/shared";
import { parseDocument } from "yaml";
import { parseConfig } from "../config.js";

export interface ConfigFields {
  project_id: string;
  repo_name: string;
  stack: string[];
  api_url?: string;
}

export function renderNewConfig(f: ConfigFields): string {
  const lines = [
    "# Identitas repo ini di Catenext. File milik manusia: agen tidak boleh mengubahnya.",
    "# Aman di-commit (tidak berisi secret). API key ada di ~/.catenext/credentials.json.",
    `schema_version: ${CONFIG_SCHEMA_VERSION}`,
    `project_id: ${f.project_id}`,
    `repo_name: ${f.repo_name}`,
    `stack: [${f.stack.join(", ")}]`,
  ];
  if (f.api_url) lines.push(`api_url: ${f.api_url}`);
  lines.push(
    "# overrides:",
    "#   default_agent_alias: adel",
    "#   default_role: backend",
    "#   extra_rules: []",
  );
  const out = `${lines.join("\n")}\n`;
  parseConfig(out); // pastikan hasilnya valid sebelum ditulis
  return out;
}

/**
 * Perbarui config yang sudah ada tanpa membuang komentar: hanya field yang diminta
 * lewat flag yang diubah. stack & overrides tetap milik manusia.
 */
export function updateConfig(source: string, changes: Partial<ConfigFields>): string {
  const doc = parseDocument(source);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (JSON.stringify(doc.get(key)) === JSON.stringify(value)) continue;
    doc.set(key, value);
  }
  const out = doc.toString();
  if (out === parseDocument(source).toString()) return source;
  parseConfig(out);
  return out;
}
