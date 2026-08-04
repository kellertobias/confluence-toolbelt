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
  // and body.
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
      return `MD_PANEL(${encodeURIComponent(color)},${encodeURIComponent(icon)})[${encodeURIComponent(body)}]`;
    },
  );

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
      const caption = capInner.replace(/<[^>]+>/g, "").trim();
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
