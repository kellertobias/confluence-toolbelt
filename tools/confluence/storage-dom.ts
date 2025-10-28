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
/**
 * Override Turndown's default horizontal rule output.
 *
 * Why: We want consistent dashed rules in markdown exports from Confluence
 * download rather than the default spaced asterisks ("* * *"). Use seven
 * hyphens to avoid accidental setext heading parsing and match internal docs
 * style.
 */
// TypeScript typings for turndown may not expose addRule depending on version;
// cast to any to access the extension hook safely.
(turndown as any).addRule("horizontalRuleDash", {
  filter: "hr",
  replacement: () => "-------",
});

export interface MappedNode {
  nodeId?: string;
  markdown: string;
}

/**
 * Convert storage HTML into an ordered list of mappable blocks. Each block
 * corresponds to a top-level DOM child node and carries its `data-node-id`
 * when present. This enables targeted partial updates by node ID.
 *
 * Heuristics:
 * - Respect macro placeholders via normalizeMacros/decoder
 * - Render tables to GFM using renderTableMarkdown
 * - For generic elements, convert outerHTML via Turndown and trim
 */
export function storageToMarkdownBlocks(storageHtml: string): MappedNode[] {
  const preprocessed = normalizeMacros(storageHtml || "");
  const { document } = parseHTML(preprocessed);
  const root = (document.body as any) as Element;
  const blocks: MappedNode[] = [];

  const nodes = Array.from((root as any).childNodes || []) as any[];
  for (const node of nodes) {
    if (!node) continue;
    // Element nodes
    if (node.nodeType === 1) {
      const el = node as Element & { getAttribute?: (name: string) => string | null };
      const nodeId = el.getAttribute ? el.getAttribute("data-node-id") || undefined : undefined;

      // If this is a table block (or contains a table), render as GFM
      const tag = String((el as any).tagName || "").toLowerCase();
      if (tag === "table") {
        const md = renderTableMarkdown(el);
        if (md.trim()) blocks.push({ nodeId, markdown: md.trim() });
        continue;
      }
      const tableDesc = (el as any).querySelector ? (el as any).querySelector("table") : null;
      if (tableDesc) {
        const md = renderTableMarkdown(tableDesc as Element);
        if (md.trim()) blocks.push({ nodeId, markdown: md.trim() });
        continue;
      }

      // Generic element -> markdown via Turndown and token decode
      const md = unescapeMarkdownUnderscores(
        decodeMdCommentTokens(turndown.turndown((el as any).outerHTML || (el as any).textContent || ""))
      );
      if (md.trim()) {
        blocks.push({ nodeId, markdown: md.trim() });
      }
      continue;
    }

    // Text nodes (could include macro tokens after normalization)
    if (node.nodeType === 3) {
      const t = String((node as any).textContent || "").trim();
      if (!t) continue;
      const md = unescapeMarkdownUnderscores(decodeMdCommentTokens(t));
      if (md.trim()) blocks.push({ markdown: md.trim() });
      continue;
    }
  }

  // Fallback: if no blocks were detected (unexpected), convert entire content
  // using the previous page-wide pipeline to avoid empty output.
  if (blocks.length === 0) {
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
    // Remove unnecessary underscore escaping outside code regions
    normalized = unescapeMarkdownUnderscores(normalized);
    // Ensure single blank line between blocks
    normalized = normalized.replace(/\n{3,}/g, "\n\n");
    return [{ markdown: normalized + "\n" }];
  }

  return blocks;
}

/**
 * Extract header extras (emoji/status/image) from storage HTML if present.
 * Heuristics:
 * - Emoji: look for leading emoji in title (not available here) or first emoji-like char in first heading; skip for now.
 * - Status: detect Status macro markup <ac:structured-macro ac:name="status"> and map to "color:Title".
 * - Image: first image in page body <ri:url ri:value="..."> or <img src="...">.
 */
