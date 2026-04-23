/**
 * Convert Markdown into Confluence storage HTML.
 *
 * Supports a pragmatic subset covering: headings, paragraphs, fenced and
 * indented code blocks (including a mermaid diagram bridge), unordered and
 * ordered lists (with nesting), GFM tables (with optional layout comments),
 * requirement lists, images, blockquotes and info panels, widgets, status
 * tags, and basic inline formatting via `inlineHtml`.
 */

import { deflateSync } from "node:zlib";

import { escapeHtml, escapeRegExp } from "./html-utils.js";
import { inlineHtml } from "./inline-html.js";
import { TABLE_WIDTH_PX } from "./table-layout.js";
import {
  replaceCommentWrapperCommentsWithTokens,
  replaceMentionCommentsWithTokens,
  replaceMentionTokensWithMacros,
  wrapCommentTokenRangesToInlineMarkers,
} from "./tokens.js";

const REQ_LINE_RE = /^\s*[-*]\s+(n?REQ)\s*\(([^,]+),\s*([^)]+)\):\s*(.+)$/;
const REQ_VERB_TOKEN = "MDREQVERBTOK";

/**
 * Match a `<!-- deflist keyword="NAME" columns=... -->` preamble.
 * The attribute body is captured for separate parsing because attribute order
 * and quoting (quoted vs. unquoted) varies in practice.
 */
const DEFLIST_COMMENT_RE = /^\s*<!--\s*deflist\s+(.+?)\s*-->\s*$/i;

/**
 * Convert Markdown to Confluence storage HTML.
 *
 * Supports headings, paragraphs, widgets via HTML comments (e.g.
 * `<!-- widget:TOC -->`), GFM tables (with optional `<!-- table:LAYOUT -->`
 * preambles), code/mermaid blocks, lists, images, blockquotes and panels.
 * Inline HTML comments inside table cells are preserved as-is.
 */
