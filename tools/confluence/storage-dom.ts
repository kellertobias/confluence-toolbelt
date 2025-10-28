/**
 * Storage DOM helpers.
 *
 * Why: We need to translate Confluence storage HTML to Markdown blocks with
 * nodeId tags, and to replace specific nodes by nodeId for partial updates.
 */

import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { InlineTag } from "./inline-tags.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.use(gfm);

export interface MappedNode {
  nodeId?: string;
  markdown: string;
}

/**
 * Convert storage HTML into an ordered list of mappable blocks.
 * Heuristic: consider top-level blocks (p, h1..h6, ul/ol, pre, table, div with data-node-id).
 */
export function storageToMarkdownBlocks(storageHtml: string): MappedNode[] {
  const preprocessed = normalizeMacros(storageHtml);
  // Table tokenization to preserve correct row formatting
  const tables: string[] = [];
  const tokenized = preprocessed.replace(/<table[\s\S]*?<\/table>/gi, (match) => {
    const idx = tables.push(match) - 1;
    return `MD_TABLE(${idx})`;
  });
  // Convert to markdown via turndown
  const mdRaw = turndown.turndown(tokenized || "");
  // Decode widget/comment tokens and then replace table tokens to GFM
  const decoded = decodeMdCommentTokens(mdRaw);
  let normalized = replaceTableTokens(decoded, tables);
  // Ensure single blank line between blocks
  normalized = normalized.replace(/\n{3,}/g, "\n\n");
  return [{ markdown: normalized + "\n" }];
}

/**
 * Replace nodes in storage HTML by nodeId with HTML snippets.
 * If a nodeId is not found, leaves storage unchanged and returns false for that id.
 */
export function replaceNodesById(storageHtml: string, replacements: Record<string, string>): { html: string; missing: string[] } {
  const { document } = parseHTML(storageHtml);
  const missing: string[] = [];
  for (const [nodeId, html] of Object.entries(replacements)) {
    const target = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (!target) { missing.push(nodeId); continue; }
    const placeholder = document.createElement("div");
    placeholder.innerHTML = html;
    // Replace outer node with first child of placeholder or its HTML
    const parent = target.parentNode as Node | null;
    if (!parent) { missing.push(nodeId); continue; }
    const replacement = (placeholder.firstChild as Node | null) ?? (placeholder as unknown as Node);
    parent.replaceChild(replacement, target);
  }
  return { html: document.body.innerHTML, missing };
}

/**
 * Very basic markdown -> storage HTML for simple blocks. For complex content,
 * partial updates will fallback to full-page upload elsewhere.
 */
export function naiveMarkdownToStorageHtml(md: string): string {
  // Extremely simple; a proper implementation would use a real renderer.
  // Here we wrap paragraphs and preserve fenced code blocks.
  const lines = md.split(/\r?\n/);
  const chunks: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inCode = !inCode;
      chunks.push(inCode ? "<pre><code>" : "</code></pre>");
      continue;
    }
    if (inCode) { chunks.push(escapeHtml(line)); continue; }
    if (/^\s*$/.test(line)) { continue; }
    if (/^#{1,6}\s+/.test(line)) {
      const m = line.match(/^(#+)/);
      const level = m?.[1]?.length ?? 1;
      const text = line.replace(/^#{1,6}\s+/, "");
      chunks.push(`<h${level}>${escapeHtml(text)}</h${level}>`);
    } else if (/^[-*]\s+/.test(line)) {
      // minimal list support: treat each as <p>•</p> (kept simple)
      chunks.push(`<p>${escapeHtml(line)}</p>`);
    } else {
      chunks.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  return chunks.join("");
}

/**
 * Convert Markdown to Confluence storage HTML with basic support for:
 * - Headings (# .. ######)
 * - Paragraphs
 * - Widgets via HTML comments: <!-- widget:TOC -->
 * - GFM tables (one or more consecutive rows with pipes and a separator row)
 * Inline HTML comments inside table cells are preserved as-is.
 */
export function markdownToStorageHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || /^\s*$/.test(line)) { i++; continue; }

    // Widgets
    const widget = line.match(/^\s*<!--\s*widget:([A-Za-z0-9_-]+)\s*-->\s*$/i);
    if (widget) {
      const name = widget[1]?.toLowerCase();
      out.push(`<ac:structured-macro ac:name="${name}"><ac:rich-text-body/></ac:structured-macro>`);
      i++; continue;
    }

    // Tables
    if (looksLikeTableHeader(lines, i)) {
      const { html, nextIndex } = consumeTable(lines, i);
      out.push(html);
      i = nextIndex; continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1]?.length;
      const text = h[2]?.trim();
      out.push(`<h${level}>${escapeHtml(text || "")}</h${level}>`);
      i++; continue;
    }

    // Paragraph (consume until blank line)
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i] || "")) {
      para.push(lines[i] || "");
      i++;
    }
    out.push(`<p>${escapeHtml(para.join(' ').trim())}</p>`);
  }
  return out.join("");
}

