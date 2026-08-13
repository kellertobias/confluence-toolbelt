/**
 * Normalize Confluence storage HTML into DOM-friendly form with durable tokens.
 *
 * The goal is to replace Confluence-specific XML tags (`<ac:*>`, `<ri:*>`,
 * structured-macros, inline comment markers, etc.) with plain-text
 * `MD_*` tokens or regular HTML so that:
 *
 *   1. `linkedom` can parse the body without choking on unknown namespaces.
 *   2. Turndown won't mangle/escape the embedded structured information.
 *
 * The tokens are later decoded back into markdown by `decodeMdCommentTokens`.
 */

import { utf8ToBase64 } from "../core/b64.js";
import {
  encodeExpandTitle,
  findExpandMacros,
  isInternalExpandTitle,
} from "./expand-macro.js";
import { decodeBasicEntities } from "./html-utils.js";

export function normalizeMacros(html: string): string {
  let out = html;

  out = unwrapListItemParagraphs(out);

  // Inline Status macro → durable token with color/title.
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
      return `MD_STATUS(${encodeURIComponent(color)})[${encodeURIComponent(title)}]`;
    },
  );

  // Inline Jira issue macro → durable link token.
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']jira["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, inner) => {
      const keyParam = inner.match(
        /<ac:parameter[^>]*\bac:name=["']key["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
      );
      const key = (keyParam?.[1] || "").replace(/<[^>]+>/g, "").trim();
      if (!key) return "";
      return `MD_JIRA_LINK~~${encodeURIComponent(key)}~~END`;
    },
  );

  /**
   * Convert Confluence `<ac:link>` elements to tokens or markdown.
   *
   * Why: Confluence uses `<ac:link>` for various link types: user mentions,
   * page links, attachment links, and external URLs. We preserve them during
   * markdown conversion and restore them on upload.
   */
  out = out.replace(/<ac:link\b[^>]*>([\s\S]*?)<\/ac:link>/gi, (m, inner) =>
    convertAcLink(m, String(inner || "")),
  );

  // Info / Note / Warning / Tip / Panel macros → MD_PANEL token with color/icon
  // and body. Nesting-aware (see `replacePanelMacros`).
  out = replacePanelMacros(out);

  // ADF panels (`<ac:adf-extension><ac:adf-node type="panel">`), the shape the
  // current Confluence editor writes → the same MD_PANEL token.
  out = replaceAdfExtensions(out);

  // Legacy mermaid: comment with base64 source + mermaid.ink image → fenced
  // block token.
  out = out.replace(
    /<!--\s*mermaid:([A-Za-z0-9+/=]+)\s*-->\s*<ac:image\b[^>]*>[\s\S]*?<\/ac:image>/gi,
    (_m, encoded) => `MD_MERMAID(${encoded})`,
  );
  // Deflist config: table immediately followed by an expand macro whose title
  // is "deflist-config" → re-inject data-deflist-* attributes and consume the
  // macro. This round-trips the deflist metadata that Confluence strips from
  // custom data-* attributes on save.
  out = out.replace(
    /(<table\b[^>]*>[\s\S]*?<\/table>)\s*<ac:structured-macro\b[^>]*\bac:name=["']expand["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (fullMatch, tableHtml: string, macroInner: string) => {
      const title = (
        macroInner.match(
          /<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim();

      if (title === "req-table") {
        return tableHtml.replace(/^<table\b/, '<table data-req-table="true"');
      }

      if (title === "deflist-config") {
        const body = (
          macroInner.match(
            /<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i,
          )?.[1] || ""
        )
          .replace(/<[^>]+>/g, "")
          .trim();
        // body format: "KEYWORD:Col1,Col2"
        const colonIdx = body.indexOf(":");
        if (colonIdx < 0) return fullMatch;
        const keyword = body.slice(0, colonIdx).trim();
        const columnsStr = body.slice(colonIdx + 1).trim();
        return tableHtml.replace(
          /^<table\b/,
          `<table data-deflist="true" data-deflist-keyword="${keyword}" data-deflist-columns="${columnsStr}"`,
        );
      }

      if (title === "list-table-config") {
        const body = (
          macroInner.match(
            /<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i,
          )?.[1] || ""
        )
          .replace(/<[^>]+>/g, "")
          .trim();
        // body format: "key:Header,key2:Header2|spacing1,spacing2" or "key:Header,key2:Header2"
        const pipeIdx = body.indexOf("|");
        const configPart = pipeIdx >= 0 ? body.slice(0, pipeIdx).trim() : body;
        const spacingPart = pipeIdx >= 0 ? body.slice(pipeIdx + 1).trim() : "";
        let attrs = `data-list-table="true" data-list-table-config="${configPart}"`;
        if (spacingPart) {
          attrs += ` data-list-table-spacing="${spacingPart}"`;
        }
        return tableHtml.replace(/^<table\b/, `<table ${attrs}`);
      }

      return fullMatch;
    },
  );

  // Footnotes config: ordered list immediately followed by an expand macro
  // whose title is "footnotes-config" → re-inject data-footnotes="true" and,
  // defensively, per-<li> id="fn-..." attributes (in case Confluence stripped
  // them along with any data-* attributes). This round-trips the footnote
  // ids the upload path needs to reconstruct `[^id]: ...` definitions.
  out = out.replace(
    /(<ol\b[^>]*>[\s\S]*?<\/ol>)\s*<ac:structured-macro\b[^>]*\bac:name=["']expand["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (fullMatch, olHtml: string, macroInner: string) => {
      const title = (
        macroInner.match(
          /<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim();

      if (title !== "footnotes-config") {
        return fullMatch;
      }

      const body = (
        macroInner.match(
          /<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i,
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim();
      const ids = body
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      let rewritten = olHtml.replace(/^<ol\b/, '<ol data-footnotes="true"');
      let idx = 0;
      rewritten = rewritten.replace(/<li\b([^>]*)>/gi, (liMatch, attrs) => {
        if (/\bid=/i.test(attrs)) {
          idx++;
          return liMatch; // id survived — keep it as-is.
        }
        const id = ids[idx++];
        return id ? `<li id="fn-${id}"${attrs}>` : liMatch;
      });
      return rewritten;
    },
  );

  // User-authored expand macros → paired marker tokens. Runs after the
  // config-carrying expands above have been consumed by their own normalizers
  // and skips anything the tool wrote itself (see `isInternalExpandTitle`), so
  // the mermaid handler below still sees its own macros untouched.
  out = normalizeExpandMacros(out);

  // New mermaid: expand macro with "Mermaid" in title → extract source as
  // MD_MERMAID token.
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
      return `MD_MERMAID(${utf8ToBase64(code)})`;
    },
  );
  // Suppress orphaned mermaid.ink images (source already captured above).
  out = out.replace(
    /<ac:image\b[^>]*>[\s\S]*?mermaid\.ink[\s\S]*?<\/ac:image>/gi,
    "",
  );

  // Images with optional captions → durable token preserving URL/filename and
  // caption.
  out = out.replace(
    /<ac:image\b[^>]*>([\s\S]*?)<\/ac:image>/gi,
    (original, inner) => {
      const innerStr = String(inner || "");
      const url =
        innerStr.match(/<ri:url[^>]*\bri:value=["']([^"']+)["'][^>]*>/i)?.[1] ||
        "";
      const filename =
        innerStr.match(
          /<ri:attachment[^>]*\bri:filename=["']([^"']+)["'][^>]*>/i,
        )?.[1] || "";
      const capInner =
        innerStr.match(/<ac:caption[^>]*>([\s\S]*?)<\/ac:caption>/i)?.[1] || "";
      // The caption is a plain-text slot inside `![…](…)`. Earlier passes may
      // have left durable tokens in it (a status lozenge inside a caption is
      // common), and an unflattened token drags `[`/`]` into the alt text,
      // which breaks the image link outright — including the embed rewrite the
      // attachment downloader keys off. Flatten to visible text.
      const caption = flattenTokensToText(capInner.replace(/<[^>]+>/g, ""));
      const ref = url || (filename ? `attach:${filename}` : "");
      if (!ref) {
        return original; // leave unchanged if no recognizable ref
      }
      return `MD_IMAGE(${encodeURIComponent(ref)})[${encodeURIComponent(caption)}]`;
    },
  );

  // Convert Confluence code macro to a durable MD_CODE token so we can emit
  // fenced code blocks later in markdown. We encode language and body to
  // avoid HTML entity / DOM parsing side effects.
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']code["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, inner) => {
      const langParam = inner.match(
        /<ac:parameter[^>]*\bac:name=["']language["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
      );
      const lang = (langParam?.[1] || "").replace(/<[^>]+>/g, "").trim();
      const bodyMatch = inner.match(
        /<ac:plain-text-body[^>]*>([\s\S]*?)<\/ac:plain-text-body>/i,
      );
      let body = bodyMatch?.[1] || "";
      const cdata = body.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
      if (cdata) {
        body = cdata[1] || "";
      } else {
        body = decodeBasicEntities(body);
      }
      return `MD_CODE(${encodeURIComponent(lang)})[${encodeURIComponent(body)}]`;
    },
  );

  // TOC macro → durable token so position is preserved through turndown.
  // Self-closing form MUST be handled first to prevent the open/close pattern
  // from greedily matching through the `/>` and consuming sibling content up
  // to the next unrelated `</ac:structured-macro>` closing tag.
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']toc["'][^>]*\/>/gi,
    () => "MD_WIDGET(toc)",
  );
  // Non-self-closing form (with explicit open/close tags).
  out = out.replace(
    /<ac:structured-macro\b[^>]*\bac:name=["']toc["'][^>]*>[\s\S]*?<\/ac:structured-macro>/gi,
    () => "MD_WIDGET(toc)",
  );

  // Inline comment markers → durable tokens preserving the ref id. Handle both
  // structured-macro and inline element forms.
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
      return `MD_CMT_END(${encodeURIComponent(ref)})`;
    },
  );
  // Paired inline form: `<ac:inline-comment-marker ac:ref="...">TEXT</...>`.
  out = out.replace(
    /<ac:inline-comment-marker[^>]*\bac:ref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/ac:inline-comment-marker>/gi,
    (_m, ref, inner) => {
      const enc = encodeURIComponent(String(ref || ""));
      return `MD_CMT_START(${enc})${inner}MD_CMT_END(${enc})`;
    },
  );
  // Self-closing / opening forms.
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

  // Inline user mentions via `<ac:atlassian-user ac:account-id="..."/>`,
  // processed before the generic ac:* stripping below.
  out = out.replace(/<ac:atlassian-user\b[^>]*>/gi, (m) => {
    const acc = m.match(/ac:account-id=["']([^"']+)["']/i)?.[1] || "";
    return `MD_MENTION(${encodeURIComponent(acc)})[]`;
  });

  // Unwrap any remaining Confluence ac:* tags by dropping wrappers while
  // keeping inner content.
  out = out.replace(/<ac:[^>]+>/gi, "");
  out = out.replace(/<\/ac:[^>]+>/gi, "");

  // For other macros, unwrap the rich-text-body so inner content is preserved.
  out = out.replace(
    /<ac:structured-macro\b[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
    (_m, inner) => {
      const body = inner.match(
        /<ac:rich-text-body[^>]*>([\s\S]*?)<\/ac:rich-text-body>/i,
      );
      return body ? body[1] : inner;
    },
  );

  // Encode HTML comments as inline tokens so textContent retains them through
  // DOM parsing.
  out = out.replace(
    /<!--\s*([\s\S]*?)\s*-->/g,
    (_m, inner) => `MD_COMMENT(${encodeURIComponent(String(inner))})`,
  );
  return out;
}

/**
 * Replace user-authored expand macros with `MD_EXPAND_START` / `MD_EXPAND_END`
 * marker paragraphs, leaving the macro's body in place so every block inside it
 * keeps going through the normal pipeline (tables reach `renderTableMarkdown`,
 * code macros become `MD_CODE` tokens, and so on).
 *
 * Only expands whose ancestors are all expands are converted — one inside a
 * table cell or a panel body is consumed by that renderer instead and is
 * reported by `detectUnsupportedFeatures`. Replacement runs back to front so
 * earlier offsets stay valid, and recurses into each body to pick up nesting.
 */
function normalizeExpandMacros(html: string): string {
  const macros = findExpandMacros(html).filter(
    (macro) =>
      macro.ancestors.length === 0 && !isInternalExpandTitle(macro.title),
  );
  let out = html;
  for (let i = macros.length - 1; i >= 0; i--) {
    const macro = macros[i];
    if (!macro) {
      continue;
    }
    const inner = normalizeExpandMacros(macro.body);
    const replacement =
      `<p>MD_EXPAND_START(${encodeExpandTitle(macro.title)})</p>` +
      inner +
      `<p>MD_EXPAND_END()</p>`;
    out = out.slice(0, macro.start) + replacement + out.slice(macro.end);
  }
  return out;
}

/**
 * Unwrap the single `<p>` Confluence puts inside every `<li>`.
 *
 * Confluence stores list items as `<li><p>text</p></li>`. Turndown reads that
 * paragraph as a block and separates the items with a blank line, so a plain
 * three-item list comes out as a "loose" list padded with empty lines — hard to
 * read, and not how Confluence renders it. Dropping the wrapper paragraph gives
 * a tight list.
 *
 * Only the item's *first* paragraph is unwrapped: an item that genuinely has
 * two paragraphs still needs the blank line between them.
 */
function unwrapListItemParagraphs(html: string): string {
  return html.replace(
    /(<li\b[^>]*>)\s*<p\b[^>]*>([\s\S]*?)<\/p>\s*/gi,
    (_m, li: string, inner: string) => `${li}${inner}`,
  );
}

// ---------------------------------------------------------------------------
// Nesting-aware element scanning
// ---------------------------------------------------------------------------

/**
 * Find the close tag matching an already-consumed opening `<tag …>`, honouring
 * nested elements of the same name.
 *
 * Why this exists: Confluence nests structured macros freely — a code block or
 * another panel inside an info panel is ordinary. A non-greedy
 * `<ac:structured-macro …>([\s\S]*?)</ac:structured-macro>` stops at the *inner*
 * close tag, so the outer macro's body is truncated (and everything after it
 * leaks into the document as stray text).
 *
 * `from` is the index of the first character of the element's content.
 */
function matchClose(
  html: string,
  from: number,
  tag: string,
): { contentEnd: number; after: number } | null {
  const re = new RegExp(`<${tag}\\b[^>]*?(\\/?)>|<\\/${tag}\\s*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) {
        return { contentEnd: m.index, after: re.lastIndex };
      }
    } else if (m[1] !== "/") {
      depth++;
    }
  }
  return null;
}

/** First `<tag …>…</tag>` element in `html`, with nesting honoured. */
function firstElement(
  html: string,
  tag: string,
): { attrs: string; content: string; start: number; after: number } | null {
  const open = new RegExp(`<${tag}\\b([^>]*?)(\\/?)>`, "i").exec(html);
  if (!open) {
    return null;
  }
  const start = open.index;
  const from = start + open[0].length;
  const attrs = open[1] ?? "";
  if (open[2] === "/") {
    return { attrs, content: "", start, after: from };
  }
  const span = matchClose(html, from, tag);
  return span
    ? { attrs, content: html.slice(from, span.contentEnd), start, after: span.after }
    : { attrs, content: html.slice(from), start, after: html.length };
}

/** Body of the (outermost) `<ac:rich-text-body>` inside a macro's markup. */
function richTextBody(inner: string): { params: string; body: string } {
  const el = firstElement(inner, "ac:rich-text-body");
  if (!el) {
    return { params: inner, body: "" };
  }
  return { params: inner.slice(0, el.start), body: el.content };
}

/**
 * Build an MD_PANEL token. The body is normalized recursively so macros nested
 * inside the panel (code blocks, images, inline comment markers, further
 * panels) become durable tokens too — otherwise they reach the decode step as
 * raw `<ac:…>` markup, which the DOM/Turndown pass silently drops.
 */
function panelToken(color: string, icon: string, body: string): string {
  return `MD_PANEL(${encodeURIComponent(color)},${encodeURIComponent(icon)})[${encodeURIComponent(normalizeMacros(body))}]`;
}

/** Info/note/warning/tip/success/error/panel macros → MD_PANEL, nesting-aware. */
function replacePanelMacros(html: string): string {
  const open =
    /<ac:structured-macro\b[^>]*\bac:name=["'](info|note|warning|tip|success|error|panel)["'][^>]*?(\/?)>/gi;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    out += html.slice(cursor, m.index);
    const macro = String(m[1] || "").toLowerCase();
    if (m[2] === "/") {
      out += panelToken(macro, macro, "");
      cursor = open.lastIndex;
      continue;
    }
    const span = matchClose(html, open.lastIndex, "ac:structured-macro");
    if (!span) {
      out += m[0];
      cursor = open.lastIndex;
      continue;
    }
    const inner = html.slice(open.lastIndex, span.contentEnd);
    const { params, body } = richTextBody(inner);
    let color = macro;
    let icon = macro;
    if (macro === "panel") {
      const bg =
        params.match(
          /<ac:parameter[^>]*\bac:name=["']bgColor["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
        )?.[1] || "";
      color = bg.replace(/<[^>]+>/g, "").trim() || "panel";
      icon = "panel";
    }
    out += panelToken(color, icon, body);
    cursor = span.after;
    open.lastIndex = cursor;
  }
  return out + html.slice(cursor);
}

/** ADF panel types the editor emits, mapped onto our panel colors. */
const ADF_PANEL_TYPES = new Set([
  "info",
  "note",
  "warning",
  "tip",
  "success",
  "error",
]);

/**
 * Convert `<ac:adf-extension>` wrappers, the shape the current Confluence
 * editor stores panels in:
 *
 *   <ac:adf-extension>
 *     <ac:adf-node type="panel">
 *       <ac:adf-attribute key="panel-type">note</ac:adf-attribute>
 *       <ac:adf-content>…</ac:adf-content>
 *     </ac:adf-node>
 *     <ac:adf-fallback>…rendered HTML…</ac:adf-fallback>
 *   </ac:adf-extension>
 *
 * Without this the generic `<ac:…>` unwrapping further down leaves the
 * attribute *values* behind as body text (`note93a79b2c2404`) and emits the
 * content twice — once from the node and once from the fallback.
 */
function replaceAdfExtensions(html: string): string {
  const open = /<ac:adf-extension\b[^>]*?(\/?)>/gi;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    out += html.slice(cursor, m.index);
    if (m[1] === "/") {
      cursor = open.lastIndex;
      continue;
    }
    const span = matchClose(html, open.lastIndex, "ac:adf-extension");
    if (!span) {
      out += m[0];
      cursor = open.lastIndex;
      continue;
    }
    out += convertAdfExtension(html.slice(open.lastIndex, span.contentEnd));
    cursor = span.after;
    open.lastIndex = cursor;
  }
  return out + html.slice(cursor);
}

function convertAdfExtension(inner: string): string {
  const node = firstElement(inner, "ac:adf-node");
  const fallback = firstElement(inner, "ac:adf-fallback");
  const type = (node?.attrs.match(/\btype=["']([^"']+)["']/i)?.[1] || "")
    .trim()
    .toLowerCase();

  if (node && type === "panel") {
    const content = firstElement(node.content, "ac:adf-content")?.content ?? "";
    const attr = (key: string) =>
      (
        node.content.match(
          new RegExp(
            `<ac:adf-attribute\\b[^>]*\\bkey=["']${key}["'][^>]*>([\\s\\S]*?)<\\/ac:adf-attribute>`,
            "i",
          ),
        )?.[1] || ""
      )
        .replace(/<[^>]+>/g, "")
        .trim()
        .toLowerCase();
    const panelType = attr("panel-type");
    const color = ADF_PANEL_TYPES.has(panelType)
      ? panelType
      : attr("panel-color") || "info";
    const icon = ADF_PANEL_TYPES.has(panelType) ? panelType : "panel";
    return panelToken(color, icon, content);
  }

  // Unknown extension: prefer Confluence's own rendered fallback, which is
  // plain HTML we can convert, over the ADF node's attribute soup.
  if (fallback) {
    return normalizeMacros(fallback.content);
  }
  const content = node
    ? (firstElement(node.content, "ac:adf-content")?.content ?? "")
    : inner;
  return normalizeMacros(content);
}

