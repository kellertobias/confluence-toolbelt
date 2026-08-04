/**
 * Convert Markdown into Confluence storage HTML.
 *
 * Supports a pragmatic subset covering: headings, paragraphs, fenced and
 * indented code blocks (including a mermaid diagram bridge), unordered and
 * ordered lists (with nesting), GFM tables (with optional layout comments),
 * requirement lists, images, blockquotes and info panels, widgets, status
 * tags, and basic inline formatting via `inlineHtml`.
 */

import { bytesToBase64Url } from "../core/b64.js";
import { getDeflater } from "./deflate.js";
import { decodeBasicEntities, escapeHtml, escapeRegExp } from "./html-utils.js";
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
const LIST_TABLE_START_RE = /^\s*<!--\s*list-table\s+(.+?)\s*-->\s*$/i;
const LIST_TABLE_END_RE = /^\s*<!--\s*\/list-table\s*-->\s*$/i;

/**
 * Delimiters for a collapsible section:
 * `<!-- expand:Title -->` … `<!-- /expand -->` (the title is optional).
 */
const EXPAND_START_RE = /^\s*<!--\s*expand(?::(.*?))?\s*-->\s*$/i;
const EXPAND_END_RE = /^\s*<!--\s*\/expand\s*-->\s*$/i;

/**
 * Convert Markdown to Confluence storage HTML.
 *
 * Supports headings, paragraphs, widgets via HTML comments (e.g.
 * `<!-- widget:TOC -->`), GFM tables (with optional `<!-- table:LAYOUT -->`
 * preambles), code/mermaid blocks, lists, images, blockquotes, panels, and
 * footnotes (`[^id]` references with `[^id]: text` definitions, collected
 * into a footnotes section appended at the end of the page). Inline HTML
 * comments inside table cells are preserved as-is.
 */