export function extractHeaderExtrasFromStorage(storageHtml: string, title: string): { emoji?: string; status?: string; image?: string } {
  const out: { emoji?: string; status?: string; image?: string } = {};
  // Emoji: detect shortcode at start of title like :rocket: OR leading unicode emoji
  const emojiShort = title?.match(/^:([a-z0-9_+\-]+):\s*/i);
  if (emojiShort) {
    const group = emojiShort[1];
    if (group) out.emoji = group.toLowerCase();
  } else {
    // Leading unicode emoji
    const uni = title?.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
    const ch = uni?.[1];
    if (ch) {
      const map: Record<string, string> = {
        "🚀": "rocket",
        "🔥": "fire",
        "✅": "white_check_mark",
        "⚠️": "warning",
        "🐛": "bug",
        "📌": "pushpin",
        "📷": "camera",
        "⭐": "star",
      };
      out.emoji = map[ch] || ch;
    }
  }

  // Status: find status macro and extract colour/color and title params
  const statusBlock = storageHtml.match(/<ac:structured-macro[^>]*\bac:name=["']status["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/i);
  if (statusBlock) {
    const inner = statusBlock[1] || "";
    const titleParam = inner.match(/<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i);
    const colourParam = inner.match(/<ac:parameter[^>]*\bac:name=["'](?:colour|color)["'][^>]*>([\s\S]*?)<\/ac:parameter>/i);
    const label = (titleParam?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const color = (colourParam?.[1] || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
    if (label || color) out.status = `${color || 'grey'}:${label || 'Status'}`;
  }

  // Image: prefer Confluence ri:url, else fallback to img src
  const riUrl = storageHtml.match(/<ri:url[^>]*\bri:value=["']([^"']+)["'][^>]*>/i);
  if (riUrl?.[1]) out.image = riUrl[1];
  if (!out.image) {
    const imgSrc = storageHtml.match(/<img[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
    if (imgSrc?.[1]) out.image = imgSrc[1];
  }

  return out;
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

    // Inline status tag <!-- status:color:Title -->
    const statusTag = line.match(/^\s*<!--\s*status:([^:>]+):\s*([^>]+)\s*-->\s*$/i);
    if (statusTag) {
      const color = (statusTag[1] || '').trim();
      const title = (statusTag[2] || '').trim();
      out.push(`<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">${escapeHtml(title)}</ac:parameter><ac:parameter ac:name="colour">${escapeHtml(color)}</ac:parameter></ac:structured-macro>`);
      i++; continue;
    }

    // Fenced code blocks ```lang? ... ```
    const codeFence = line.match(/^```(?<lang>[A-Za-z0-9_+\-]*)\s*$/);
    if (codeFence) {
      const lang = (codeFence.groups?.lang || "").trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i] || "")) {
        body.push(lines[i] || "");
        i++;
      }
      // Skip closing fence if present
      if (i < lines.length && /^```\s*$/.test(lines[i] || "")) i++;
      const codeText = body.join("\n");
      const langParam = lang ? `<ac:parameter ac:name="language">${escapeHtml(lang)}</ac:parameter>` : '';
      // Prefer CDATA unless it contains ']]>' which would prematurely close it; fallback to escaped text
      const codeBody = codeText.includes("]]>")
        ? `<ac:plain-text-body>${escapeHtml(codeText)}</ac:plain-text-body>`
        : `<ac:plain-text-body><![CDATA[${codeText}]]></ac:plain-text-body>`;
      out.push(
        `<ac:structured-macro ac:name="code">${langParam}${codeBody}</ac:structured-macro>`
      );
      continue;
    }

    // Indented code blocks (four or more leading spaces). Consume contiguous block.
    if (/^ {4,}\S/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4,}/.test(lines[i] || "") || /^\s*$/.test(lines[i] || ""))) {
        const raw = lines[i] || "";
        if (/^\s*$/.test(raw)) { body.push(""); i++; continue; }
        body.push(raw.replace(/^ {4}/, ""));
        i++;
      }
      const codeText = body.join("\n");
      const codeBody = codeText.includes("]]>")
        ? `<ac:plain-text-body>${escapeHtml(codeText)}</ac:plain-text-body>`
        : `<ac:plain-text-body><![CDATA[${codeText}]]></ac:plain-text-body>`;
      out.push(`<ac:structured-macro ac:name="code">${codeBody}</ac:structured-macro>`);
      continue;
    }

    // Widgets
    const widget = line.match(/^\s*<!--\s*widget:([A-Za-z0-9_-]+)\s*-->\s*$/i);
    if (widget) {
      const name = widget[1]?.toLowerCase();
      out.push(`<ac:structured-macro ac:name="${name}"><ac:rich-text-body/></ac:structured-macro>`);
      i++; continue;
    }

    // Horizontal rule: accept our canonical dashed form (seven hyphens)
    if (/^\s*-------\s*$/.test(line)) {
      out.push('<hr/>');
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
      const text = h[2]?.trim() || "";
      let textWithTokens = replaceMentionCommentsWithTokens(text);
      let html = inlineHtml(textWithTokens);
      html = replaceMentionTokensWithMacros(html);
      out.push(`<h${level}>${html}</h${level}>`);
      i++; continue;
    }

    // Unordered lists (- or *). Parse minimal structure and emit <ul><li>...
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] || "")) {
        const itemText = (lines[i] || "").replace(/^\s*[-*]\s+/, "");
        items.push(`<li>${inlineHtml(itemText)}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Image with optional caption: expect either markdown image followed by caption line,
    // or a simple figure-like syntax. We'll handle markdown image + next non-empty as caption.
    const imgLine = line.match(/^!\[(.*?)\]\((.*?)\)\s*$/);
    if (imgLine) {
      const alt = imgLine[1] || "";
      const src = imgLine[2] || "";
      // Peek next line for caption if present and not blank
      const next = lines[i + 1] || "";
      const caption = /^\s*$/.test(next) ? "" : next.trim();
      const body = src.startsWith('#')
        ? `<ri:attachment ri:filename="${escapeHtml(src.slice(1))}"/>`
        : `<ri:url ri:value="${escapeHtml(src)}"/>`;
      const capHtml = caption ? `<ac:caption>${inlineHtml(caption)}</ac:caption>` : '';
      /**
       * Constrain image display to a maximum width of 500px for readability.
       * Provide both attribute and parameter forms for broad compatibility.
       */
      const displayParam = `<ac:parameter ac:name="width">500</ac:parameter>`;
      out.push(`<ac:image ac:width="500">${displayParam}${body}${capHtml}</ac:image>`);
      i += caption ? 2 : 1;
      continue;
    }

    // Info Panel blockquote: starts with > <!-- panel:color:icon -->
    if (/^>\s*<!--\s*panel:([^:>]+):([^>]+)\s*-->/.test(line)) {
      const m = line.match(/^>\s*<!--\s*panel:([^:>]+):([^>]+)\s*-->/i)!;
      const color = (m[1] || '').trim().toLowerCase();
      const icon = (m[2] || '').trim().toLowerCase();
      const body: string[] = [];
      // consume this line's tail and subsequent lines starting with '>'
      const firstTail = line.replace(/^>\s*<!--[^>]+-->\s*/, '').trim();
      if (firstTail) body.push(firstTail);
      i++;
      while (i < lines.length && /^>\s*/.test(lines[i] || '')) {
        body.push((lines[i] || '').replace(/^>\s*/, ''));
        i++;
      }
      // Convert body lines with inline markdown and join with <br/>
      const inner = body
        .map(l => replaceMentionTokensWithMacros(inlineHtml(replaceMentionCommentsWithTokens(l))))
        .join('<br/>');
      if (color === 'panel') {
        out.push(`<ac:structured-macro ac:name="panel"><ac:rich-text-body>${inner}</ac:rich-text-body></ac:structured-macro>`);
      } else {
        // Map common colors to known macros where applicable, else use panel with bgColor
        const known = ['info','note','warning','tip','success','error'];
        if (known.includes(color)) {
          out.push(`<ac:structured-macro ac:name="${color}"><ac:rich-text-body>${inner}</ac:rich-text-body></ac:structured-macro>`);
        } else {
          out.push(`<ac:structured-macro ac:name="panel"><ac:parameter ac:name="bgColor">${escapeHtml(color)}</ac:parameter><ac:rich-text-body>${inner}</ac:rich-text-body></ac:structured-macro>`);
        }
      }
      continue;
    }

    // Generic blockquote (without panel tag)
    if (/^>\s*/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s*/.test(lines[i] || '')) {
        body.push((lines[i] || '').replace(/^>\s*/, ''));
        i++;
      }
      const htmlInner = body
        .map(l => replaceMentionTokensWithMacros(inlineHtml(replaceMentionCommentsWithTokens(l))))
        .join('<br/>');
      out.push(`<blockquote>${htmlInner}</blockquote>`);
      continue;
    }

    // Paragraph (consume until blank line), with inline formatting including links and mentions
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i] || "")) {
      para.push(lines[i] || "");
      i++;
    }
    let paraText = para.join(' ').trim();
    // First, convert any mention comment tags to durable tokens so inlineHtml doesn't escape them
    paraText = replaceMentionCommentsWithTokens(paraText);
    let html = inlineHtml(paraText);
    // After inline formatting, render durable mention tokens into Confluence macros
    html = replaceMentionTokensWithMacros(html);
    out.push(`<p>${html}</p>`);
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
    if (pre) segments.push(replaceMentionTokensWithMacros(inlineHtml(pre)).replace(/\\n/g, '<br/>'));
    // Convert mention comments within cells into durable tokens directly
    const convertedComment = replaceMentionCommentsWithTokens(m[0]);
    segments.push(convertedComment);
    last = m.index + m[0]?.length;
  }
  const tail = cell.slice(last);
  if (tail) segments.push(replaceMentionTokensWithMacros(inlineHtml(tail)).replace(/\\n/g, '<br/>'));
  let out = segments.join('');
  // Finally, render any durable mention tokens into Confluence macros
  out = replaceMentionTokensWithMacros(out);
  // Trim trailing <br/> that may come from markdown literal \n at the end of cell
  out = out.replace(/(?:<br\/>\s*)+$/i, '');
  // Confluence expects inline content inside <p> within table cells for proper rendering
  const trimmed = out.trim();
  if (!trimmed) return '';
  if (/^<p[>\s]/i.test(trimmed)) return trimmed;
  return `<p>${out}</p>`;
}

function inlineHtml(s: string): string {
  // Minimal inline markdown to HTML: code, bold, links
  // Protect escaped asterisks so they remain literal and are not interpreted as formatting
  // We replace them with a durable token during processing and restore at the end.
  let out = String(s).replace(/\\\*/g, 'MD_ESC_STAR');
  // Escape raw HTML next
  out = escapeHtml(out);
  // Inline images ![alt](src) → Confluence image with 500px width
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, href) => {
    const src = String(href || "");
    const body = src.startsWith('#')
      ? `<ri:attachment ri:filename="${escapeHtml(src.slice(1))}"/>`
      : `<ri:url ri:value="${escapeHtml(src)}"/>`;
    const widthParam = `<ac:parameter ac:name="width">500</ac:parameter>`;
    return `<ac:image ac:width="500">${widthParam}${body}</ac:image>`;
  });
  // Code spans
  out = out.replace(/`([^`]+)`/g, (_m, inner) => `<code>${inner}</code>`);
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner) => `<strong>${inner}</strong>`);
  // Links
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => `<a href="${escapeHtml(String(href))}">${text}</a>`);
  // Restore literal asterisks
  out = out.replace(/MD_ESC_STAR/g, '*');
  return out;
}

