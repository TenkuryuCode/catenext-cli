import {
  type DocumentHeading,
  DocumentIndexEntrySchema,
  type ProjectDocument,
} from "@catenext/shared";

export function recordIndex(doc: ProjectDocument) {
  return DocumentIndexEntrySchema.parse(doc);
}

export function isDocumentArchived(doc: ProjectDocument): boolean {
  return doc.archived_at != null && doc.archived_at.length > 0;
}

export function filterVisibleDocuments(
  documents: ProjectDocument[],
  includeArchived?: boolean,
): ProjectDocument[] {
  if (includeArchived) return documents;
  return documents.filter((doc) => !isDocumentArchived(doc));
}

export function extractMarkdownOutline(content: string): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  const lines = content.split(/\r?\n/);
  let fence: { char: "`" | "~"; len: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "```";
      const char = marker[0] as "`" | "~";
      if (!fence) fence = { char, len: marker.length };
      else if (fence.char === char && marker.length >= fence.len) fence = null;
      continue;
    }
    if (fence) continue;
    const headingMatch = line.match(/^(#{1,6})(\s.*)$/);
    if (!headingMatch) continue;
    const hashes = headingMatch[1];
    const title = headingMatch[2]?.trimEnd().replace(/\s#+$/, "").trim();
    if (!hashes || !title) continue;
    headings.push({ level: hashes.length, title, line: i + 1 });
  }
  return headings;
}

export function extractMarkdownSection(
  content: string,
  sectionQuery: string,
): { title: string; content: string; truncated: boolean } | null {
  const headings = extractMarkdownOutline(content);
  const needle = sectionQuery
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .toLowerCase();
  if (!needle) return null;
  const matched =
    headings.find((h) => h.title.trim().toLowerCase() === needle) ??
    headings.find((h) => h.title.trim().toLowerCase().includes(needle));
  if (!matched) return null;
  const nextHeading = headings.find((h) => h.line > matched.line && h.level <= matched.level);
  const lines = content.split(/\r?\n/);
  const startIdx = matched.line - 1;
  const endIdx = nextHeading ? nextHeading.line - 1 : lines.length;
  const slice = lines.slice(startIdx, endIdx).join("\n").trimEnd();
  return {
    title: matched.title,
    content: slice,
    truncated: slice.length < content.length,
  };
}