export function markdownToStorageHtml(md: string, debug = false): string {
  const dbg = (msg: string) => {
    if (debug) {
      console.log(`[debug:md] ${msg}`);
    }
  };
  const { lines, defs: footnoteDefs } = extractFootnoteDefinitions(
    md.split(/\r?\n/),
  );
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

    // Collapsible section: `<!-- expand:Title -->` … `<!-- /expand -->`
    if (EXPAND_START_RE.test(line)) {
      const expand = consumeExpand(lines, i, debug);
      if (expand) {
        dbg(`  → expand`);
        out.push(expand.html);
        i = expand.nextIndex;
        continue;
      }
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

    // List tables: `<!-- list-table columns=... spacing=... -->` ... `<!-- /list-table -->
    const listTableComment = line.match(LIST_TABLE_START_RE);
    if (listTableComment) {
      dbg(`  → list-table`);
      const attrs = parseListTableAttributes(listTableComment[1] || "");
      if (attrs.columns.length > 0) {
        const result = consumeListTable(lines, i, attrs);
        if (result) {
          out.push(result.html);
          i = result.nextIndex;
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
    dbg(
      `  → paragraph (${para.length} lines), calling inlineWithTokens on ${para.join(" ").trim().length} chars`,
    );
    out.push(`<p>${inlineWithTokens(para.join(" ").trim())}</p>`);
    dbg(`  ✓ paragraph done`);
  }
  let result = out.join("");
  if (footnoteDefs.size > 0) {
    const { html: withRefs, numbering } = applyFootnoteReferences(
      result,
      footnoteDefs,
    );
    result = withRefs;
    if (numbering.size > 0) {
      result += renderFootnotesSection(footnoteDefs, numbering);
    }
  }
  dbg(`conversion complete, output ${result.length} chars`);
  return result;
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
  if (EXPAND_START_RE.test(line) || EXPAND_END_RE.test(line)) {
    return true;
  }
  if (/^\s*<!--\s*table:/i.test(line) && looksLikeTableHeader(lines, i + 1)) {
    return true;
  }
  if (DEFLIST_COMMENT_RE.test(line)) {
    return true;
  }
  if (LIST_TABLE_START_RE.test(line)) {
    return true;
  }
  if (LIST_TABLE_END_RE.test(line)) {
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
// Expand (collapsible section)
// ---------------------------------------------------------------------------

/**
 * Consume a `<!-- expand:Title -->` … `<!-- /expand -->` section and render it
 * as Confluence's `expand` macro.
 *
 * The body is put back through `markdownToStorageHtml` so anything that works
 * at the top level — tables, code blocks, lists, panels, nested expands — works
 * inside a collapsible section too. Nesting is tracked by counting delimiters,
 * so the first `<!-- /expand -->` does not close an outer section early.
 *
 * @returns `null` when the section is never closed, so the caller falls back to
 *   treating the opening delimiter as ordinary content instead of swallowing
 *   the rest of the document.
 */
function consumeExpand(
  lines: string[],
  start: number,
  debug: boolean,
): { html: string; nextIndex: number } | null {
  const opening = (lines[start] || "").match(EXPAND_START_RE);
  if (!opening) {
    return null;
  }
  const title = (opening[1] || "").trim();
  const body: string[] = [];
  let depth = 1;
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i] || "";
    if (EXPAND_END_RE.test(line)) {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    } else if (EXPAND_START_RE.test(line)) {
      depth++;
    }
    body.push(line);
    i++;
  }
  if (depth !== 0) {
    return null;
  }
  const titleParam = title
    ? `<ac:parameter ac:name="title">${escapeHtml(title)}</ac:parameter>`
    : "";
  const inner = markdownToStorageHtml(body.join("\n"), debug);
  return {
    html:
      `<ac:structured-macro ac:name="expand">${titleParam}` +
      `<ac:rich-text-body>${inner}</ac:rich-text-body>` +
      `</ac:structured-macro>`,
    nextIndex: i,
  };
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
  const compressed = getDeflater().zlib(new TextEncoder().encode(state));
  const pakoEncoded = bytesToBase64Url(compressed);
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

/**
 * Join cell lines into a single escaped value. Blank lines in the middle
 * become paragraph breaks (two literal \n characters). Leading and trailing
 * blank lines are stripped so spacing between keys/rows doesn't leak into
 * cell content.
 */
function joinCellLines(parts: string[]): string {
  const trimmed = parts.map((s) => s.trim());
  // Strip leading empty strings (blank lines before the value starts).
  while (trimmed.length > 0 && trimmed[0] === "") {
    trimmed.shift();
  }
  // Strip trailing empty strings (blank lines after the value ends).
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") {
    trimmed.pop();
  }
  return trimmed.join("\\n");
}

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

  // Append a hidden expand macro that marks this table as a req-list.
  // Confluence strips custom data-* attributes on save, so normalizeMacros
  // detects this marker on download and re-injects data-req-table="true".
  parts.push(
    `<ac:structured-macro ac:name="expand">` +
      `<ac:parameter ac:name="title">req-table</ac:parameter>` +
      `<ac:rich-text-body><p></p></ac:rich-text-body>` +
      `</ac:structured-macro>`,
  );

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
/**
 * Parse one deflist bullet line using balanced parenthesis counting.
 *
 * The key may itself contain `(...)` groups (e.g. markdown links
 * `[text](page:SPACE:id)` or terms like `Overview (SN, 2026)`) without
 * breaking the match, because we track depth rather than relying on a regex
 * that stops at the first `)`.
 */
function parseDeflistLine(
  line: string,
  prefixRe: RegExp,
): { key: string; value: string } | null {
  const prefixMatch = line.match(prefixRe);
  if (!prefixMatch) {
    return null;
  }

  const keyStart = prefixMatch[0].length; // index right after the opening `(`
  let depth = 1;
  let j = keyStart;

  while (j < line.length) {
    const ch = line[j];
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        break;
      }
    }
    j++;
  }

  if (depth !== 0) {
    return null; // unbalanced — not a valid deflist item
  }
  // line[j] is the matching `)` for the opening `(` after KEYWORD.
  // The very next character must be `:`.
  if (line[j + 1] !== ":") {
    return null;
  }

  const key = line.slice(keyStart, j).trim();
  const value = line.slice(j + 2).replace(/^\s*/, ""); // skip `: `
  return { key, value };
}

function consumeDefList(
  lines: string[],
  start: number,
  keyword: string,
  columns: string[],
): { html: string; nextIndex: number } | null {
  // Prefix regex matches up to and including the opening `(` of the key.
  // Key extraction then counts balanced parentheses so that keys containing
  // `)` (e.g. markdown links `[text](page:SPACE:id)` or phrases like
  // `(SN, 2026)`) are captured correctly.
  const prefixRe = new RegExp(`^\\s*[-*]\\s+${escapeRegExp(keyword)}\\s*\\(`);
  const items: { key: string; value: string }[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] || "";
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const parsed = parseDeflistLine(line, prefixRe);
    if (!parsed) {
      break;
    }
    const key = parsed.key;
    let value = parsed.value;
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
    // Use inlineHtml so keys can contain markdown links and inline formatting.
    // Decode HTML entities first so `&amp;` in markdown becomes `&` on the
    // page rather than being double-escaped to `&amp;amp;`.
    const keyCell = item.key
      ? `<p>${inlineHtml(decodeBasicEntities(item.key))}</p>`
      : "";
    const valueCell = cellHtml(item.value);
    parts.push(`<tr><td>${keyCell}</td><td>${valueCell}</td></tr>`);
  }

  parts.push("</tbody></table>");

  // Append a hidden expand macro that stores the deflist keyword and column
  // names. Confluence strips custom data-* attributes on save, so this is the
  // only way to survive a round-trip. normalizeMacros detects this marker on
  // download and re-injects the data-* attributes before DOM parsing.
  const configPayload = `${escapeHtml(keyword)}:${escapeHtml(columnsAttr)}`;
  parts.push(
    `<ac:structured-macro ac:name="expand">` +
      `<ac:parameter ac:name="title">deflist-config</ac:parameter>` +
      `<ac:rich-text-body><p>${configPayload}</p></ac:rich-text-body>` +
      `</ac:structured-macro>`,
  );

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

    // More indented → start a nested sub-list (only if the line is actually a list item).
    if (currentIndent > indent) {
      if (!/^\s*[-*]\s+/.test(raw) && !/^\s*\d+\.\s+/.test(raw)) {
        break; // Indented non-list content (e.g. continuation paragraph) — end the list.
      }
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

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

const FOOTNOTE_DEF_RE = /^ {0,3}\[\^([^\]]+)\]:\s?(.*)$/;

/**
 * Strip `[^id]: text` footnote definitions (with indented continuation
 * lines) out of the document, wherever they appear, replacing them with
 * blank lines so surrounding paragraph/list boundaries are unaffected.
 *
 * Definitions are collected into a map keyed by id; a duplicate id keeps the
 * first definition seen. References are resolved and numbered separately by
 * `applyFootnoteReferences` once the rest of the document has been rendered.
 */
function extractFootnoteDefinitions(lines: string[]): {
  lines: string[];
  defs: Map<string, string>;
} {
  const defs = new Map<string, string>();
  const outLines = lines.slice();
  let i = 0;
  while (i < outLines.length) {
    const match = (outLines[i] || "").match(FOOTNOTE_DEF_RE);
    if (!match) {
      i++;
      continue;
    }
    const id = (match[1] || "").trim();
    let text = (match[2] || "").trim();
    outLines[i] = "";
    let j = i + 1;
    while (j < outLines.length && /^[ \t]+\S/.test(outLines[j] || "")) {
      const cont = (outLines[j] || "").trim();
      text = text ? `${text} ${cont}` : cont;
      outLines[j] = "";
      j++;
    }
    if (id && !defs.has(id)) {
      defs.set(id, text);
    }
    i = j;
  }
  return { lines: outLines, defs };
}

/**
 * Replace `[^id]` references (for ids with a known definition) with a
 * superscript backlink anchor, numbering ids in order of first appearance in
 * the rendered HTML. CDATA sections (fenced/indented code block bodies) are
 * stashed first so literal `[^id]`-looking text inside code isn't touched.
 * Only the first occurrence of a given id gets the `fnref-` anchor id, so
 * repeated references to the same footnote don't produce duplicate ids.
 */
function applyFootnoteReferences(
  html: string,
  defs: Map<string, string>,
): { html: string; numbering: Map<string, number> } {
  const cdataStash: string[] = [];
  let stashed = html.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => {
    const idx = cdataStash.push(m) - 1;
    return `MD_FN_CDATA_${idx}_END`;
  });

  const numbering = new Map<string, number>();
  const seenRefId = new Set<string>();
  let n = 0;
  stashed = stashed.replace(/\[\^([^\]\s]+)\]/g, (m, id: string) => {
    if (!defs.has(id)) {
      return m;
    }
    let num = numbering.get(id);
    if (num === undefined) {
      n++;
      num = n;
      numbering.set(id, num);
    }
    const idAttr = seenRefId.has(id)
      ? ""
      : ` id="fnref-${escapeHtml(id)}"`;
    seenRefId.add(id);
    return `<sup><a${idAttr} href="#fn-${escapeHtml(id)}">${num}</a></sup>`;
  });

  stashed = stashed.replace(
    /MD_FN_CDATA_(\d+)_END/g,
    (_m, idx) => cdataStash[Number(idx)] || "",
  );

  return { html: stashed, numbering };
}