// Phase 1: Replace mention HTML comments with durable tokens to avoid escaping during inline conversion
function replaceMentionCommentsWithTokens(s: string): string {
  return s.replace(/<!--\s*mention:([^\s>]+)\s+([\s\S]*?)\s*-->/g, (_m, idRaw, labelRaw) => {
    const id = String(idRaw || "");
    const label = String(labelRaw || "");
    const accountId = selectAccountId(id, label);
    const encId = encodeURIComponent(accountId);
    // Keep optional visible label for round-trip symmetry (not required for upload)
    return `MD_MENTION(${encId})`;
  });
}

// Phase 2: Render durable mention tokens as Confluence user mention macros
function replaceMentionTokensWithMacros(s: string): string {
  // Support both bare MD_MENTION(id) and MD_MENTION(id)[label] forms
  return s
    .replace(/MD(?:\\)?_MENTION\(([^)]+)\)(?:\\)?\[[^\]]*\]/g, (_m, encId) => {
      const accountId = decodeURIComponent(String(encId || ""));
      // Confluence Cloud mention storage format
      return `<ac:link><ri:user ri:account-id="${escapeHtml(accountId)}"/></ac:link>`;
    })
    .replace(/MD(?:\\)?_MENTION\(([^)]+)\)/g, (_m, encId) => {
      const accountId = decodeURIComponent(String(encId || ""));
      return `<ac:link><ri:user ri:account-id="${escapeHtml(accountId)}"/></ac:link>`;
    });
}

