/**
 * Storage DOM helpers.
 *
 * Why: We need to translate Confluence storage HTML to Markdown blocks with
 * nodeId tags, and to replace specific nodes by nodeId for partial updates.
 */

import { deflateSync } from "node:zlib";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
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
 * Detect unsupported Confluence features in storage HTML.
 *
 * Why: Some Confluence layout and macro features cannot be properly represented
 * in markdown. We need to warn users that uploading will lose these features.
 *
 * How: Scan storage HTML for known unsupported patterns and return a list of
 * feature names that would be lost on upload.
 *
 * @param storageHtml - The Confluence storage HTML to analyze
 * @returns Array of unsupported feature names found in the document
 */
export function detectUnsupportedFeatures(storageHtml: string): string[] {
  const unsupported: string[] = [];
  const html = storageHtml || "";

  // Multi-column layouts (section/column macros)
  if (
    /<ac:structured-macro\b[^>]*\bac:name=["'](?:section|column)["']/i.test(
      html,
    )
  ) {
    unsupported.push("multi-column layout");
  }

  // Page layouts (ac:layout elements)
  if (/<ac:layout\b/i.test(html)) {
    unsupported.push("page layout");
  }

  // Expand macros (exclude our own mermaid diagram source expands)
  const expandMacros = html.match(
    /<ac:structured-macro\b[^>]*\bac:name=["']expand["'][^>]*>[\s\S]*?<\/ac:structured-macro>/gi,
  );
  if (expandMacros) {
    const hasNonMermaidExpand = expandMacros.some((m) => {
      const title = (
        m.match(
          /<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim();
      return !/mermaid/i.test(title);
    });
    if (hasNonMermaidExpand) {
      unsupported.push("expand/collapse sections");
    }
  }

  // Excerpt and excerpt-include macros
  if (
    /<ac:structured-macro\b[^>]*\bac:name=["'](?:excerpt|excerpt-include)["']/i.test(
      html,
    )
  ) {
    unsupported.push("excerpt macros");
  }

  // Jira macros
  if (/<ac:structured-macro\b[^>]*\bac:name=["']jira["']/i.test(html)) {
    unsupported.push("Jira issue integration");
  }

  // Include page macro
  if (/<ac:structured-macro\b[^>]*\bac:name=["']include["']/i.test(html)) {
    unsupported.push("page include");
  }

  // Children display and page tree macros
  if (
    /<ac:structured-macro\b[^>]*\bac:name=["'](?:children|pagetree|pagetreesearch)["']/i.test(
      html,
    )
  ) {
    unsupported.push("page tree/children display");
  }

  // Roadmap and timeline macros
  if (
    /<ac:structured-macro\b[^>]*\bac:name=["'](?:roadmap|timeline)["']/i.test(
      html,
    )
  ) {
    unsupported.push("roadmap/timeline");
  }

  // Iframe and widget macros
  if (
    /<ac:structured-macro\b[^>]*\bac:name=["'](?:iframe|widget|html)["']/i.test(
      html,
    )
  ) {
    unsupported.push("embedded iframe/widget/HTML");
  }

  // Advanced table features (colspan/rowspan)
  if (/<t[hd]\b[^>]*\b(?:colspan|rowspan)=["']?[2-9]/i.test(html)) {
    unsupported.push("merged table cells");
  }

  // Chart and diagram macros
  if (
    /<ac:structured-macro\b[^>]*\bac:name=["'](?:chart|drawio|gliffy|lucidchart)["']/i.test(
      html,
    )
  ) {
    unsupported.push("charts/diagrams");
  }

  // Attachments macro (list of attachments)
  if (
    /<ac:structured-macro\b[^>]*\bac:name=["'](?:attachments|viewfile)["']/i.test(
      html,
    )
  ) {
    unsupported.push("attachments list");
  }

  // Content by label macro
  if (
    /<ac:structured-macro\b[^>]*\bac:name=["'](?:contentbylabel|recentlyupdated)["']/i.test(
      html,
    )
  ) {
    unsupported.push("dynamic content display");
  }

  return unsupported;
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
  // Wrap in a full HTML document so linkedom always creates a valid body element,
  // even when the entire content is a text token (e.g. MD_WIDGET, MD_CODE) with no HTML tags.
  const { document } = parseHTML(`<html><body>${preprocessed}</body></html>`);
  const root = document.body as any as Element;
  const blocks: MappedNode[] = [];

  const nodes = Array.from((root as any).childNodes || []) as any[];
  for (const node of nodes) {
    if (!node) {
      continue;
    }
    // Element nodes
    if (node.nodeType === 1) {
      const el = node as Element & {
        getAttribute?: (name: string) => string | null;
      };
      const nodeId = el.getAttribute
        ? el.getAttribute("data-node-id") || undefined
        : undefined;

      // If this is a table block (or contains a table), render as GFM
      const tag = String((el as any).tagName || "").toLowerCase();
      if (tag === "table") {
        const md = renderTableMarkdown(el);
        if (md.trim()) {
          blocks.push({ nodeId, markdown: md.trim() });
        }
        continue;
      }
      const tableDesc = (el as any).querySelector
        ? (el as any).querySelector("table")
        : null;
      if (tableDesc) {
        const md = renderTableMarkdown(tableDesc as Element);
        if (md.trim()) {
          blocks.push({ nodeId, markdown: md.trim() });
        }
        continue;
      }

      // Generic element -> markdown via Turndown and token decode
      const md = unescapeMarkdownUnderscores(
        decodeMdCommentTokens(
          turndown.turndown(
            (el as any).outerHTML || (el as any).textContent || "",
          ),
        ),
      );
      if (md.trim()) {
        blocks.push({ nodeId, markdown: md.trim() });
      }
      continue;
    }

    // Text nodes (could include macro tokens after normalization)
    if (node.nodeType === 3) {
      const t = String((node as any).textContent || "").trim();
      if (!t) {
        continue;
      }
      const md = unescapeMarkdownUnderscores(decodeMdCommentTokens(t));
      if (md.trim()) {
        blocks.push({ markdown: md.trim() });
      }
    }
  }

  // Fallback: if no blocks were detected (unexpected), convert entire content
  // using the previous page-wide pipeline to avoid empty output.
  if (blocks.length === 0) {
    // Table tokenization to preserve correct row formatting
    const tables: string[] = [];
    const tokenized = preprocessed.replace(
      /<table[\s\S]*?<\/table>/gi,
      (match) => {
        const idx = tables.push(match) - 1;
        return `MD_TABLE(${idx})`;
      },
    );
    // Convert to markdown via turndown
    const mdRaw = turndown.turndown(tokenized || "");
    // Decode widget/comment tokens and then replace table tokens to GFM
    const decoded = decodeMdCommentTokens(mdRaw);
    let normalized = replaceTableTokens(decoded, tables);
    // Remove unnecessary underscore escaping outside code regions
    normalized = unescapeMarkdownUnderscores(normalized);
    // Ensure single blank line between blocks
    normalized = normalized.replace(/\n{3,}/g, "\n\n");
    return [{ markdown: `${normalized}\n` }];
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
export function extractHeaderExtrasFromStorage(
  storageHtml: string,
  title: string,
): { emoji?: string; status?: string; image?: string } {
  const out: { emoji?: string; status?: string; image?: string } = {};
  // Emoji: detect shortcode at start of title like :rocket: OR leading unicode emoji
  const emojiShort = title?.match(/^:([a-z0-9_+-]+):\s*/i);
  if (emojiShort) {
    const group = emojiShort[1];
    if (group) {
      out.emoji = group.toLowerCase();
    }
  } else {
    // Leading unicode emoji
    const uni = title?.match(
      /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u,
    );
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
  const statusBlock = storageHtml.match(
    /<ac:structured-macro[^>]*\bac:name=["']status["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/i,
  );
  if (statusBlock) {
    const inner = statusBlock[1] || "";
    const titleParam = inner.match(
      /<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
    );
    const colourParam = inner.match(
      /<ac:parameter[^>]*\bac:name=["'](?:colour|color)["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
    );
    const label = (titleParam?.[1] || "").replace(/<[^>]+>/g, "").trim();
    const color = (colourParam?.[1] || "")
      .replace(/<[^>]+>/g, "")
      .trim()
      .toLowerCase();
    if (label || color) {
      out.status = `${color || "grey"}:${label || "Status"}`;
    }
  }

  // Image: prefer Confluence ri:url, else fallback to img src
  const riUrl = storageHtml.match(
    /<ri:url[^>]*\bri:value=["']([^"']+)["'][^>]*>/i,
  );
  if (riUrl?.[1]) {
    out.image = riUrl[1];
  }
  if (!out.image) {
    const imgSrc = storageHtml.match(/<img[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
    if (imgSrc?.[1]) {
      out.image = imgSrc[1];
    }
  }

  return out;
}

/**
 * Replace nodes in storage HTML by nodeId with HTML snippets.
 * If a nodeId is not found, leaves storage unchanged and returns false for that id.
 */
export function replaceNodesById(
  storageHtml: string,
  replacements: Record<string, string>,
): { html: string; missing: string[] } {
  const { document } = parseHTML(storageHtml);
  const missing: string[] = [];
  for (const [nodeId, html] of Object.entries(replacements)) {
    const target = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (!target) {
      missing.push(nodeId);
      continue;
    }
    const placeholder = document.createElement("div");
    placeholder.innerHTML = html;
    // Replace outer node with first child of placeholder or its HTML
    const parent = target.parentNode as Node | null;
    if (!parent) {
      missing.push(nodeId);
      continue;
    }
    const replacement =
      (placeholder.firstChild as Node | null) ??
      (placeholder as unknown as Node);
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
    if (!line || /^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Inline status tag <!-- status:color:Title -->
    const statusTag = line.match(
      /^\s*<!--\s*status:([^:>]+):\s*([^>]+)\s*-->\s*$/i,
    );
    if (statusTag) {
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
      const lang = (codeFence.groups?.lang || "").trim();
      i++;
      const body: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i] || "")) {
        body.push(lines[i] || "");
        i++;
      }
      // Skip closing fence if present
      if (i < lines.length && /^```\s*$/.test(lines[i] || "")) {
        i++;
      }
      const codeText = body.join("\n");

      if (lang.toLowerCase() === "mermaid") {
        const state = JSON.stringify({
          code: codeText,
          mermaid: { theme: "default" },
        });
        const compressed = deflateSync(Buffer.from(state), { level: 9 });
        const pakoEncoded = compressed.toString("base64url");
        const imgUrl = `https://mermaid.ink/img/pako:${pakoEncoded}?type=png`;
        const codeBody = codeText.includes("]]>")
          ? `<ac:plain-text-body>${escapeHtml(codeText)}</ac:plain-text-body>`
          : `<ac:plain-text-body><![CDATA[${codeText}]]></ac:plain-text-body>`;
        out.push(
          `<ac:image ac:align="center" ac:width="800">` +
            `<ac:parameter ac:name="width">800</ac:parameter>` +
            `<ri:url ri:value="${escapeHtml(imgUrl)}"/>` +
            `</ac:image>` +
            `<ac:structured-macro ac:name="expand">` +
            `<ac:parameter ac:name="title">Mermaid Diagram Source</ac:parameter>` +
            `<ac:rich-text-body>` +
            `<ac:structured-macro ac:name="code">${codeBody}</ac:structured-macro>` +
            `</ac:rich-text-body>` +
            `</ac:structured-macro>`,
        );
        continue;
      }

      const langParam = lang
        ? `<ac:parameter ac:name="language">${escapeHtml(lang)}</ac:parameter>`
        : "";
      // Prefer CDATA unless it contains ']]>' which would prematurely close it; fallback to escaped text
      const codeBody = codeText.includes("]]>")
        ? `<ac:plain-text-body>${escapeHtml(codeText)}</ac:plain-text-body>`
        : `<ac:plain-text-body><![CDATA[${codeText}]]></ac:plain-text-body>`;
      out.push(
        `<ac:structured-macro ac:name="code">${langParam}${codeBody}</ac:structured-macro>`,
      );
      continue;
    }

    // Indented code blocks (four or more leading spaces). Consume contiguous block.
    // Skip lines that look like indented list items to avoid eating nested lists.
    if (
      /^ {4,}\S/.test(line) &&
      !/^\s*[-*]\s+/.test(line) &&
      !/^\s*\d+\.\s+/.test(line)
    ) {
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
      const codeBody = codeText.includes("]]>")
        ? `<ac:plain-text-body>${escapeHtml(codeText)}</ac:plain-text-body>`
        : `<ac:plain-text-body><![CDATA[${codeText}]]></ac:plain-text-body>`;
      out.push(
        `<ac:structured-macro ac:name="code">${codeBody}</ac:structured-macro>`,
      );
      continue;
    }

    // Widgets
    const widget = line.match(/^\s*<!--\s*widget:([A-Za-z0-9_-]+)\s*-->\s*$/i);
    if (widget) {
      const name = widget[1]?.toLowerCase();
      out.push(
        `<ac:structured-macro ac:name="${name}"><ac:rich-text-body/></ac:structured-macro>`,
      );
      i++;
      continue;
    }

    // Horizontal rule: accept our canonical dashed form (seven hyphens)
    if (/^\s*-------\s*$/.test(line)) {
      out.push("<hr/>");
      i++;
      continue;
    }

    // Table with config comment: <!-- table:LAYOUT [COL_SHARES] -->
    const tableConfigMatch = line?.match(
      /^\s*<!--\s*table:(\S+)(?:\s+([\d,]+))?\s*-->\s*$/i,
    );
    if (tableConfigMatch && looksLikeTableHeader(lines, i + 1)) {
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

    // Tables
    if (looksLikeTableHeader(lines, i)) {
      const { html, nextIndex } = consumeTable(lines, i);
      out.push(html);
      i = nextIndex;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1]?.length;
      const text = h[2]?.trim() || "";
      // Convert special comment wrappers and mentions to durable tokens first
      const textWithTokens = replaceCommentWrapperCommentsWithTokens(
        replaceMentionCommentsWithTokens(text),
      );
      let html = inlineHtml(textWithTokens);
      // After inline formatting, render durable mention tokens and wrap comment ranges
      html = replaceMentionTokensWithMacros(html);
      html = wrapCommentTokenRangesToInlineMarkers(html);
      out.push(`<h${level}>${html}</h${level}>`);
      i++;
      continue;
    }

    // Unordered lists (- or *). Parse minimal structure and emit <ul><li>...
    if (/^\s*[-*]\s+/.test(line)) {
      const { html, nextIndex } = consumeList(lines, i, "unordered");
      out.push(html);
      i = nextIndex;
      continue;
    }

    // Ordered lists (1. 2. 3.). Preserve explicit starting number when possible.
    if (/^\s*\d+\.\s+/.test(line)) {
      const { html, nextIndex } = consumeList(lines, i, "ordered");
      out.push(html);
      i = nextIndex;
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
      // Prefer explicit caption line, else fall back to alt text as caption
      const captionOrAlt = caption || alt;
      const body = src.startsWith("#")
        ? `<ri:attachment ri:filename="${escapeHtml(src.slice(1))}"/>`
        : `<ri:url ri:value="${escapeHtml(src)}"/>`;
      const capHtml = captionOrAlt
        ? `<ac:caption>${inlineHtml(captionOrAlt)}</ac:caption>`
        : "";
      /**
       * Constrain image display to a maximum width of 500px for readability.
       * Provide both attribute and parameter forms for broad compatibility,
       * and center images for better visual balance.
       */
      const displayParam = `<ac:parameter ac:name="width">500</ac:parameter>`;
      const alignParam = `<ac:parameter ac:name="align">center</ac:parameter>`;
      out.push(
        `<ac:image ac:width="500" ac:align="center">${displayParam}${alignParam}${body}${capHtml}</ac:image>`,
      );
      i += caption ? 2 : 1;
      continue;
    }

    // Info Panel blockquote: starts with > <!-- panel:color:icon -->
    if (/^>\s*<!--\s*panel:([^:>]+):([^>]+)\s*-->/.test(line)) {
      const m = line.match(/^>\s*<!--\s*panel:([^:>]+):([^>]+)\s*-->/i);
      if (!m) {
        i++;
        continue;
      }
      const color = (m[1] || "").trim().toLowerCase();
      const _icon = (m[2] || "").trim().toLowerCase();
      const body: string[] = [];
      // consume this line's tail and subsequent lines starting with '>'
      const firstTail = line.replace(/^>\s*<!--[^>]+-->\s*/, "").trim();
      if (firstTail) {
        body.push(firstTail);
      }
      i++;
      while (i < lines.length && /^>\s*/.test(lines[i] || "")) {
        body.push((lines[i] || "").replace(/^>\s*/, ""));
        i++;
      }
      // Convert body lines with inline markdown and join with <br/>
      const inner = body
        .map((l) => {
          const unescaped = l.replace(/\\>/g, ">");
          const withTokens = replaceCommentWrapperCommentsWithTokens(
            replaceMentionCommentsWithTokens(unescaped),
          );
          const htmlLine = inlineHtml(withTokens);
          return replaceMentionTokensWithMacros(htmlLine);
        })
        .join("<br/>");
      const innerWithComments = wrapCommentTokenRangesToInlineMarkers(inner);
      if (color === "panel") {
        out.push(
          `<ac:structured-macro ac:name="panel"><ac:rich-text-body>${innerWithComments}</ac:rich-text-body></ac:structured-macro>`,
        );
      } else {
        // Map common colors to known macros where applicable, else use panel with bgColor
        const known = ["info", "note", "warning", "tip", "success", "error"];
        if (known.includes(color)) {
          out.push(
            `<ac:structured-macro ac:name="${color}"><ac:rich-text-body>${innerWithComments}</ac:rich-text-body></ac:structured-macro>`,
          );
        } else {
          out.push(
            `<ac:structured-macro ac:name="panel"><ac:parameter ac:name="bgColor">${escapeHtml(color)}</ac:parameter><ac:rich-text-body>${innerWithComments}</ac:rich-text-body></ac:structured-macro>`,
          );
        }
      }
      continue;
    }

    // Generic blockquote (without panel tag)
    if (/^>\s*/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s*/.test(lines[i] || "")) {
        body.push((lines[i] || "").replace(/^>\s*/, ""));
        i++;
      }
      const htmlInner = body
        .map((l) => {
          const withTokens = replaceCommentWrapperCommentsWithTokens(
            replaceMentionCommentsWithTokens(l),
          );
          const htmlLine = inlineHtml(withTokens);
          return replaceMentionTokensWithMacros(htmlLine);
        })
        .join("<br/>");
      out.push(
        `<blockquote>${wrapCommentTokenRangesToInlineMarkers(htmlInner)}</blockquote>`,
      );
      continue;
    }

    // Paragraph (consume until blank line), with inline formatting including links and mentions
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i] || "")) {
      para.push(lines[i] || "");
      i++;
    }
    let paraText = para.join(" ").trim();
    // First, convert any comment wrapper and mention tags to durable tokens so inlineHtml doesn't escape them
    paraText = replaceCommentWrapperCommentsWithTokens(
      replaceMentionCommentsWithTokens(paraText),
    );
    let html = inlineHtml(paraText);
    // After inline formatting, render durable tokens and wrap comment ranges
    html = replaceMentionTokensWithMacros(html);
    html = wrapCommentTokenRangesToInlineMarkers(html);
    out.push(`<p>${html}</p>`);
  }
  return out.join("");
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
      const px = share * 100;
      parts.push(`<col style="width: ${px}px;" />`);
    }
    parts.push("</colgroup>");
  }

  // Optional thead
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
        const innerHtml = cellHtml(normalizedCell);
        parts.push(`<td>${wrapCellContentInStrikethrough(innerHtml)}</td>`);
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
  // Remove leading/trailing pipe and split
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function wrapCellContentInStrikethrough(html: string): string {
  if (!html.trim()) {
    return html;
  }
  // Wrap <p>content</p> → <p><s>content</s></p>
  if (/^<p[^>]*>/i.test(html)) {
    return html.replace(/^(<p[^>]*>)([\s\S]*)(<\/p>)$/i, "$1<s>$2</s>$3");
  }
  return `<s>${html}</s>`;
}

function cellHtml(cell: string): string {
  // Preserve inline HTML comments; escape other content
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
    // Convert mention/comment wrapper comments within cells into durable tokens directly
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
  // Finally, render any durable mention/comment tokens into Confluence macros
  out = replaceMentionTokensWithMacros(out);
  out = wrapCommentTokenRangesToInlineMarkers(out);
  // Trim trailing <br/> that may come from markdown literal \n at the end of cell
  out = out.replace(/(?:<br\/>\s*)+$/i, "");
  // Confluence expects inline content inside <p> within table cells for proper rendering
  const trimmed = out.trim();
  if (!trimmed) {
    return "";
  }
  if (/^<p[>\s]/i.test(trimmed)) {
    return trimmed;
  }
  return `<p>${out}</p>`;
}

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
 * nested <ul>/<ol> when deeper-indented items are encountered.
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
      // Peek past blank lines: if a list item at same or deeper indent follows, continue the list
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

    // Less indented → this level is done
    if (currentIndent < indent) {
      break;
    }

    // More indented → start a nested sub-list
    if (currentIndent > indent) {
      const subKind = /^\s*\d+\.\s+/.test(raw)
        ? ("ordered" as const)
        : ("unordered" as const);
      const sub = consumeListAtIndent(lines, i, subKind, currentIndent);
      if (items.length > 0 && !!items[items.length - 1]) {
        // Attach sub-list inside the last <li>
        items[items.length - 1] = items[items.length - 1]!.replace(
          /<\/li>$/,
          `${sub.html}</li>`,
        );
      } else {
        items.push(`<li>${sub.html}</li>`);
      }
      i = sub.nextIndex;
      continue;
    }

    // Same indent level — must match the current list kind
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
    let itemHtml = inlineHtml(
      replaceCommentWrapperCommentsWithTokens(
        replaceMentionCommentsWithTokens(itemText),
      ),
    );
    itemHtml = replaceMentionTokensWithMacros(itemHtml);
    itemHtml = wrapCommentTokenRangesToInlineMarkers(itemHtml);
    items.push(`<li>${itemHtml}</li>`);
    i++;
  }

  if (kind === "ordered") {
    const startAttr =
      orderedStart && orderedStart > 1 ? ` start="${orderedStart}"` : "";
    return { html: `<ol${startAttr}>${items.join("")}</ol>`, nextIndex: i };
  }

  return { html: `<ul>${items.join("")}</ul>`, nextIndex: i };
}

function inlineHtml(s: string): string {
  // Minimal inline markdown to HTML: code, bold, links
  // Protect escaped asterisks so they remain literal and are not interpreted as formatting
  // We replace them with a durable token during processing and restore at the end.
  let out = String(s).replace(/\\\*/g, "MD_ESC_STAR");
  // Escape raw HTML next
  out = escapeHtml(out);
  // Inline images ![alt](src) → Confluence image with 500px width
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, href) => {
    const src = String(href || "");
    const body = src.startsWith("#")
      ? `<ri:attachment ri:filename="${escapeHtml(src.slice(1))}"/>`
      : `<ri:url ri:value="${escapeHtml(src)}"/>`;
    const widthParam = `<ac:parameter ac:name="width">500</ac:parameter>`;
    const alignParam = `<ac:parameter ac:name="align">center</ac:parameter>`;
    const capHtml = alt
      ? `<ac:caption>${inlineHtml(String(alt))}</ac:caption>`
      : "";
    return `<ac:image ac:width="500" ac:align="center">${widthParam}${alignParam}${body}${capHtml}</ac:image>`;
  });
  // Code spans
  out = out.replace(/`([^`]+)`/g, (_m, inner) => `<code>${inner}</code>`);
  // Bold
  out = out.replace(
    /\*\*([^*]+)\*\*/g,
    (_m, inner) => `<strong>${inner}</strong>`,
  );
  /**
   * Convert markdown links to appropriate Confluence storage format.
   *
   * Why: Different link types in Confluence use different storage formats.
   * We need to detect special schemes (page:, #attachment:) and convert them
   * to the appropriate Confluence <ac:link> format.
   *
   * How: Match markdown links and check the href for special prefixes:
   * - page:... → <ac:link><ri:page>
   * - #attachment:... → <ac:link><ri:attachment>
   * - regular URLs → <a href="...">
   */
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const hrefStr = String(href || "");

    // Page links by ID: [text](pageid:12345) — cross-space, rename-proof
    if (hrefStr.startsWith("pageid:")) {
      const contentId = hrefStr.slice(7);
      return `<ac:link><ri:content-entity ri:content-id="${escapeHtml(contentId)}"/><ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body></ac:link>`;
    }

    // Page links by title: [text](page:PageTitle) or [text](page:SPACE:PageTitle)
    if (hrefStr.startsWith("page:")) {
      const pageRef = hrefStr.slice(5);
      const parts = pageRef.split(":");
      if (parts.length >= 2 && parts[0]) {
        const spaceKey = parts[0];
        const contentTitle = parts.slice(1).join(":");
        return `<ac:link><ri:page ri:space-key="${escapeHtml(spaceKey)}" ri:content-title="${escapeHtml(contentTitle)}"/><ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body></ac:link>`;
      } else {
        return `<ac:link><ri:page ri:content-title="${escapeHtml(pageRef)}"/><ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body></ac:link>`;
      }
    }

    // Attachment links: [text](#attachment:filename.pdf)
    if (hrefStr.startsWith("#attachment:")) {
      const filename = hrefStr.slice(12); // Remove "#attachment:" prefix
      return `<ac:link><ri:attachment ri:filename="${escapeHtml(filename)}"/><ac:plain-text-link-body><![CDATA[${text}]]></ac:plain-text-link-body></ac:link>`;
    }

    // Regular links: [text](url)
    return `<a href="${escapeHtml(hrefStr)}">${text}</a>`;
  });
  // Restore literal asterisks
  out = out.replace(/MD_ESC_STAR/g, "*");
  return out;
}

// Phase 1: Replace mention HTML comments with durable tokens to avoid escaping during inline conversion
function replaceMentionCommentsWithTokens(s: string): string {
  return s.replace(
    /<!--\s*mention:([^\s>]+)\s+([\s\S]*?)\s*-->/g,
    (_m, idRaw, labelRaw) => {
      const id = String(idRaw || "");
      const label = String(labelRaw || "");
      const accountId = selectAccountId(id, label);
      const encId = encodeURIComponent(accountId);
      // Keep optional visible label for round-trip symmetry (not required for upload)
      return `MD_MENTION(${encId})`;
    },
  );
}

/**
 * Replace our markdown comment wrappers with durable tokens.
 *
 * Input examples:
 *   <!-- comment:c1 -->
 *   <!-- commend-end:c1 -->
 * Output durable tokens:
 *   MD_CMT_START(encodeURIComponent(id)) / MD_CMT_END(encodeURIComponent(id))
 */
function replaceCommentWrapperCommentsWithTokens(s: string): string {
  return s
    .replace(
      /<!--\s*comment:([^\s>]+)\s*-->/g,
      (_m, id) => `MD_CMT_START(${encodeURIComponent(String(id || ""))})`,
    )
    .replace(
      /<!--\s*commend-end:([^\s>]+)\s*-->/g,
      (_m, id) => `MD_CMT_END(${encodeURIComponent(String(id || ""))})`,
    );
}

// Phase 2: Render durable mention tokens as Confluence user mention macros
function replaceMentionTokensWithMacros(s: string): string {
  // Support both bare MD_MENTION(id) and MD_MENTION(id)[label] forms
  return s
    .replace(/MD(?:\\)?_MENTION\(([^)]+)\)(?:\\)?\[[^\]]*\]/g, (_m, encId) => {
      const accountId = decodeURIComponent(String(encId || ""));
      // Confluence Cloud inline user mention storage format
      return `<ac:atlassian-user ac:account-id="${escapeHtml(accountId)}"/>`;
    })
    .replace(/MD(?:\\)?_MENTION\(([^)]+)\)/g, (_m, encId) => {
      const accountId = decodeURIComponent(String(encId || ""));
      return `<ac:atlassian-user ac:account-id="${escapeHtml(accountId)}"/>`;
    });
}

/**
 * Replace durable inline comment tokens with Confluence inline comment macros.
 *
 * Why: We wrap commented ranges during markdown editing using HTML comments
 * like <!-- comment:ID --> ... <!-- commend-end:ID -->. On upload, we need to
 * translate those durable MD_CMT_* tokens into Confluence storage macros so the
 * commented ranges are preserved in Confluence.
 */
function _replaceCommentTokensWithMacros(_s: string): string {
  // Deprecated: we now prefer paired inline markers, keep as fallback if ever needed
  return _s;
}

/**
 * Wrap MD_CMT_START(id) ... MD_CMT_END(id) spans into a single inline marker element.
 *
 * How: Replace balanced pairs with <ac:inline-comment-marker ac:ref="id">innerHTML</ac:inline-comment-marker>.
 * Handles multiple pairs per string and ignores mismatched pairs.
 */
function wrapCommentTokenRangesToInlineMarkers(s: string): string {
  let out = s;
  // Replace repeatedly until no more pairs found (supports multiple ranges)
  // Use non-greedy inner to keep shortest span for the same id
  const pairRe =
    /MD(?:\\)?_CMT_START\(([^)]+)\)([\s\S]*?)MD(?:\\)?_CMT_END\(\1\)/g;
  let prev: string | undefined;
  do {
    prev = out;
    out = out.replace(pairRe, (_m, encId, inner) => {
      const id = decodeURIComponent(String(encId || ""));
      return `<ac:inline-comment-marker ac:ref="${escapeHtml(id)}">${inner}</ac:inline-comment-marker>`;
    });
  } while (out !== prev);
  // Drop any stray start/end tokens that might remain (unbalanced cases)
  out = out.replace(/MD(?:\\)?_CMT_START\(([^)]+)\)/g, "");
  out = out.replace(/MD(?:\\)?_CMT_END\(([^)]+)\)/g, "");
  return out;
}

// Heuristic to select the correct Atlassian account ID from compound inputs like "siteId:accountId"
function selectAccountId(id: string, label: string): string {
  const candidates: string[] = [];
  const add = (v?: string) => {
    if (v && !candidates.includes(v)) {
      candidates.push(v);
    }
  };
  add(id);
  add(label);
  add(id.split(":").pop() || id);
  add(label.split(":").pop() || label);
  // Prefer UUID-looking tokens first
  const uuid = candidates.find((c) =>
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(c),
  );
  if (uuid) {
    return uuid;
  }
  // Otherwise pick the last segment of id as a reasonable default
  return id.split(":").pop() || id;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function gcdNum(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

function normalizeMacros(html: string): string {
  let out = html;
  // Inline Status macro → durable token with color/title
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']status["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, inner) => {
      const titleParam = inner.match(
        /<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
      );
      const colourParam = inner.match(
        /<ac:parameter[^>]*\bac:name=["'](?:colour|color)["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
      );
      const title = (titleParam?.[1] || "").replace(/<[^>]+>/g, "").trim();
      const color = (colourParam?.[1] || "")
        .replace(/<[^>]+>/g, "")
        .trim()
        .toLowerCase();
      const encTitle = encodeURIComponent(title || "");
      const encColor = encodeURIComponent(color || "");
      return `MD_STATUS(${encColor})[${encTitle}]`;
    },
  );

  /**
   * Convert Confluence <ac:link> elements to appropriate tokens or markdown.
   *
   * Why: Confluence uses <ac:link> for various link types: user mentions, page links,
   * attachment links, and external URLs. We need to preserve these during markdown
   * conversion and restore them on upload.
   *
   * How: Match different <ri:*> resource identifiers within <ac:link> elements and
   * convert to appropriate tokens (mentions) or markdown links (pages, attachments, URLs).
   */
  out = out.replace(/<ac:link\b[^>]*>([\s\S]*?)<\/ac:link>/gi, (m, inner) => {
    const innerStr = String(inner || "");

    // User mentions → durable token
    const userMatch = innerStr.match(/<ri:user[^>]*>/i);
    if (userMatch) {
      const acc =
        innerStr.match(/ri:account-id=["']([^"']+)["']/i)?.[1] ||
        innerStr.match(/ri:userkey=["']([^"']+)["']/i)?.[1] ||
        innerStr.match(/ri:username=["']([^"']+)["']/i)?.[1] ||
        "";
      const visible = innerStr.replace(/<[^>]+>/g, "").trim();
      const encId = encodeURIComponent(acc);
      const encVis = encodeURIComponent(visible);
      return `MD_MENTION(${encId})[${encVis}]`;
    }

    // Content entity links (by page ID) → token
    const contentEntityMatch = innerStr.match(/<ri:content-entity[^>]*>/i);
    if (contentEntityMatch) {
      const contentId =
        innerStr.match(/ri:content-id=["']([^"']+)["']/i)?.[1] || "";
      const linkBodyMatch =
        innerStr.match(
          /<ac:plain-text-link-body[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:plain-text-link-body>/i,
        ) || innerStr.match(/<ac:link-body[^>]*>([\s\S]*?)<\/ac:link-body>/i);
      const linkBody = linkBodyMatch?.[1] || "";
      const linkText = linkBody.replace(/<[^>]+>/g, "").trim() || contentId;
      const pageRef = `pageid:${contentId}`;
      const encRef = encodeURIComponent(pageRef);
      const encText = encodeURIComponent(linkText);
      return `MD_PAGE_LINK~~${encRef}~~${encText}~~END`;
    }

    // Page links by title → token (decoded to markdown after turndown)
    const pageMatch = innerStr.match(/<ri:page[^>]*>/i);
    if (pageMatch) {
      const contentTitle =
        innerStr.match(/ri:content-title=["']([^"']+)["']/i)?.[1] || "";
      const spaceKey =
        innerStr.match(/ri:space-key=["']([^"']+)["']/i)?.[1] || "";
      const linkBodyMatch =
        innerStr.match(
          /<ac:plain-text-link-body[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:plain-text-link-body>/i,
        ) || innerStr.match(/<ac:link-body[^>]*>([\s\S]*?)<\/ac:link-body>/i);
      const linkBody = linkBodyMatch?.[1] || "";
      const linkText = linkBody.replace(/<[^>]+>/g, "").trim() || contentTitle;
      const pageRef = spaceKey
        ? `page:${spaceKey}:${contentTitle}`
        : `page:${contentTitle}`;
      const encRef = encodeURIComponent(pageRef);
      const encText = encodeURIComponent(linkText);
      return `MD_PAGE_LINK~~${encRef}~~${encText}~~END`;
    }

    // Attachment links → token (decoded to markdown after turndown)
    const attachMatch = innerStr.match(/<ri:attachment[^>]*>/i);
    if (attachMatch) {
      const filename =
        innerStr.match(/ri:filename=["']([^"']+)["']/i)?.[1] || "";
      // Extract link body separately
      const linkBodyMatch =
        innerStr.match(
          /<ac:plain-text-link-body[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:plain-text-link-body>/i,
        ) || innerStr.match(/<ac:link-body[^>]*>([\s\S]*?)<\/ac:link-body>/i);
      const linkBody = linkBodyMatch?.[1] || "";
      const linkText = linkBody.replace(/<[^>]+>/g, "").trim() || filename;
      const encFilename = encodeURIComponent(filename);
      const encText = encodeURIComponent(linkText);
      // Use token format to avoid turndown escaping
      return `MD_ATTACH_LINK~~${encFilename}~~${encText}~~END`;
    }

    // URL links within ac:link → token (decoded to markdown after turndown)
    const urlMatch = innerStr.match(/<ri:url[^>]*>/i);
    if (urlMatch) {
      const url = innerStr.match(/ri:value=["']([^"']+)["']/i)?.[1] || "";
      // Extract link body separately
      const linkBodyMatch =
        innerStr.match(
          /<ac:plain-text-link-body[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:plain-text-link-body>/i,
        ) || innerStr.match(/<ac:link-body[^>]*>([\s\S]*?)<\/ac:link-body>/i);
      const linkBody = linkBodyMatch?.[1] || "";
      const linkText = linkBody.replace(/<[^>]+>/g, "").trim() || url;
      const encUrl = encodeURIComponent(url);
      const encText = encodeURIComponent(linkText);
      // Use token format to avoid turndown escaping
      return `MD_URL_LINK~~${encUrl}~~${encText}~~END`;
    }

    // Unknown link type - preserve as-is
    return m;
  });

  // Info/Note/Warning/Tip/Panel macros → MD_PANEL token with color/icon and body
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["'](info|note|warning|tip|success|error|panel)["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, name: string, inner: string) => {
      const macro = String(name || "").toLowerCase();
      const body =
        inner.match(
          /<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i,
        )?.[1] || "";
      let color = macro;
      let icon = macro;
      if (macro === "panel") {
        const bg =
          inner.match(
            /<ac:parameter[^>]*\bac:name=["']bgColor["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
          )?.[1] || "";
        color = bg.replace(/<[^>]+>/g, "").trim() || "panel";
        icon = "panel";
      }
      const encColor = encodeURIComponent(color);
      const encIcon = encodeURIComponent(icon);
      const encBody = encodeURIComponent(body);
      return `MD_PANEL(${encColor},${encIcon})[${encBody}]`;
    },
  );

  // Legacy mermaid: comment with base64 source + mermaid.ink image → fenced block token
  out = out.replace(
    /<!--\s*mermaid:([A-Za-z0-9+/=]+)\s*-->\s*<ac:image\b[^>]*>[\s\S]*?<\/ac:image>/gi,
    (_m, encoded) => `MD_MERMAID(${encoded})`,
  );
  // New mermaid: expand macro with "Mermaid" in title → extract source as MD_MERMAID token
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']expand["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (fullMatch, inner) => {
      const title = (
        inner.match(
          /<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim();
      if (!/mermaid/i.test(title)) {
        return fullMatch;
      }
      const codeBodyMatch = inner.match(
        /<ac:plain-text-body[^>]*>([\s\S]*?)<\/ac:plain-text-body>/i,
      );
      let code = codeBodyMatch?.[1] || "";
      const cdata = code.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
      if (cdata) {
        code = cdata[1] || "";
      } else {
        code = decodeBasicEntities(code);
      }
      const encoded = Buffer.from(code).toString("base64");
      return `MD_MERMAID(${encoded})`;
    },
  );
  // Suppress orphaned mermaid.ink images (source already captured from expand or comment above)
  out = out.replace(
    /<ac:image\b[^>]*>[\s\S]*?mermaid\.ink[\s\S]*?<\/ac:image>/gi,
    "",
  );

  // Images with optional captions → durable token preserving URL/filename and caption
  out = out.replace(
    /<ac:image\b[^>]*>([\s\S]*?)<\/ac:image>/gi,
    (_m, inner) => {
      const url =
        String(inner || "").match(
          /<ri:url[^>]*\bri:value=["']([^"']+)["'][^>]*>/i,
        )?.[1] || "";
      const filename =
        String(inner || "").match(
          /<ri:attachment[^>]*\bri:filename=["']([^"']+)["'][^>]*>/i,
        )?.[1] || "";
      const capInner =
        String(inner || "").match(
          /<ac:caption[^>]*>([\s\S]*?)<\/ac:caption>/i,
        )?.[1] || "";
      const caption = capInner.replace(/<[^>]+>/g, "").trim();
      const ref = url || (filename ? `attach:${filename}` : "");
      if (!ref) {
        return _m; // leave unchanged if no recognizable ref
      }
      const encRef = encodeURIComponent(ref);
      const encCap = encodeURIComponent(caption);
      return `MD_IMAGE(${encRef})[${encCap}]`;
    },
  );
  // Convert Confluence code macro to a durable MD_CODE token so we can emit
  // fenced code blocks later in markdown. We encode language and body to avoid
  // HTML entity/DOM parsing side effects.
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']code["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, inner) => {
      const langParam = inner.match(
        /<ac:parameter[^>]*\bac:name=["']language["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
      );
      const lang = (langParam?.[1] || "").replace(/<[^>]+>/g, "").trim();
      // ac:plain-text-body may be wrapped in CDATA or plain text
      const bodyMatch = inner.match(
        /<ac:plain-text-body[^>]*>([\s\S]*?)<\/ac:plain-text-body>/i,
      );
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
    },
  );
  // Replace TOC macro with a durable token so position is preserved through turndown
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']toc["'][^>]*>[\s\S]*?<\/ac:structured-macro>/gi,
    () => "MD_WIDGET(toc)",
  );
  // Also handle self-closing TOC macro tags (e.g., <ac:structured-macro ac:name="toc" />)
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']toc["'][^>]*\/>/gi,
    () => "MD_WIDGET(toc)",
  );
  // Inline comment markers → durable tokens preserving the ref id. Handle both structured-macro and inline element forms.
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']inline-comment-marker["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, inner) => {
      const innerStr = String(inner || "");
      const ref = (
        innerStr.match(
          /<ac:parameter[^>]*\bac:name=["']ref["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim();
      const endParam = (
        innerStr.match(
          /<ac:parameter[^>]*\bac:name=["'](?:end|isEnd|endMarker|type)["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim()
        .toLowerCase();
      const isEnd =
        endParam === "true" || endParam === "1" || endParam === "end";
      const enc = encodeURIComponent(ref);
      return isEnd ? `MD_CMT_END(${enc})` : `MD_CMT_START(${enc})`;
    },
  );
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']inline-comment-end["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, inner) => {
      const ref = (
        String(inner || "").match(
          /<ac:parameter[^>]*\bac:name=["']ref["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim();
      const enc = encodeURIComponent(ref);
      return `MD_CMT_END(${enc})`;
    },
  );
  // Handle paired inline forms like <ac:inline-comment-marker ac:ref="...">TEXT</ac:inline-comment-marker>
  out = out.replace(
    /<ac:inline-comment-marker[^>]*\bac:ref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/ac:inline-comment-marker>/gi,
    (_m, ref, inner) => {
      const enc = encodeURIComponent(String(ref || ""));
      return `MD_CMT_START(${enc})${inner}MD_CMT_END(${enc})`;
    },
  );
  // Also handle potential inline self-closing/opening forms like <ac:inline-comment-marker ac:ref="..."/>
  out = out.replace(
    /<ac:inline-comment-marker[^>]*\bac:ref=["']([^"']+)["'][^>]*\/?>(?:<\/ac:inline-comment-marker>)?/gi,
    (m, ref) => {
      const isEnd =
        /\bac:(?:is-)?end=["']?(?:true|1)["']?/i.test(m) ||
        /\bac:type=["']end["']/i.test(m);
      const enc = encodeURIComponent(String(ref || ""));
      return isEnd ? `MD_CMT_END(${enc})` : `MD_CMT_START(${enc})`;
    },
  );
  out = out.replace(
    /<ac:inline-comment-end[^>]*\bac:ref=["']([^"']+)["'][^>]*\/?>(?:<\/ac:inline-comment-end>)?/gi,
    (_m, ref) => `MD_CMT_END(${encodeURIComponent(String(ref || ""))})`,
  );
  // Handle <ac:atlassian-user ac:account-id="..."/> inline user mentions before generic tag stripping
  out = out.replace(/<ac:atlassian-user\b[^>]*>/gi, (m) => {
    const acc =
      m.match(/ac:account-id=["']([^"']+)["']/i)?.[1] || "";
    const encId = encodeURIComponent(acc);
    return `MD_MENTION(${encId})[]`;
  });
  // Unwrap any remaining Confluence ac:* tags by stripping the tag wrappers but keeping inner content
  out = out.replace(/<ac:[^>]+>/gi, "");
  out = out.replace(/<\/ac:[^>]+>/gi, "");
  // For other macros, unwrap the rich-text-body so inner content is preserved
  out = out.replace(
    /<ac:structured-macro\b[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, inner) => {
      const body = inner.match(
        /<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i,
      );
      return body ? body[1] : inner;
    },
  );
  // Encode comments as inline tokens so textContent retains them through DOM parsing
  out = out.replace(
    /<!--\s*([\s\S]*?)\s*-->/g,
    (_m, inner) => `MD_COMMENT(${encodeURIComponent(String(inner))})`,
  );
  return out;
}

function tableWidthToLayoutName(px: number): string {
  if (px > 1100) {
    return "full";
  }
  if (px > 800) {
    return "wider";
  }
  return "content";
}

const TABLE_WIDTH_PX: Record<string, number> = {
  content: 760,
  wider: 960,
  full: 1800,
};

function renderTableMarkdown(tableEl: Element): string {
  // Extract table width: prefer data-table-width (pixel), fall back to legacy data-layout
  const tableWidthAttr =
    (tableEl as any).getAttribute?.("data-table-width") || "";
  const tableWidthPx = tableWidthAttr ? parseInt(tableWidthAttr, 10) : 0;

  const legacyLayout = (
    (tableEl as any).getAttribute?.("data-layout") || ""
  ).toLowerCase();
  const legacyLayoutMap: Record<string, string> = {
    "full-width": "full",
    wide: "wider",
  };

  let mappedLayout = "";
  if (tableWidthPx > 0) {
    mappedLayout = tableWidthToLayoutName(tableWidthPx);
    if (mappedLayout === "content") {
      mappedLayout = "";
    }
  } else if (legacyLayoutMap[legacyLayout]) {
    mappedLayout = legacyLayoutMap[legacyLayout] || "";
  }

  const colEls = Array.from(tableEl.querySelectorAll("col")) as Element[];
  const colPixelWidths = colEls
    .map((col) => {
      const style = (col as any).getAttribute?.("style") || "";
      const m = style.match(/width:\s*([\d.]+)/);
      return m ? parseFloat(m[1]) : 0;
    })
    .filter((w) => w > 0);

  let shares: number[] = [];
  if (colPixelWidths.length > 0) {
    const rounded = colPixelWidths.map((w) => Math.round(w));
    const g = rounded.reduce((a, b) => gcdNum(a, b));
    shares = rounded.map((w) => w / g);
    if (shares.every((s) => s === shares[0])) {
      shares = [];
    }
  }

  let configComment = "";
  if (mappedLayout) {
    configComment = `<!-- table:${mappedLayout}`;
    if (shares.length > 0) {
      configComment += ` ${shares.join(",")}`;
    }
    configComment += " -->";
  } else if (shares.length > 0) {
    configComment = `<!-- table:content ${shares.join(",")} -->`;
  }

  // Build GFM table; preserve inline HTML comments inside cells
  const rows = Array.from(tableEl.querySelectorAll("tr")) as Element[];
  if (rows.length === 0) {
    return "";
  }
  const matrix: string[][] = rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll("th,td")) as Element[];
    return cells.map((cell) =>
      getCellTextWithComments(cell).trim().replace(/\s+/g, " "),
    );
  });
  const colCount = Math.max(0, ...matrix.map((r) => r.length));
  const lines: string[] = [];
  const first = matrix[0] || [];
  const header = first.concat(
    Array(Math.max(0, colCount - first.length)).fill(""),
  );
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${new Array(colCount).fill("---").join(" | ")} |`);
  for (let i = 1; i < matrix.length; i++) {
    const rowBase = matrix[i] || [];
    const row = rowBase.concat(
      Array(Math.max(0, colCount - rowBase.length)).fill(""),
    );
    lines.push(`| ${row.join(" | ")} |`);
  }
  const tableOut = lines.join("\n");
  const decoded = decodeMdCommentTokens(tableOut);
  if (configComment) {
    return `${configComment}\n${decoded}`;
  }
  return decoded;
}