/**
 * Render the footnotes section appended at the end of the page: a divider
 * followed by an ordered list, one entry per referenced footnote (in
 * reference order, matching the inline superscript numbers), each with a
 * backlink to its first reference.
 *
 * Confluence strips custom data-* attributes (and, defensively, may not
 * preserve plain `id` attributes either) on save, so a hidden expand macro
 * carrying the ordered id list is appended after the list. normalizeMacros
 * detects this marker on download to re-inject `data-footnotes="true"` and
 * the per-item `id="fn-..."` attributes before DOM parsing, the same trick
 * used for req-lists/deflists/list-tables.
 */
function renderFootnotesSection(
  defs: Map<string, string>,
  numbering: Map<string, number>,
): string {
  const items: string[] = [];
  const idsInOrder: string[] = [];
  for (const [id] of numbering) {
    idsInOrder.push(id);
    const bodyHtml = inlineWithTokens(defs.get(id) || "");
    items.push(
      `<li id="fn-${escapeHtml(id)}"><p>${bodyHtml} <a href="#fnref-${escapeHtml(id)}">↩</a></p></li>`,
    );
  }
  const configPayload = idsInOrder.map((id) => escapeHtml(id)).join(",");
  return (
    `<hr/><ol data-footnotes="true">${items.join("")}</ol>` +
    `<ac:structured-macro ac:name="expand">` +
    `<ac:parameter ac:name="title">footnotes-config</ac:parameter>` +
    `<ac:rich-text-body><p>${configPayload}</p></ac:rich-text-body>` +
    `</ac:structured-macro>`
  );
}