// Heuristic to select the correct Atlassian account ID from compound inputs like "siteId:accountId"
function selectAccountId(id: string, label: string): string {
  const candidates: string[] = [];
  const add = (v?: string) => { if (v && !candidates.includes(v)) candidates.push(v); };
  add(id);
  add(label);
  add(id.split(':').pop() || id);
  add(label.split(':').pop() || label);
  // Prefer UUID-looking tokens first
  const uuid = candidates.find((c) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(c));
  if (uuid) return uuid;
  // Otherwise pick the last segment of id as a reasonable default
  return id.split(':').pop() || id;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeMacros(html: string): string {
  let out = html;
  // Inline Status macro → durable token with color/title
  out = out.replace(/<ac:structured-macro\b[^>]*\bac:name=["']status["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_m, inner) => {
    const titleParam = inner.match(/<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i);
    const colourParam = inner.match(/<ac:parameter[^>]*\bac:name=["'](?:colour|color)["'][^>]*>([\s\S]*?)<\/ac:parameter>/i);
    const title = (titleParam?.[1] || '').replace(/<[^>]+>/g, '').trim();
    const color = (colourParam?.[1] || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
    const encTitle = encodeURIComponent(title || '');
    const encColor = encodeURIComponent(color || '');
    return `MD_STATUS(${encColor})[${encTitle}]`;
  });

  // Mentions (user) → durable token. Matches <ac:link> containing <ri:user ... />
  out = out.replace(/<ac:link\b[^>]*>([\s\S]*?)<\/ac:link>/gi, (m, inner) => {
    const userMatch = String(inner || '').match(/<ri:user[^>]*>/i);
    if (!userMatch) return m;
    const acc = String(inner || '').match(/ri:account-id=["']([^"']+)["']/i)?.[1]
      || String(inner || '').match(/ri:userkey=["']([^"']+)["']/i)?.[1]
      || String(inner || '').match(/ri:username=["']([^"']+)["']/i)?.[1]
      || '';
    // Attempt to get any visible text fallback
    const visible = String(inner || '').replace(/<[^>]+>/g, '').trim();
    const encId = encodeURIComponent(acc);
    const encVis = encodeURIComponent(visible);
    return `MD_MENTION(${encId})[${encVis}]`;
  });

  // Info/Note/Warning/Tip/Panel macros → MD_PANEL token with color/icon and body
  out = out.replace(/<ac:structured-macro\b[^>]*\bac:name=["'](info|note|warning|tip|success|error|panel)["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, name: string, inner: string) => {
      const macro = String(name || '').toLowerCase();
      const body = inner.match(/<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i)?.[1] || '';
      let color = macro;
      let icon = macro;
      if (macro === 'panel') {
        const bg = inner.match(/<ac:parameter[^>]*\bac:name=["']bgColor["'][^>]*>([\s\S]*?)<\/ac:parameter>/i)?.[1] || '';
        color = bg.replace(/<[^>]+>/g, '').trim() || 'panel';
        icon = 'panel';
      }
      const encColor = encodeURIComponent(color);
      const encIcon = encodeURIComponent(icon);
      const encBody = encodeURIComponent(body);
      return `MD_PANEL(${encColor},${encIcon})[${encBody}]`;
    }
  );

  // Images with optional captions → durable token preserving URL/filename and caption
  out = out.replace(/<ac:image\b[^>]*>([\s\S]*?)<\/ac:image>/gi, (_m, inner) => {
    const url = String(inner || '').match(/<ri:url[^>]*\bri:value=["']([^"']+)["'][^>]*>/i)?.[1] || "";
    const filename = String(inner || '').match(/<ri:attachment[^>]*\bri:filename=["']([^"']+)["'][^>]*>/i)?.[1] || "";
    const capInner = String(inner || '').match(/<ac:caption[^>]*>([\s\S]*?)<\/ac:caption>/i)?.[1] || "";
    const caption = capInner.replace(/<[^>]+>/g, '').trim();
    const ref = url || (filename ? `attach:${filename}` : "");
    if (!ref) return _m; // leave unchanged if no recognizable ref
    const encRef = encodeURIComponent(ref);
    const encCap = encodeURIComponent(caption);
    return `MD_IMAGE(${encRef})[${encCap}]`;
  });
  // Convert Confluence code macro to a durable MD_CODE token so we can emit
  // fenced code blocks later in markdown. We encode language and body to avoid
  // HTML entity/DOM parsing side effects.
  out = out.replace(/<ac:structured-macro\b[^>]*\bac:name=["']code["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_m, inner) => {
    const langParam = inner.match(/<ac:parameter[^>]*\bac:name=["']language["'][^>]*>([\s\S]*?)<\/ac:parameter>/i);
    const lang = (langParam?.[1] || "").replace(/<[^>]+>/g, '').trim();
    // ac:plain-text-body may be wrapped in CDATA or plain text
    const bodyMatch = inner.match(/<ac:plain-text-body[^>]*>([\s\S]*?)<\/ac:plain-text-body>/i);
    let body = bodyMatch?.[1] || "";
    // Unwrap CDATA if present
    const cdata = body.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    if (cdata) {
      body = cdata[1] || "";
    } else {
      // Decode basic HTML entities when not wrapped in CDATA
      body = decodeBasicEntities(body);
    }
    const encLang = encodeURIComponent(lang);
    const encBody = encodeURIComponent(body);
    return `MD_CODE(${encLang})[${encBody}]`;
  });
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
  let html = String(anyCell.innerHTML || "");
  // Extract styling color markers encoded as MD_COMMENT tokens or real comments
  let styleColor: string | undefined;
  html = html.replace(/MD_COMMENT\(([^)]+)\)/g, (_m, enc) => {
    const comment = decodeURIComponent(String(enc));
    const m = comment.match(/^(?:table|cell):bg:([#a-z0-9_-]+)$/i);
    if (m) { styleColor = String(m[1]).toLowerCase(); return ""; }
    // keep non-style comments as tokens for later global decoding
    return `MD_COMMENT(${encodeURIComponent(comment)})`;
  });
  html = html.replace(/<!--\s*(?:table|cell):bg:([#a-z0-9_-]+)\s*-->/gi, (_m, color) => {
    styleColor = String(color).toLowerCase();
    return "";
  });
  // Convert block/line break tags to newlines, then strip remaining tags
  html = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h\d)>/gi, "\n");
  // Remove remaining tags
  let text = html.replace(/<[^>]+>/g, "");
  // Decode HTML entities
  text = decodeBasicEntities(text);
  // Represent newlines as literal \n
  text = text.replace(/\r?\n/g, "\\n");
  // Normalize spaces around, but keep literal \n sequences intact
  text = text.replace(/[ \t]+/g, " ").trim();
  if (styleColor) {
    text = text.length ? `${text} <!-- cell:bg:${styleColor} -->` : `<!-- cell:bg:${styleColor} -->`;
  }
  return text;
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
    .replace(/MD(?:\\)?_WIDGET\(([^)]+)\)/g, (_m, name) => `<!-- widget:${String(name).toUpperCase()} -->`)
    
    .replace(/MD(?:\\)?_PANEL\(([^,)]*),([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g, (_m, colorEnc, iconEnc, bodyEnc) => {
      const color = decodeURIComponent(String(colorEnc || "")) || "info";
      const icon = decodeURIComponent(String(iconEnc || "")) || color;
      const innerHtml = decodeURIComponent(String(bodyEnc || ""));
      const innerMd = unescapeMarkdownUnderscores(
        decodeMdCommentTokens(turndown.turndown(innerHtml || ""))
      );
      const lines = innerMd.split(/\r?\n/);
      const outLines: string[] = [`> <!-- panel:${color}:${icon} -->`];
      for (const l of lines) outLines.push(l.trim().length ? `> ${l}` : ">");
      return outLines.join("\n");
    })
    .replace(/MD(?:\\)?_STATUS\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g, (_m, colorEnc, titleEnc) => {
      const color = decodeURIComponent(String(colorEnc || "")) || "grey";
      const title = decodeURIComponent(String(titleEnc || "")) || "Status";
      return `<!-- status:${color}:${title} -->`;
    })
    .replace(/MD(?:\\)?_IMAGE\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g, (_m, refEnc, capEnc) => {
      const ref = decodeURIComponent(String(refEnc || ""));
      const cap = decodeURIComponent(String(capEnc || ""));
      const src = ref.startsWith('attach:') ? `#${ref.slice(7)}` : ref;
      // Prefer single-line markdown image with caption in alt text, no trailing caption line
      return `![${cap || ''}](${src})`;
    })
    .replace(/MD(?:\\)?_MENTION\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g, (_m, idEnc, visEnc) => {
      const id = decodeURIComponent(String(idEnc || ""));
      const vis = decodeURIComponent(String(visEnc || ""));
      const label = vis || id;
      // Emit single mention tag in requested format
      return `<!-- mention:${id} ${label} -->`;
    })
    // Emit code blocks using fenced style ```lang\n...\n```
    .replace(/MD(?:\\)?_CODE\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g, (_m, langEnc, bodyEnc) => {
      const lang = decodeURIComponent(String(langEnc || ""));
      const body = decodeURIComponent(String(bodyEnc || ""));
      const fence = '```' + (lang ? String(lang) : '');
      return `${fence}\n${body}\n\`\`\``;
    });
}

/**
 * Remove backslash escapes before underscores outside of code blocks and code spans.
 * We keep any escapes inside fenced/indented code or inline code (`...`).
 */
function unescapeMarkdownUnderscores(md: string): string {
  // Step 1: remove single escaped underscores
  let out = md.replace(/\\_/g, "_");
  // Step 2: collapse any remaining multiple backslashes before '_' to a single backslash
  // This ensures sequences like \\_ become \_
  out = out.replace(/\\{2,}_/g, "\\_");
  // Step 3: unescape numbered-list leaders like "1\. " at start of line → "1. "
  out = out.replace(/^(\s*\d+)\\\./gm, '$1.');
  return out;
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
      const md = unescapeMarkdownUnderscores(
        decodeMdCommentTokens(turndown.turndown((el as any).outerHTML || (el as any).textContent || ""))
      );
      if (md.trim()) parts.push(md.trim());
      continue;
    }
    if (node.nodeType === 3) {
      const t = String((node as any).textContent || "").trim();
      if (t) parts.push(t);
      continue;
    }
  }
  return unescapeMarkdownUnderscores(parts.join("\n\n"));
}


