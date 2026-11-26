import { type CatenextConfig, CONFIG_SCHEMA_VERSION } from "@catenext/shared";
import { isNode, parseDocument } from "yaml";
import { parseConfig } from "../config.js";

type ConfigFields = Pick<
  CatenextConfig,
  "project_id" | "project_name" | "repo_name" | "stack" | "platforms"
>;

export function renderNewConfig(fields: ConfigFields): string {
  return updateConfig(
    "# Identitas repo ini di Catenext. File milik manusia: agen tidak boleh mengubahnya.\n" +
      `schema_version: ${CONFIG_SCHEMA_VERSION}\n`,
    fields,
  );
}

/** Perbarui hanya field yang diminta, sambil mempertahankan komentar YAML. */
export function updateConfig(source: string, changes: Partial<ConfigFields>): string {
  const doc = parseDocument(source);
  let changed = false;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const current: unknown = doc.get(key, true);
    if (JSON.stringify(isNode(current) ? current.toJSON() : current) === JSON.stringify(value)) {
      continue;
    }
    const node = doc.createNode(value, { flow: Array.isArray(value) });
    if (isNode(current)) {
      node.comment = current.comment;
      node.commentBefore = current.commentBefore;
      node.spaceBefore = current.spaceBefore;
    }
    doc.set(key, node);
    changed = true;
  }
  if (!changed) return source;
  const out = doc.toString();
  parseConfig(out);
  return source.includes("\r\n") ? out.replace(/\n/g, "\r\n") : out;
}