// ---------------------------------------------------------------------------
// List tables
// ---------------------------------------------------------------------------

interface ListTableColumn {
  key: string;
  header: string;
}

interface ListTableRow {
  merge?: string[][];
  cells: Record<string, string>;
  isList: Record<string, boolean>;
}

function parseListTableAttributes(
  input: string,
): { columns: ListTableColumn[]; spacing?: number[] } {
  const result: { columns: ListTableColumn[]; spacing?: number[] } = {
    columns: [],
  };

  // Extract spacing first so it doesn't interfere with column parsing.
  const spacingMatch = input.match(/spacing\s*=\s*([\d,]+)/i);
  if (spacingMatch) {
    result.spacing = spacingMatch[1]!
      .split(",")
      .map(Number)
      .filter((n: number) => !Number.isNaN(n) && n > 0);
  }

  // Remove spacing clause from input.
  const withoutSpacing = input
    .replace(/spacing\s*=\s*[\d,]+\s*/i, "")
    .trim();

  // Extract the columns=... attribute.
  const columnsMatch = withoutSpacing.match(/^columns\s*=\s*(.+)$/i);
  const colsPart = columnsMatch ? columnsMatch[1]!.trim() : "";

  // Match key:"Value" pairs. Keys are identifiers, values are quoted.
  // Accepts both `=` and `:` as separators for robustness.
  const colRegex = /([a-zA-Z_]\w*)\s*[:=]\s*"([^"]*)"/g;
  let m;
  while ((m = colRegex.exec(colsPart)) !== null) {
    result.columns.push({ key: m[1]!.trim(), header: m[2]!.trim() });
  }

  return result;
}