export function markdownToStorageHtml(md: string, debug = false): string {
  const dbg = (msg: string) => { if (debug) console.log(`[debug:md] ${msg}`); };
  const lines = md.split(/\r?\n/);
  dbg(`converting ${lines.length} lines`);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || "";
    if (!line || /^\s*$/.test(line)) {
      i++;
      continue;
    }

    dbg(`line ${i}: ${line.slice(0, 100)}`);

    // Inline status tag: `<!-- status:color:Title -->`
    const statusTag = line.match(
      /^\s*<!--\s*status:([^:>]+):\s*([^>]+)\s*-->\s*$/i,
    );
    if (statusTag) {
      dbg(`  → status tag`);
      const color = (statusTag[1] || "").trim();
      const title = (statusTag[2] || "").trim();
      out.push(
        `<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">${escapeHtml(title)}</ac:parameter><ac:parameter ac:name="colour">${escapeHtml(color)}</ac:parameter></ac:structured-macro>`,
      );
      i++;
      continue;
    }

    // Fenced code blocks ```lang? ... ```
    const codeFence = line.match(/^```(?<lang>[A-Za-z0-9_+-]*)\s*$/);
    if (codeFence) {
      dbg(`  → fenced code block`);
      const lang = (codeFence.groups?.lang || "").trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i] || "")) {
        body.push(lines[i] || "");
        i++;
      }
      if (i < lines.length && /^```\s*$/.test(lines[i] || "")) {
        i++;
      }
      out.push(renderFencedCodeBlock(lang, body.join("\n")));
      continue;
    }

    // Indented code blocks (four or more leading spaces), not list items.
    if (
      /^ {4,}\S/.test(line) &&
      !/^\s*[-*]\s+/.test(line) &&
      !/^\s*\d+\.\s+/.test(line)
    ) {
      dbg(`  → indented code block`);
      const { html, nextIndex } = consumeIndentedCodeBlock(lines, i);
      out.push(html);
      i = nextIndex;
      continue;
    }

    // Widget tags: `<!-- widget:NAME -->`
    const widget = line.match(/^\s*<!--\s*widget:([A-Za-z0-9_-]+)\s*-->\s*$/i);
    if (widget) {
      dbg(`  → widget`);
      const name = widget[1]?.toLowerCase();
      out.push(
        `<ac:structured-macro ac:name="${name}"><ac:rich-text-body/></ac:structured-macro>`,
      );
      i++;
      continue;
    }

    // Horizontal rule (canonical dashed form).
    if (/^\s*-------\s*$/.test(line)) {
      dbg(`  → hr`);
      out.push("<hr/>");
      i++;
      continue;
    }

    // Table with config comment: `<!-- table:LAYOUT [COL_SHARES] -->`
    const tableConfigMatch = line.match(
      /^\s*<!--\s*table:(\S+)(?:\s+([\d,]+))?\s*-->\s*$/i,
    );
    if (tableConfigMatch && looksLikeTableHeader(lines, i + 1)) {
      dbg(`  → table (with config)`);
      const layoutName = (tableConfigMatch[1] || "").toLowerCase();
      const sharesStr = tableConfigMatch[2] || "";
      const colWidths = sharesStr
        ? sharesStr
            .split(",")
            .map(Number)
            .filter((n) => !Number.isNaN(n) && n > 0)
        : undefined;
      i++;
      const { html, nextIndex } = consumeTable(lines, i, {
        layout: layoutName,
        colWidths,
      });
      out.push(html);
      i = nextIndex;
      continue;
    }

    if (looksLikeTableHeader(lines, i)) {
      dbg(`  → table`);
      const { html, nextIndex } = consumeTable(lines, i);
      out.push(html);
      i = nextIndex;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      dbg(`  → heading h${h[1]?.length}`);
      const level = h[1]?.length;
      const text = h[2]?.trim() || "";
      out.push(`<h${level}>${inlineWithTokens(text)}</h${level}>`);
      i++;
      continue;
    }

    // Requirement lists: consecutive `- REQ(ID, VERB)` / `- nREQ(ID, VERB)`.
    if (/^\s*[-*]\s+n?REQ\s*\(/.test(line)) {
      dbg(`  → req list`);
      const reqResult = consumeReqList(lines, i);
      if (reqResult) {
        out.push(reqResult.html);
        i = reqResult.nextIndex;
        continue;
      }
    }

    // Definition lists: `<!-- deflist keyword="ROLE" columns=A,B -->` followed
    // by `- ROLE(Key): Value` bullet items (with optional indented
    // continuation lines for multi-line values).
    const deflistComment = line.match(DEFLIST_COMMENT_RE);
    if (deflistComment) {
      dbg(`  → deflist`);
      const attrs = parseDeflistAttributes(deflistComment[1] || "");
      const keyword = (attrs.keyword || "").trim();
      const columns = (attrs.columns || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      if (keyword && columns.length >= 2) {
        const deflist = consumeDefList(lines, i + 1, keyword, columns);
        if (deflist) {
          out.push(deflist.html);
          i = deflist.nextIndex;
          continue;
        }
      }
    }

    // Unordered lists (- or *).
    if (/^\s*[-*]\s+/.test(line)) {
      dbg(`  → unordered list`);
      const { html, nextIndex } = consumeList(lines, i, "unordered");
      out.push(html);
      i = nextIndex;
      continue;
    }

    // Ordered lists (1. 2. 3.) — preserve explicit starting number when possible.
    if (/^\s*\d+\.\s+/.test(line)) {
      dbg(`  → ordered list`);
      const { html, nextIndex } = consumeList(lines, i, "ordered");
      out.push(html);
      i = nextIndex;
      continue;
    }

    // Markdown image, optionally followed by a caption line.
    const imgLine = line.match(/^!\[(.*?)\]\((.*?)\)\s*$/);
    if (imgLine) {
      dbg(`  → image`);
      const alt = imgLine[1] || "";
      const src = imgLine[2] || "";
      const next = lines[i + 1] || "";
      const caption = /^\s*$/.test(next) ? "" : next.trim();
      out.push(renderImage(alt, src, caption));
      i += caption ? 2 : 1;
      continue;
    }

    // Info Panel blockquote: starts with `> <!-- panel:color:icon -->`
    if (/^>\s*<!--\s*panel:([^:>]+):([^>]+)\s*-->/.test(line)) {
      dbg(`  → info panel`);
      const result = consumeInfoPanel(lines, i);
      if (result) {
        out.push(result.html);
        i = result.nextIndex;
        continue;
      }
    }

    // Generic blockquote (without panel tag).
    if (/^>\s*/.test(line)) {
      dbg(`  → blockquote`);
      const { html, nextIndex } = consumeBlockquote(lines, i);
      out.push(html);
      i = nextIndex;
      continue;
    }

    // Paragraph — consume until a blank line or the start of another block
    // (list, heading, code fence, table, hr, blockquote, widget/status tag).
    // Without the block-boundary check, a common pattern like
    //   **Pros:**
    //   - item one
    //   - item two
    // would be swallowed into a single paragraph instead of rendering the list.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i] || "") &&
      !startsNewBlock(lines, i)
    ) {
      para.push(lines[i] || "");
      i++;
    }
    dbg(`  → paragraph (${para.length} lines), calling inlineWithTokens on ${para.join(" ").trim().length} chars`);
    out.push(`<p>${inlineWithTokens(para.join(" ").trim())}</p>`);
    dbg(`  ✓ paragraph done`);
  }
  dbg(`conversion complete, output ${out.join("").length} chars`);
  return out.join("");
}