/**
 * Flatten durable tokens down to their visible text for plain-text slots such
 * as image captions, and drop the brackets that would otherwise terminate the
 * enclosing markdown construct early.
 *
 * Lossy by design: an inline macro inside a caption survives as its label, not
 * as a macro. The alternative — leaking `MD_STATUS(yellow)[MVP]` into the alt
 * text — breaks the image link itself.
 */
function flattenTokensToText(s: string): string {
  return s
    .replace(/MD_STATUS\(([^)]*)\)\[([\s\S]*?)\]/g, (_m, _c, t) =>
      decodeURIComponent(String(t || "")),
    )
    .replace(
      /MD_MENTION\(([^)]*)\)\[([\s\S]*?)\]/g,
      (_m, id, vis) =>
        decodeURIComponent(String(vis || "")) ||
        decodeURIComponent(String(id || "")),
    )
    .replace(/MD_JIRA_LINK~~([^~]+)~~END/g, (_m, k) =>
      decodeURIComponent(String(k || "")),
    )
    .replace(/MD_(?:PAGE|ATTACH|URL)_LINK~~[^~]+~~([^~]+)~~END/g, (_m, t) =>
      decodeURIComponent(String(t || "")),
    )
    .replace(/MD_COMMENT\([^)]*\)/g, "")
    .replace(/MD_CMT_(?:START|END)\([^)]*\)/g, "")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convert a single `<ac:link>` element into a durable token (or leave
 * untouched if the link type is unknown).
 */