function looksLikeTableHeader(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const header = lines[index];
  const sep = lines[index + 1];
  return /\|/.test(header || "") && /^\s*\|?\s*:?\s*-{3,}/.test(sep || "");
}

function consumeTable(lines: string[], start: number): { html: string; nextIndex: number } {
  const rows: string[][] = [];
  let i = start;
  // header row
  const headerCells = splitRow(lines[i++] || "");
  // separator row
  i++;
  while (i < lines.length && /\|/.test(lines[i] || "") && !/^\s*$/.test(lines[i] || "")) {
    rows.push(splitRow(lines[i] || ""));
    i++;
  }
  const colCount = Math.max(headerCells.length, ...rows.map(r => r.length));
  const normalize = (cells: string[]) => cells.concat(Array(Math.max(0, colCount - cells.length)).fill(""));
  const header = normalize(headerCells);
  const bodyRows = rows.map(r => normalize(r));
  const parts: string[] = [];
  parts.push('<table>');
  // Optional thead
  parts.push('<thead><tr>');
  for (const c of header) parts.push(`<th>${cellHtml(c)}</th>`);
  parts.push('</tr></thead>');
  parts.push('<tbody>');
  for (const r of bodyRows) {
    parts.push('<tr>');
    for (const c of r) parts.push(`<td>${cellHtml(c)}</td>`);
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');
  return { html: parts.join(''), nextIndex: i };
}

function splitRow(row: string): string[] {
  // Remove leading/trailing pipe and split
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(c => c.trim());
}

function cellHtml(cell: string): string {
  // Preserve inline HTML comments; escape other content
  const segments: string[] = [];
  let last = 0;
  const re = /<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cell)) !== null) {
    const pre = cell.slice(last, m.index);
    if (pre) segments.push(escapeHtml(pre));
    segments.push(m[0]);
    last = m.index + m[0]?.length;
  }
  const tail = cell.slice(last);
  if (tail) segments.push(escapeHtml(tail));
  return segments.join('');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeMacros(html: string): string {
  let out = html;
  // Replace TOC macro with a durable token so position is preserved through turndown
  out = out.replace(/<ac:structured-macro\b[^>]*\bac:name=["']toc["'][^>]*>[\s\S]*?<\/ac:structured-macro>/gi, () => 'MD_WIDGET(toc)');
  // Also handle self-closing TOC macro tags (e.g., <ac:structured-macro ac:name="toc" />)
  out = out.replace(/<ac:structured-macro\b[^>]*\bac:name=["']toc["'][^>]*\/>/gi, () => 'MD_WIDGET(toc)');
  // Unwrap any remaining Confluence ac:* tags by stripping the tag wrappers but keeping inner content
  out = out.replace(/<ac:[^>]+>/gi, "");
  out = out.replace(/<\/ac:[^>]+>/gi, "");
  // For other macros, unwrap the rich-text-body so inner content is preserved
  out = out.replace(/<ac:structured-macro\b[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_m, inner) => {
    const body = inner.match(/<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i);
    return body ? body[1] : inner;
  });
  // Encode comments as inline tokens so textContent retains them through DOM parsing
  out = out.replace(/<!--\s*([\s\S]*?)\s*-->/g, (_m, inner) => `MD_COMMENT(${encodeURIComponent(String(inner))})`);
  return out;
}

function renderTableMarkdown(tableEl: Element): string {
  // Build GFM table; preserve inline HTML comments inside cells
  const rows = Array.from(tableEl.querySelectorAll("tr")) as Element[];
  if (rows.length === 0) return "";
  const matrix: string[][] = rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll("th,td")) as Element[];
    return cells.map((cell) => getCellTextWithComments(cell).trim().replace(/\s+/g, " "));
  });
  const colCount = Math.max(0, ...matrix.map((r) => r.length));
  const lines: string[] = [];
  // Header row is first row
  const first = matrix[0] || [];
  const header = first.concat(Array(Math.max(0, colCount - first.length)).fill(""));
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${new Array(colCount).fill("---").join(" | ")} |`);
  for (let i = 1; i < matrix.length; i++) {
    const rowBase = matrix[i] || [];
    const row = rowBase.concat(Array(Math.max(0, colCount - rowBase.length)).fill(""));
    lines.push(`| ${row.join(" | ")} |`);
  }
  const out = lines.join("\n");
  return decodeMdCommentTokens(out);
}

function getCellTextWithComments(cell: Element): string {
  const anyCell: any = cell as any;
  const raw = String(anyCell.textContent || "");
  // Restore inline MD_COMMENT tokens back to HTML comments
  const restored = raw.replace(/MD_COMMENT\(([^)]+)\)/g, (_m, enc) => `<!-- ${decodeURIComponent(String(enc))} -->`);
  return restored.trim().replace(/\s+/g, " ");
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

function decodeMdCommentTokens(s: string): string {
  return s
    .replace(/MD(?:\\)?_COMMENT\(([^)]+)\)/g, (_m, enc) => `<!-- ${decodeURIComponent(String(enc))} -->`)
    .replace(/MD(?:\\)?_WIDGET\(([^)]+)\)/g, (_m, name) => `<!-- widget:${String(name).toUpperCase()} -->`);
}

function replaceTableTokens(markdown: string, tables: string[]): string {
  return markdown.replace(/MD(?:\\)?_TABLE\((\d+)\)/g, (_m, num) => {
    const i = Number(num);
    const html = tables[i] || "";
    const { document } = parseHTML(html);
    const table = document.querySelector("table") as Element | null;
    if (!table) return "";
    return "\n" + renderTableMarkdown(table) + "\n";
  });
}

function collapseBrokenTableArtifacts(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\|\s*$/.test(lines[i] || "")) {
      const cells: string[] = [];
      let j = i;
      // read pairs of '|' line then cell block until next non '|' starts another structure
      while (j < lines.length && /^\|\s*$/.test(lines[j] || "")) {
        let k = j + 1;
        const buf: string[] = [];
        while (k < lines.length && !/^\|\s*$/.test(lines[k] || "")) {
          if (!/^\s*$/.test(lines[k] || "")) buf.push(String(lines[k]));
          k++;
        }
        if (k >= lines.length) break;
        const cell = buf.join(' ').replace(/\s+/g, ' ').trim();
        cells.push(cell);
        j = k; // move to next '|'
      }
      if (cells.length >= 2) {
        out.push(`| ${cells.join(' | ')} |`);
        i = j; // skip consumed up to last '|'
        continue;
      }
    }
    out.push(lines[i] || "");
  }
  return out.join("\n");
}

function buildMarkdownFromDom(root: Element): string {
  const parts: string[] = [];
  const nodes = Array.from((root as any).childNodes || []);
  for (const node of nodes as any[]) {
    if (!node) continue;
    if (node.nodeType === 1) {
      const el = node as Element;
      const macro = (el as any).getAttribute?.("data-confluence-macro");
      if (macro) { parts.push(`<!-- widget:${String(macro)} -->`); continue; }
      if (String((el as any).tagName || "").toLowerCase() === "table") {
        parts.push(renderTableMarkdown(el)); continue;
      }
      const tableDesc = (el as any).querySelector ? (el as any).querySelector("table") : null;
      if (tableDesc) { parts.push(renderTableMarkdown(tableDesc as Element)); continue; }
      const md = decodeMdCommentTokens(turndown.turndown((el as any).outerHTML || (el as any).textContent || ""));
      if (md.trim()) parts.push(md.trim());
      continue;
    }
    if (node.nodeType === 3) {
      const t = String((node as any).textContent || "").trim();
      if (t) parts.push(t);
      continue;
    }
  }
  return parts.join("\n\n");
}