function getCellTextWithComments(cell: Element): string {
  const anyCell: any = cell as any;
  let html = String(anyCell.innerHTML || "");
  // Detect if cell content is struck through (<s> or <del> wrapping)
  const strippedForDetect = html.replace(/<!--[\s\S]*?-->/g, "").trim();
  const cellIsStrikethrough =
    /^<p[^>]*><(?:s|del)[^>]*>[\s\S]*<\/(?:s|del)><\/p>$/i.test(
      strippedForDetect,
    ) || /^<(?:s|del)[^>]*>[\s\S]*<\/(?:s|del)>$/i.test(strippedForDetect);
  // Strip <s>/<del> tags (content kept, strike formatting dropped — nREQ token handles it)
  html = html.replace(/<\/?(?:s|del)\b[^>]*>/gi, "");
  // Extract styling color markers encoded as MD_COMMENT tokens or real comments
  let styleColor: string | undefined;
  html = html.replace(/MD_COMMENT\(([^)]+)\)/g, (_m, enc) => {
    const comment = decodeURIComponent(String(enc));
    const m = comment.match(/^(?:table|cell):bg:([#a-z0-9_-]+)$/i);
    if (m) {
      styleColor = String(m[1]).toLowerCase();
      return "";
    }
    // keep non-style comments as tokens for later global decoding
    return `MD_COMMENT(${encodeURIComponent(comment)})`;
  });
  html = html.replace(
    /<!--\s*(?:table|cell):bg:([#a-z0-9_-]+)\s*-->/gi,
    (_m, color) => {
      styleColor = String(color).toLowerCase();
      return "";
    },
  );
  // Convert block/line break tags to newlines, then strip remaining tags
  html = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h\d)>/gi, "\n");
  // Remove remaining tags
  let text = html.replace(/<[^>]+>/g, "");
  // Decode HTML entities
  text = decodeBasicEntities(text);
  /**
   * Encode line breaks in table cells as literal \n escape sequences.
   *
   * Why: Table cells in markdown are single-line; actual newlines would break
   * the GFM table structure. We encode them as the literal two-character
   * sequence \n so they survive round-trips and can be decoded to <br/> on upload.
   */
  text = text.replace(/\r?\n/g, "\\n");
  // Strip trailing literal \n escapes that come from closing </p> or </li> tags
  text = text.replace(/(\\n)+$/, "");
  // Normalize spaces around, collapsing multiple spaces to one
  text = text.replace(/[ \t]+/g, " ").trim();
  // If cell was struck through, convert REQ( → nREQ( to signal a rejected requirement
  if (cellIsStrikethrough) {
    text = text.replace(/\bREQ\s*\(/g, "nREQ(");
  }
  if (styleColor) {
    text = text.length
      ? `${text} <!-- cell:bg:${styleColor} -->`
      : `<!-- cell:bg:${styleColor} -->`;
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
  let out = s
    .replace(
      /MD(?:\\)?_COMMENT\(([^)]+)\)/g,
      (_m, enc) => `<!-- ${decodeURIComponent(String(enc))} -->`,
    )
    .replace(
      /MD(?:\\)?_WIDGET\(([^)]+)\)/g,
      (_m, name) => `<!-- widget:${String(name).toUpperCase()} -->`,
    )
    // Inline comment start/end markers to markdown wrapper comments.
    // Handle both literal and Turndown-escaped forms (MD\_CMT\_START, MD_CMT_START, etc.)
    .replace(
      /MD(?:\\)?_CMT(?:\\)?_START\(([^)]+)\)/g,
      (_m, enc) => `<!-- comment:${decodeURIComponent(String(enc || ""))} -->`,
    )
    .replace(
      /MD(?:\\)?_CMT(?:\\)?_END\(([^)]+)\)/g,
      (_m, enc) =>
        `<!-- commend-end:${decodeURIComponent(String(enc || ""))} -->`,
    )
    /**
     * Convert page link tokens to markdown links.
     *
     * Why: Preserve Confluence page links as readable markdown that can be round-tripped.
     * Format: MD_PAGE_LINK~~page%3A...~~text...~~END → [text](page:...)
     */
    .replace(
      /MD(?:\\)?_PAGE(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, refEnc, textEnc) => {
        const pageRef = decodeURIComponent(String(refEnc || ""));
        const linkText = decodeURIComponent(String(textEnc || ""));
        return `[${linkText}](${pageRef})`;
      },
    )
    /**
     * Convert attachment link tokens to markdown links.
     *
     * Format: MD_ATTACH_LINK~~filename...~~text...~~END → [text](#attachment:filename)
     */
    .replace(
      /MD(?:\\)?_ATTACH(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, filenameEnc, textEnc) => {
        const filename = decodeURIComponent(String(filenameEnc || ""));
        const linkText = decodeURIComponent(String(textEnc || ""));
        return `[${linkText}](#attachment:${filename})`;
      },
    )
    /**
     * Convert URL link tokens to markdown links.
     *
     * Format: MD_URL_LINK~~url...~~text...~~END → [text](url)
     */
    .replace(
      /MD(?:\\)?_URL(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, urlEnc, textEnc) => {
        const url = decodeURIComponent(String(urlEnc || ""));
        const linkText = decodeURIComponent(String(textEnc || ""));
        return `[${linkText}](${url})`;
      },
    )

    .replace(
      /MD(?:\\)?_PANEL\(([^,)]*),([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, colorEnc, iconEnc, bodyEnc) => {
        const color = decodeURIComponent(String(colorEnc || "")) || "info";
        const icon = decodeURIComponent(String(iconEnc || "")) || color;
        const innerHtml = decodeURIComponent(String(bodyEnc || ""));
        const innerMd = unescapeMarkdownUnderscores(
          decodeMdCommentTokens(turndown.turndown(innerHtml || "")),
        );
        const lines = innerMd.split(/\r?\n/);
        const outLines: string[] = [`> <!-- panel:${color}:${icon} -->`];
        for (const l of lines) {
          outLines.push(l.trim().length ? `> ${l}` : ">");
        }
        return outLines.join("\n");
      },
    )
    .replace(
      /MD(?:\\)?_STATUS\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, colorEnc, titleEnc) => {
        const color = decodeURIComponent(String(colorEnc || "")) || "grey";
        const title = decodeURIComponent(String(titleEnc || "")) || "Status";
        return `<!-- status:${color}:${title} -->`;
      },
    )
    .replace(
      /MD(?:\\)?_IMAGE\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, refEnc, capEnc) => {
        const ref = decodeURIComponent(String(refEnc || ""));
        const cap = decodeURIComponent(String(capEnc || ""));
        const src = ref.startsWith("attach:") ? `#${ref.slice(7)}` : ref;
        // Prefer single-line markdown image with caption in alt text, no trailing caption line
        return `![${cap || ""}](${src})`;
      },
    )
    .replace(
      /MD(?:\\)?_MENTION\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, idEnc, visEnc) => {
        const id = decodeURIComponent(String(idEnc || ""));
        const vis = decodeURIComponent(String(visEnc || ""));
        const label = vis || id;
        // Emit single mention tag in requested format
        return `<!-- mention:${id} ${label} -->`;
      },
    )
    // Emit code blocks using fenced style ```lang\n...\n```
    .replace(
      /MD(?:\\)?_CODE\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, langEnc, bodyEnc) => {
        const lang = decodeURIComponent(String(langEnc || ""));
        const body = decodeURIComponent(String(bodyEnc || ""));
        const fence = `\`\`\`${lang ? String(lang) : ""}`;
        return `${fence}\n${body}\n\`\`\``;
      },
    );

  // Normalize spacing around comment wrappers so they don't glue to words
  // Use [ \t] instead of \s to avoid collapsing newlines (e.g. in panel output)
  out = out
    .replace(/(\S)<!--[ \t]*comment:/g, "$1 <!-- comment:")
    .replace(/(\S)<!--[ \t]*commend-end:/g, "$1 <!-- commend-end:")
    .replace(/-->[ \t]*(\S)/g, "--> $1");

  // Mermaid diagram tokens → fenced mermaid block (after spacing normalization
  // to avoid mangling decoded content like -->> in sequence diagrams)
  out = out.replace(
    /MD(?:\\)?_MERMAID\(([A-Za-z0-9+/=]+)\)/g,
    (_m, encoded) => {
      const code = Buffer.from(String(encoded), "base64").toString("utf8");
      return `\`\`\`mermaid\n${code}\n\`\`\``;
    },
  );

  return out;
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
  // Step 3: for asterisks, collapse multiple backslashes before '*' to a single backslash (avoid multiplying on round-trips)
  out = out.replace(/\\{2,}\*/g, "\\*");
  /**
   * Step 4: unescape numbered enumerations with periods.
   *
   * Why: Turndown may escape dots after numbers (e.g., `1\.`) to prevent
   * unintended list interpretation. We unescape these in two contexts:
   * - At start of line for numbered lists: `1\. Item` → `1. Item`
   * - After header markers: `# 1\. Header` → `# 1. Header`
   */
  out = out.replace(/^(\s*\d+)\\\./gm, "$1.");
  out = out.replace(/^(#{1,6}\s+\d+)\\\./gm, "$1.");
  // Step 5: inside code regions (inline `code` and fenced ``` blocks), remove escapes before '*'
  out = unescapeAsterisksInsideCode(out);
  return out;
}

/**
 * Remove escapes for asterisks inside markdown code regions.
 * Why: In code (inline or fenced), '*' is literal and does not need escaping; keeping
 * backslashes creates noisy round-trips where they accumulate.
 */
function unescapeAsterisksInsideCode(markdown: string): string {
  let processed = markdown;
  // Fenced code blocks ```lang?\n...\n```
  processed = processed.replace(/```[^\n]*\n[\s\S]*?```/g, (block) => {
    const m = block.match(/^(```[^\n]*\n)([\s\S]*?)(\n```)?$/);
    if (!m) {
      return block.replace(/\\\*/g, "*");
    }
    const prefix = m[1] || "";
    const body = m[2] || "";
    const suffix = m[3] || "";
    const normalizedBody = body.replace(/\\\*/g, "*");
    return prefix + normalizedBody + suffix;
  });
  // Inline code `...`
  processed = processed.replace(/`[^`]*`/g, (span) =>
    span.replace(/\\\*/g, "*"),
  );
  return processed;
}

function replaceTableTokens(markdown: string, tables: string[]): string {
  return markdown.replace(/MD(?:\\)?_TABLE\((\d+)\)/g, (_m, num) => {
    const i = Number(num);
    const html = tables[i] || "";
    const { document } = parseHTML(html);
    const table = document.querySelector("table") as Element | null;
    if (!table) {
      return "";
    }
    return `\n${renderTableMarkdown(table)}\n`;
  });
}

function _collapseBrokenTableArtifacts(markdown: string): string {
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
          if (!/^\s*$/.test(lines[k] || "")) {
            buf.push(String(lines[k]));
          }
          k++;
        }
        if (k >= lines.length) {
          break;
        }
        const cell = buf.join(" ").replace(/\s+/g, " ").trim();
        cells.push(cell);
        j = k; // move to next '|'
      }
      if (cells.length >= 2) {
        out.push(`| ${cells.join(" | ")} |`);
        i = j; // skip consumed up to last '|'
        continue;
      }
    }
    out.push(lines[i] || "");
  }
  return out.join("\n");
}

function _buildMarkdownFromDom(root: Element): string {
  const parts: string[] = [];
  const nodes = Array.from((root as any).childNodes || []);
  for (const node of nodes as any[]) {
    if (!node) {
      continue;
    }
    if (node.nodeType === 1) {
      const el = node as Element;
      const macro = (el as any).getAttribute?.("data-confluence-macro");
      if (macro) {
        parts.push(`<!-- widget:${String(macro)} -->`);
        continue;
      }
      if (String((el as any).tagName || "").toLowerCase() === "table") {
        parts.push(renderTableMarkdown(el));
        continue;
      }
      const tableDesc = (el as any).querySelector
        ? (el as any).querySelector("table")
        : null;
      if (tableDesc) {
        parts.push(renderTableMarkdown(tableDesc as Element));
        continue;
      }
      const md = unescapeMarkdownUnderscores(
        decodeMdCommentTokens(
          turndown.turndown(
            (el as any).outerHTML || (el as any).textContent || "",
          ),
        ),
      );
      if (md.trim()) {
        parts.push(md.trim());
      }
      continue;
    }
    if (node.nodeType === 3) {
      const t = String((node as any).textContent || "").trim();
      if (t) {
        parts.push(t);
      }
    }
  }
  return unescapeMarkdownUnderscores(parts.join("\n\n"));
}