function convertAcLink(original: string, innerStr: string): string {
  // User mentions → durable token
  if (/<ri:user[^>]*>/i.test(innerStr)) {
    const acc =
      innerStr.match(/ri:account-id=["']([^"']+)["']/i)?.[1] ||
      innerStr.match(/ri:userkey=["']([^"']+)["']/i)?.[1] ||
      innerStr.match(/ri:username=["']([^"']+)["']/i)?.[1] ||
      "";
    const visible = innerStr.replace(/<[^>]+>/g, "").trim();
    return `MD_MENTION(${encodeURIComponent(acc)})[${encodeURIComponent(visible)}]`;
  }

  // Content entity links (by page ID) → token
  if (/<ri:content-entity[^>]*>/i.test(innerStr)) {
    const contentId =
      innerStr.match(/ri:content-id=["']([^"']+)["']/i)?.[1] || "";
    const linkText = extractLinkBody(innerStr) || contentId;
    const pageRef = `pageid:${contentId}`;
    return `MD_PAGE_LINK~~${encodeURIComponent(pageRef)}~~${encodeURIComponent(linkText)}~~END`;
  }

  // Page links by title (or by resolved content-id) → token.
  // Confluence may return either ri:content-title (when stored by title) or
  // ri:content-id (when the title reference was resolved on save). Both can
  // appear alongside ri:space-key.
  if (/<ri:page[^>]*>/i.test(innerStr)) {
    const contentTitle =
      innerStr.match(/ri:content-title=["']([^"']+)["']/i)?.[1] || "";
    const contentId =
      innerStr.match(/ri:content-id=["']([^"']+)["']/i)?.[1] || "";
    const spaceKey =
      innerStr.match(/ri:space-key=["']([^"']+)["']/i)?.[1] || "";
    const linkText = extractLinkBody(innerStr) || contentTitle || contentId;
    // When we have a numeric content-id with space, emit the stable pageid:SPACE:ID format.
    // Title-only refs still use page: and will be resolved downstream.
    let pageRef: string;
    if (contentId && spaceKey) {
      pageRef = `pageid:${spaceKey}:${contentId}`;
    } else if (contentTitle && spaceKey) {
      pageRef = `page:${spaceKey}:${contentTitle}`;
    } else {
      pageRef = `page:${contentTitle || contentId}`;
    }
    return `MD_PAGE_LINK~~${encodeURIComponent(pageRef)}~~${encodeURIComponent(linkText)}~~END`;
  }

  // Attachment links → token
  if (/<ri:attachment[^>]*>/i.test(innerStr)) {
    const filename =
      innerStr.match(/ri:filename=["']([^"']+)["']/i)?.[1] || "";
    const linkText = extractLinkBody(innerStr) || filename;
    return `MD_ATTACH_LINK~~${encodeURIComponent(filename)}~~${encodeURIComponent(linkText)}~~END`;
  }

  // URL links → token
  if (/<ri:url[^>]*>/i.test(innerStr)) {
    const url = innerStr.match(/ri:value=["']([^"']+)["']/i)?.[1] || "";
    const linkText = extractLinkBody(innerStr) || url;
    return `MD_URL_LINK~~${encodeURIComponent(url)}~~${encodeURIComponent(linkText)}~~END`;
  }

  return original;
}

function extractLinkBody(innerStr: string): string {
  const linkBodyMatch =
    innerStr.match(
      /<ac:plain-text-link-body[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:plain-text-link-body>/i,
    ) || innerStr.match(/<ac:link-body[^>]*>([\s\S]*?)<\/ac:link-body>/i);
  return (linkBodyMatch?.[1] || "").replace(/<[^>]+>/g, "").trim();
}