function consumeListTable(
  lines: string[],
  start: number,
  attrs: { columns: ListTableColumn[]; spacing?: number[] },
): { html: string; nextIndex: number } | null {
  const columnKeys = attrs.columns.map((c) => c.key);
  const colCount = columnKeys.length;

  const rows: ListTableRow[] = [];
  let i = start + 1; // skip the <!-- list-table --> comment

  while (i < lines.length) {
    const line = lines[i] || "";

    if (LIST_TABLE_END_RE.test(line)) {
      i++;
      break;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    if (/^\s*---\s*$/.test(line)) {
      i++;
      continue;
    }

    const row: ListTableRow = { cells: {}, isList: {} };

    // Collect all merge directives at the start of a row.
    while (i < lines.length) {
      const mergeMatch = (lines[i] || "").match(
        /^\s*merge\s*\(\s*([^)]+)\s*\)\s*$/,
      );
      if (!mergeMatch) {
        break;
      }
      const group = mergeMatch[1]!
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (!row.merge) {
        row.merge = [];
      }
      row.merge.push(group);
      i++;
    }

    // Skip blank lines after merge directives.
    while (i < lines.length && /^\s*$/.test(lines[i] || "")) {
      i++;
    }

    // Parse key-value pairs until row separator or end.
    while (i < lines.length) {
      const currentLine = lines[i] || "";

      if (
        /^\s*---\s*$/.test(currentLine) ||
        LIST_TABLE_END_RE.test(currentLine)
      ) {
        break;
      }

      const kvMatch = currentLine.match(
        /^\s*([a-zA-Z_]\w*)\s*:(.*)$/,
      );
      if (!kvMatch) {
        i++;
        continue;
      }

      const key = kvMatch[1]!;
      let value = kvMatch[2]!.replace(/^\s*/, "");
      i++;

      // Empty inline value: look for following list or continuation lines.
      if (!value) {
        // Skip at most one blank line before list/continuation.
        if (i < lines.length && /^\s*$/.test(lines[i] || "")) {
          i++;
        }

        // Check for indented list items.
        const listItems: string[] = [];
        while (i < lines.length) {
          const next = lines[i] || "";
          if (
            /^\s*$/.test(next) ||
            /^\s*---\s*$/.test(next) ||
            LIST_TABLE_END_RE.test(next)
          ) {
            break;
          }
          const listMatch = next.match(/^\s*[-*]\s+(.*)$/);
          if (!listMatch) break;
          listItems.push(listMatch[1]!);
          i++;
        }

        if (listItems.length > 0) {
          row.isList[key] = true;
          row.cells[key] = listItems.join("\\n");
        } else {
          // Indented continuation lines (non-list, non-key).
          const continuations: string[] = [];
          while (i < lines.length) {
            const next = lines[i] || "";
            if (
              /^\s*---\s*$/.test(next) ||
              LIST_TABLE_END_RE.test(next)
            ) {
              break;
            }
            if (/^\s*([a-zA-Z_]\w*)\s*:/.test(next)) break;
            if (/^\s*merge\s*\(/.test(next)) break;
            continuations.push(next);
            i++;
          }
          row.cells[key] = joinCellLines(continuations);
        }
      } else {
        // Value provided on same line; collect continuation lines.
        const continuations: string[] = [];
        while (i < lines.length) {
          const next = lines[i] || "";
          if (
            /^\s*---\s*$/.test(next) ||
            LIST_TABLE_END_RE.test(next)
          ) {
            break;
          }
          if (/^\s*([a-zA-Z_]\w*)\s*:/.test(next)) break;
          if (/^\s*merge\s*\(/.test(next)) break;
          continuations.push(next);
          i++;
        }
        row.cells[key] = joinCellLines([value, ...continuations]);
      }
    }

    rows.push(row);
  }

  if (rows.length === 0) {
    return null;
  }

  // Build config payload for the hidden expand macro.
  const configPayload = attrs.columns
    .map((c) => `${c.key}:${c.header}`)
    .join(",");
  const spacingPayload = attrs.spacing ? attrs.spacing.join(",") : "";
  const expandPayload = spacingPayload
    ? `${configPayload}|${spacingPayload}`
    : configPayload;

  const parts: string[] = [];
  parts.push(
    `<table data-list-table="true" data-list-table-config="${escapeHtml(configPayload)}"${spacingPayload ? ` data-list-table-spacing="${escapeHtml(spacingPayload)}"` : ""}>`,
  );

  if (attrs.spacing && attrs.spacing.length > 0) {
    parts.push("<colgroup>");
    for (const sp of attrs.spacing) {
      parts.push(`<col style="width: ${sp * 100}px;" />`);
    }
    parts.push("</colgroup>");
  }

  parts.push("<thead><tr>");
  for (const col of attrs.columns) {
    parts.push(`<th><p>${escapeHtml(col.header)}</p></th>`);
  }
  parts.push("</tr></thead>");

  parts.push("<tbody>");
  for (const row of rows) {
    // Build a map from column key -> merge group index for this row.
    const keyToMergeGroup = new Map<string, number>();
    if (row.merge) {
      for (let g = 0; g < row.merge.length; g++) {
        for (const k of row.merge[g]!) {
          keyToMergeGroup.set(k, g);
        }
      }
    }

    if (row.merge && row.merge.length > 0) {
      // Store merge info on the row so download can recover it.
      const mergeAttr = row.merge.map((g) => g.join(",")).join("|");
      parts.push(`<tr data-list-table-merge="${escapeHtml(mergeAttr)}">`);
    } else {
      parts.push("<tr>");
    }

    let colIdx = 0;
    while (colIdx < colCount) {
      const colKey = columnKeys[colIdx]!;
      const mergeGroupIdx = keyToMergeGroup.get(colKey);
      if (mergeGroupIdx !== undefined) {
        const group = row.merge![mergeGroupIdx]!;
        // Span covers all columns the group touches, based on column declaration order.
        const indices = group.map((k: string) => columnKeys.indexOf(k));
        const minIdx = Math.min(...indices);
        const maxIdx = Math.max(...indices);
        const span = maxIdx - minIdx + 1;

        // Use the first merged column that actually has a value.
        let value = "";
        let isList = false;
        for (const mk of group) {
          if (row.cells[mk]) {
            value = row.cells[mk];
            isList = !!row.isList[mk];
            break;
          }
        }
        let cellContent: string;
        if (isList) {
          const items = value.split("\\n").filter((s: string) => s !== "");
          cellContent =
            `<ul>${items.map((item: string) => `<li><p>${inlineWithTokens(item)}</p></li>`).join("")}</ul>`;
        } else {
          cellContent = cellHtml(value);
        }
        if (span > 1) {
          parts.push(`<td colspan="${span}">${cellContent}</td>`);
        } else {
          parts.push(`<td>${cellContent}</td>`);
        }
        colIdx += span;
      } else {
        const value = row.cells[colKey] || "";
        const isList = row.isList[colKey];
        let cellContent: string;
        if (isList) {
          const items = value.split("\\n").filter((s: string) => s !== "");
          cellContent =
            `<ul>${items.map((item: string) => `<li><p>${inlineWithTokens(item)}</p></li>`).join("")}</ul>`;
        } else {
          cellContent = cellHtml(value);
        }
        parts.push(`<td>${cellContent}</td>`);
        colIdx++;
      }
    }

    parts.push("</tr>");
  }
  parts.push("</tbody></table>");

  // Hidden expand macro so config survives Confluence stripping data-* attrs.
  parts.push(
    `<ac:structured-macro ac:name="expand">` +
      `<ac:parameter ac:name="title">list-table-config</ac:parameter>` +
      `<ac:rich-text-body><p>${escapeHtml(expandPayload)}</p></ac:rich-text-body>` +
      `</ac:structured-macro>`,
  );

  return { html: parts.join(""), nextIndex: i };
}
