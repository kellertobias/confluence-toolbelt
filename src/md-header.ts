/**
 * Markdown top-of-file HTML comment header parser/emitter.
 *
 * Header format:
 * <!--\nREADONLY\nspaceId: 123\npageId: 456\n-->
 *
 * Why: Keep metadata in comments (not frontmatter) and make it easy to read/write.
 * The READONLY flag marks files that should be downloaded but never uploaded.
 */

export interface HeaderMeta {
  readonly?: boolean; // if true, file will be downloaded but not uploaded
  spaceId?: string;
  pageId?: string;
  title?: string;
  status?: string; // format: color:Label text, e.g., green:In Progress
}

const HEADER_START = "<!--";
const HEADER_END = "-->";

export function parseHeader(markdown: string): { meta: HeaderMeta; body: string } {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith(HEADER_START)) return { meta: {}, body: markdown };
  const end = trimmed.indexOf(HEADER_END);
  if (end === -1) return { meta: {}, body: markdown };
  const headerContent = trimmed.slice(HEADER_START.length, end).trim();
  const lines = headerContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const meta: HeaderMeta = {};
  for (const line of lines) {
    // Check for standalone READONLY flag (no colon)
    if (line === "READONLY") {
      meta.readonly = true;
      continue;
    }
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (key === "spaceId") meta.spaceId = value;
    if (key === "pageId") meta.pageId = value;
    if (key === "title") meta.title = value;
    if (key === "status") meta.status = value;
  }
  const body = trimmed.slice(end + HEADER_END.length).replace(/^\s*\n/, "");
  return { meta, body };
}

export function emitHeader(meta: HeaderMeta): string {
  const lines = [
    "<!--",
    // READONLY appears first in header for visibility
    ...(meta.readonly ? ["READONLY"] : []),
    `spaceId: ${meta.spaceId ?? ""}`,
    `pageId: ${meta.pageId ?? ""}`,
    `title: ${meta.title ?? ""}`,
    ...(meta.status ? [`status: ${meta.status}`] : []),
    "-->",
  ]; 
  return lines.join("\n") + "\n\n";
}

export function ensureHeader(markdown: string, meta: HeaderMeta): string {
  const { body } = parseHeader(markdown);
  return emitHeader(meta) + body.trimStart();
}