/**
 * Return true when `lines[i]` begins a block that the top-level dispatcher in
 * `markdownToStorageHtml` would handle on its own (list item, heading, code
 * fence, table, hr, blockquote, widget/status/panel tag). Used by the
 * paragraph consumer to avoid swallowing a following block into the paragraph
 * when the author didn't leave a blank line between them.
 */
function startsNewBlock(lines: string[], i: number): boolean {
  const line = lines[i] || "";
  if (/^\s*[-*]\s+/.test(line)) {
    return true;
  }
  if (/^\s*\d+\.\s+/.test(line)) {
    return true;
  }
  if (/^#{1,6}\s+/.test(line)) {
    return true;
  }
  if (/^```/.test(line)) {
    return true;
  }
  if (/^\s*-------\s*$/.test(line)) {
    return true;
  }
  if (/^>\s*/.test(line)) {
    return true;
  }
  if (/^\s*<!--\s*(?:widget|status|panel):/i.test(line)) {
    return true;
  }
  if (/^\s*<!--\s*table:/i.test(line) && looksLikeTableHeader(lines, i + 1)) {
    return true;
  }
  if (DEFLIST_COMMENT_RE.test(line)) {
    return true;
  }
  if (looksLikeTableHeader(lines, i)) {
    return true;
  }
  return false;
}

/**
 * Very basic markdown → storage HTML for simple blocks. For complex content,
 * partial updates fall back to full-page upload elsewhere.
 */
export function naiveMarkdownToStorageHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const chunks: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inCode = !inCode;
      chunks.push(inCode ? "<pre><code>" : "</code></pre>");
      continue;
    }
    if (inCode) {
      chunks.push(escapeHtml(line));
      continue;
    }
    if (/^\s*$/.test(line)) {
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      const m = line.match(/^(#+)/);
      const level = m?.[1]?.length ?? 1;
      const text = line.replace(/^#{1,6}\s+/, "");
      chunks.push(`<h${level}>${escapeHtml(text)}</h${level}>`);
    } else if (/^[-*]\s+/.test(line)) {
      // minimal list support: each item becomes its own <p>
      chunks.push(`<p>${escapeHtml(line)}</p>`);
    } else {
      chunks.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

function renderFencedCodeBlock(lang: string, codeText: string): string {
  if (lang.toLowerCase() === "mermaid") {
    return renderMermaidBlock(codeText);
  }
  const langParam = lang
    ? `<ac:parameter ac:name="language">${escapeHtml(lang)}</ac:parameter>`
    : "";
  return `<ac:structured-macro ac:name="code">${langParam}${plainTextBody(codeText)}</ac:structured-macro>`;
}

function renderMermaidBlock(codeText: string): string {
  const state = JSON.stringify({
    code: codeText,
    mermaid: { theme: "default" },
  });
  const compressed = deflateSync(Buffer.from(state), { level: 9 });
  const pakoEncoded = compressed.toString("base64url");
  const imgUrl = `https://mermaid.ink/img/pako:${pakoEncoded}?type=png`;
  return (
    `<ac:image ac:align="center" ac:width="800">` +
    `<ac:parameter ac:name="width">800</ac:parameter>` +
    `<ri:url ri:value="${escapeHtml(imgUrl)}"/>` +
    `</ac:image>` +
    `<ac:structured-macro ac:name="expand">` +
    `<ac:parameter ac:name="title">Mermaid Diagram Source</ac:parameter>` +
    `<ac:rich-text-body>` +
    `<ac:structured-macro ac:name="code">${plainTextBody(codeText)}</ac:structured-macro>` +
    `</ac:rich-text-body>` +
    `</ac:structured-macro>`
  );
}

/**
 * Prefer CDATA unless the text contains `]]>` which would prematurely close
 * the CDATA section; fall back to escaped text in that case.
 */
function plainTextBody(codeText: string): string {
  return codeText.includes("]]>")
    ? `<ac:plain-text-body>${escapeHtml(codeText)}</ac:plain-text-body>`
    : `<ac:plain-text-body><![CDATA[${codeText}]]></ac:plain-text-body>`;
}

function consumeIndentedCodeBlock(
  lines: string[],
  start: number,
): { html: string; nextIndex: number } {
  let i = start;
  const body: string[] = [];
  while (
    i < lines.length &&
    (/^ {4,}/.test(lines[i] || "") || /^\s*$/.test(lines[i] || ""))
  ) {
    const raw = lines[i] || "";
    if (/^\s*$/.test(raw)) {
      body.push("");
      i++;
      continue;
    }
    body.push(raw.replace(/^ {4}/, ""));
    i++;
  }
  // Trim trailing blank lines so a blank separator before the next block
  // doesn't leave a spurious trailing newline in the CDATA.
  while (body.length > 0 && body[body.length - 1] === "") {
    body.pop();
  }
  const codeText = body.join("\n");
  return {
    html: `<ac:structured-macro ac:name="code">${plainTextBody(codeText)}</ac:structured-macro>`,
    nextIndex: i,
  };
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Constrain image display to a maximum width of 500px for readability.
 * Provide both attribute and parameter forms for broad compatibility, and
 * center images for better visual balance.
 */
function renderImage(alt: string, src: string, caption: string): string {
  const body = src.startsWith("#")
    ? `<ri:attachment ri:filename="${escapeHtml(src.slice(1))}"/>`
    : `<ri:url ri:value="${escapeHtml(src)}"/>`;
  const captionOrAlt = caption || alt;
  const capHtml = captionOrAlt
    ? `<ac:caption>${inlineHtml(captionOrAlt)}</ac:caption>`
    : "";
  const widthParam = `<ac:parameter ac:name="width">500</ac:parameter>`;
  const alignParam = `<ac:parameter ac:name="align">center</ac:parameter>`;
  return `<ac:image ac:width="500" ac:align="center">${widthParam}${alignParam}${body}${capHtml}</ac:image>`;
}

// ---------------------------------------------------------------------------
// Inline text helpers
// ---------------------------------------------------------------------------

/**
 * Apply our full inline pipeline: replace mention/comment-wrapper comments
 * with durable tokens, convert inline markdown to HTML, then render tokens
 * as Confluence macros and wrap comment ranges into inline markers.
 */
function inlineWithTokens(text: string): string {
  const withTokens = replaceCommentWrapperCommentsWithTokens(
    replaceMentionCommentsWithTokens(text),
  );
  let html = inlineHtml(withTokens);
  html = replaceMentionTokensWithMacros(html);
  html = wrapCommentTokenRangesToInlineMarkers(html);
  return html;
}

// ---------------------------------------------------------------------------
// Blockquotes and info panels
// ---------------------------------------------------------------------------

function consumeInfoPanel(
  lines: string[],
  start: number,
): { html: string; nextIndex: number } | null {
  const line = lines[start] || "";
  const m = line.match(/^>\s*<!--\s*panel:([^:>]+):([^>]+)\s*-->/i);
  if (!m) {
    return null;
  }
  const color = (m[1] || "").trim().toLowerCase();
  const _icon = (m[2] || "").trim().toLowerCase();
  const body: string[] = [];
  const firstTail = line.replace(/^>\s*<!--[^>]+-->\s*/, "").trim();
  if (firstTail) {
    body.push(firstTail);
  }
  let i = start + 1;
  while (i < lines.length && /^>\s*/.test(lines[i] || "")) {
    body.push((lines[i] || "").replace(/^>\s*/, ""));
    i++;
  }
  const inner = body
    .map((l) => inlineWithTokens(l.replace(/\\>/g, ">")))
    .join("<br/>");
  const innerWithComments = wrapCommentTokenRangesToInlineMarkers(inner);

  if (color === "panel") {
    return {
      html: `<ac:structured-macro ac:name="panel"><ac:rich-text-body>${innerWithComments}</ac:rich-text-body></ac:structured-macro>`,
      nextIndex: i,
    };
  }

  // Map common colors to known macros where applicable, else use panel with bgColor.
  const known = ["info", "note", "warning", "tip", "success", "error"];
  if (known.includes(color)) {
    return {
      html: `<ac:structured-macro ac:name="${color}"><ac:rich-text-body>${innerWithComments}</ac:rich-text-body></ac:structured-macro>`,
      nextIndex: i,
    };
  }
  return {
    html: `<ac:structured-macro ac:name="panel"><ac:parameter ac:name="bgColor">${escapeHtml(color)}</ac:parameter><ac:rich-text-body>${innerWithComments}</ac:rich-text-body></ac:structured-macro>`,
    nextIndex: i,
  };
}

function consumeBlockquote(
  lines: string[],
  start: number,
): { html: string; nextIndex: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length && /^>\s*/.test(lines[i] || "")) {
    body.push((lines[i] || "").replace(/^>\s*/, ""));
    i++;
  }
  const htmlInner = body.map((l) => inlineWithTokens(l)).join("<br/>");
  return {
    html: `<blockquote>${wrapCommentTokenRangesToInlineMarkers(htmlInner)}</blockquote>`,
    nextIndex: i,
  };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function looksLikeTableHeader(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) {
    return false;
  }
  const header = lines[index];
  const sep = lines[index + 1];
  return /\|/.test(header || "") && /^\s*\|?\s*:?\s*-{3,}/.test(sep || "");
}

function consumeTable(
  lines: string[],
  start: number,
  config?: { layout?: string; colWidths?: number[] },
): { html: string; nextIndex: number } {
  const rows: string[][] = [];
  let i = start;
  // header row
  const headerCells = splitRow(lines[i++] || "");
  // separator row
  i++;
  while (
    i < lines.length &&
    /\|/.test(lines[i] || "") &&
    !/^\s*$/.test(lines[i] || "")
  ) {
    rows.push(splitRow(lines[i] || ""));
    i++;
  }
  const colCount = Math.max(headerCells.length, ...rows.map((r) => r.length));
  const normalize = (cells: string[]) =>
    cells.concat(Array(Math.max(0, colCount - cells.length)).fill(""));
  const header = normalize(headerCells);
  const bodyRows = rows.map((r) => normalize(r));

  const widthPx =
    config?.layout && config.layout !== "content"
      ? TABLE_WIDTH_PX[config.layout] || 0
      : 0;
  const widthAttr = widthPx ? ` data-table-width="${widthPx}"` : "";

  const parts: string[] = [];
  parts.push(`<table${widthAttr}>`);

  if (config?.colWidths && config.colWidths.length > 0) {
    let shares = config.colWidths;
    if (shares.length < colCount) {
      shares = [...shares, ...Array(colCount - shares.length).fill(1)];
    } else if (shares.length > colCount) {
      shares = shares.slice(0, colCount);
    }
    parts.push("<colgroup>");
    for (const share of shares) {
      parts.push(`<col style="width: ${share * 100}px;" />`);
    }
    parts.push("</colgroup>");
  }

  parts.push("<thead><tr>");
  for (const c of header) {
    parts.push(`<th>${cellHtml(c)}</th>`);
  }
  parts.push("</tr></thead>");
  parts.push("<tbody>");
  for (const r of bodyRows) {
    const hasNReq = r.some((c) => /\bnREQ\s*\(/i.test(c));
    parts.push("<tr>");
    for (const c of r) {
      if (hasNReq) {
        const normalizedCell = c.replace(/\bnREQ\s*\(/gi, "REQ(");
        parts.push(
          `<td>${wrapCellContentInStrikethrough(cellHtml(normalizedCell))}</td>`,
        );
      } else {
        parts.push(`<td>${cellHtml(c)}</td>`);
      }
    }
    parts.push("</tr>");
  }
  parts.push("</tbody></table>");
  return { html: parts.join(""), nextIndex: i };
}

function splitRow(row: string): string[] {
  // Remove leading/trailing pipe and split.
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function wrapCellContentInStrikethrough(html: string): string {
  if (!html.trim()) {
    return html;
  }
  // Wrap `<p>content</p>` → `<p><s>content</s></p>`.
  if (/^<p[^>]*>/i.test(html)) {
    return html.replace(/^(<p[^>]*>)([\s\S]*)(<\/p>)$/i, "$1<s>$2</s>$3");
  }
  return `<s>${html}</s>`;
}

/**
 * Render a single table cell: preserve inline HTML comments as tokens,
 * convert surrounding text with `inlineHtml`, and wrap the result in a `<p>`
 * so Confluence renders it consistently.
 */
function cellHtml(cell: string): string {
  const segments: string[] = [];
  let last = 0;
  const re = /<!--[\s\S]*?-->/g;
  let m = re.exec(cell);
  while (m !== null) {
    const pre = cell.slice(last, m.index);
    if (pre) {
      segments.push(
        replaceMentionTokensWithMacros(inlineHtml(pre)).replace(
          /\\n/g,
          "<br/>",
        ),
      );
    }
    // Convert mention/comment-wrapper comments within cells into durable tokens.
    const convertedComment = replaceCommentWrapperCommentsWithTokens(
      replaceMentionCommentsWithTokens(m[0]),
    );
    segments.push(convertedComment);
    last = m.index + m[0].length;
    m = re.exec(cell);
  }
  const tail = cell.slice(last);
  if (tail) {
    segments.push(
      replaceMentionTokensWithMacros(inlineHtml(tail)).replace(/\\n/g, "<br/>"),
    );
  }
  let out = segments.join("");
  // Finally, render any remaining durable mention/comment tokens into macros.
  out = replaceMentionTokensWithMacros(out);
  out = wrapCommentTokenRangesToInlineMarkers(out);
  // Trim trailing <br/> that may come from a literal \n at end of cell.
  out = out.replace(/(?:<br\/>\s*)+$/i, "");
  const trimmed = out.trim();
  if (!trimmed) {
    return "";
  }
  if (/^<p[>\s]/i.test(trimmed)) {
    return trimmed;
  }
  return `<p>${out}</p>`;
}

// ---------------------------------------------------------------------------
// Requirement lists
// ---------------------------------------------------------------------------

/**
 * Consume consecutive REQ/nREQ bullet items and emit a Confluence table.
 *
 * Markdown input:
 *   - REQ(F1, MUST): The system MUST support auth.
 *   - nREQ(F2, SHOULD): SSO SHOULD be supported.
 *
 * Produces `<table data-req-table="true">` with the verb highlighted in red
 * and nREQ rows wrapped in strikethrough.
 */
function consumeReqList(
  lines: string[],
  start: number,
): { html: string; nextIndex: number } | null {
  const items: { neg: boolean; id: string; verb: string; desc: string }[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] || "";
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const match = line.match(REQ_LINE_RE);
    if (!match) {
      break;
    }
    items.push({
      neg: match[1] === "nREQ",
      id: (match[2] || "").trim(),
      verb: (match[3] || "").trim(),
      desc: (match[4] || "").trim(),
    });
    i++;
  }

  if (items.length === 0) {
    return null;
  }

  const parts: string[] = [
    '<table data-req-table="true">',
    '<colgroup><col style="width: 100px;" /><col style="width: 500px;" /></colgroup>',
    "<thead><tr><th><p>ID</p></th><th><p>Requirement</p></th></tr></thead>",
    "<tbody>",
  ];

  for (const item of items) {
    const verbHighlight = `<strong style="color: #ff0000;">${escapeHtml(item.verb)}</strong>`;
    const verbRegex = new RegExp(`\\b${escapeRegExp(item.verb)}\\b`);
    const descTokenized = item.desc.replace(verbRegex, REQ_VERB_TOKEN);
    const descHtml = inlineHtml(descTokenized).replace(
      REQ_VERB_TOKEN,
      verbHighlight,
    );

    if (item.neg) {
      parts.push(
        `<tr><td><p><s>${escapeHtml(item.id)}</s></p></td><td><p><s>${descHtml}</s></p></td></tr>`,
      );
    } else {
      parts.push(
        `<tr><td><p>${escapeHtml(item.id)}</p></td><td><p>${descHtml}</p></td></tr>`,
      );
    }
  }

  parts.push("</tbody></table>");
  return { html: parts.join(""), nextIndex: i };
}

// ---------------------------------------------------------------------------
// Definition lists
// ---------------------------------------------------------------------------

/**
 * Parse the attribute body of a `<!-- deflist ... -->` preamble into a simple
 * key/value map.
 *
 * Supports both quoted (`columns="A,B"`) and unquoted (`columns=A,B`) values.
 * Unquoted values are terminated at the next whitespace, so column names
 * containing spaces must be quoted.
 */
function parseDeflistAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^\s"]+))/g;
  let m = re.exec(input);
  while (m !== null) {
    const key = (m[1] || "").toLowerCase();
    const value = m[2] !== undefined ? m[2] : m[3] || "";
    attrs[key] = value;
    m = re.exec(input);
  }
  return attrs;
}

/**
 * Consume consecutive `- KEYWORD(key): value` bullet items and emit a
 * Confluence table that round-trips through the deflist comment.
 *
 * Multi-line values are supported via indented continuation lines; each
 * additional line becomes a `<br/>` within the same cell.
 *
 * Produces `<table data-deflist="true" data-deflist-keyword="..."
 * data-deflist-columns="...">` so the download path can reconstruct the
 * original bullet list format.
 */
function consumeDefList(
  lines: string[],
  start: number,
  keyword: string,
  columns: string[],
): { html: string; nextIndex: number } | null {
  const keywordRe = new RegExp(
    `^\\s*[-*]\\s+${escapeRegExp(keyword)}\\s*\\(([^)]*)\\):\\s*(.*)$`,
  );
  const items: { key: string; value: string }[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] || "";
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const match = line.match(keywordRe);
    if (!match) {
      break;
    }
    const key = (match[1] || "").trim();
    let value = (match[2] || "").trim();
    i++;

    // Consume indented continuation lines (e.g. multi-line definitions).
    // A continuation is any non-blank line starting with whitespace that is
    // not itself a new bullet list item.
    while (i < lines.length) {
      const next = lines[i] || "";
      if (/^\s*$/.test(next)) {
        break;
      }
      if (!/^\s+\S/.test(next) || /^\s*[-*]\s+/.test(next)) {
        break;
      }
      const trimmed = next.trim();
      value = value ? `${value}\\n${trimmed}` : trimmed;
      i++;
    }

    items.push({ key, value });
  }

  if (items.length === 0) {
    return null;
  }

  const col0 = columns[0] || "Key";
  const col1 = columns[1] || "Value";
  const columnsAttr = columns.join(",");

  const parts: string[] = [
    `<table data-deflist="true" data-deflist-keyword="${escapeHtml(keyword)}" data-deflist-columns="${escapeHtml(columnsAttr)}">`,
    '<colgroup><col style="width: 200px;" /><col style="width: 500px;" /></colgroup>',
    `<thead><tr><th><p>${escapeHtml(col0)}</p></th><th><p>${escapeHtml(col1)}</p></th></tr></thead>`,
    "<tbody>",
  ];

  for (const item of items) {
    const keyCell = item.key
      ? `<p>${escapeHtml(item.key)}</p>`
      : "";
    const valueCell = cellHtml(item.value);
    parts.push(`<tr><td>${keyCell}</td><td>${valueCell}</td></tr>`);
  }

  parts.push("</tbody></table>");
  return { html: parts.join(""), nextIndex: i };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function consumeList(
  lines: string[],
  start: number,
  kind: "unordered" | "ordered",
): { html: string; nextIndex: number } {
  const baseIndent = (lines[start] || "").match(/^(\s*)/)?.[0]?.length || 0;
  return consumeListAtIndent(lines, start, kind, baseIndent);
}

/**
 * Recursively consume list items at a given indentation level, producing
 * nested `<ul>`/`<ol>` when deeper-indented items are encountered.
 */
function consumeListAtIndent(
  lines: string[],
  start: number,
  kind: "unordered" | "ordered",
  indent: number,
): { html: string; nextIndex: number } {
  const items: string[] = [];
  let i = start;
  let orderedStart: number | undefined;

  while (i < lines.length) {
    const raw = lines[i] || "";

    if (/^\s*$/.test(raw)) {
      // Peek past blank lines: if a list item at same-or-deeper indent follows,
      // continue the list.
      let peek = i + 1;
      while (peek < lines.length && /^\s*$/.test(lines[peek] || "")) {
        peek++;
      }
      if (peek < lines.length) {
        const nextLine = lines[peek] || "";
        const nextIndent = nextLine.match(/^(\s*)/)?.[0]?.length || 0;
        const isListItem =
          /^\s*[-*]\s+/.test(nextLine) || /^\s*\d+\.\s+/.test(nextLine);
        if (isListItem && nextIndent >= indent) {
          i = peek;
          continue;
        }
      }
      break;
    }

    const currentIndent = raw.match(/^(\s*)/)?.[0]?.length || 0;

    // Less indented → this level is done.
    if (currentIndent < indent) {
      break;
    }

    // More indented → start a nested sub-list.
    if (currentIndent > indent) {
      const subKind = /^\s*\d+\.\s+/.test(raw)
        ? ("ordered" as const)
        : ("unordered" as const);
      const sub = consumeListAtIndent(lines, i, subKind, currentIndent);
      const lastIdx = items.length - 1;
      const last = items[lastIdx];
      if (last) {
        items[lastIdx] = last.replace(/<\/li>$/, `${sub.html}</li>`);
      } else {
        items.push(`<li>${sub.html}</li>`);
      }
      i = sub.nextIndex;
      continue;
    }

    // Same indent level — must match the current list kind.
    const listRe =
      kind === "ordered" ? /^\s*(\d+)\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/;
    const match = raw.match(listRe);
    if (!match) {
      break;
    }

    if (kind === "ordered" && orderedStart === undefined) {
      orderedStart = Number(match[1]);
    }

    const itemText = kind === "ordered" ? match[2] || "" : match[1] || "";
    items.push(`<li>${inlineWithTokens(itemText)}</li>`);
    i++;
  }

  if (kind === "ordered") {
    const startAttr =
      orderedStart && orderedStart > 1 ? ` start="${orderedStart}"` : "";
    return { html: `<ol${startAttr}>${items.join("")}</ol>`, nextIndex: i };
  }

  return { html: `<ul>${items.join("")}</ul>`, nextIndex: i };
}
