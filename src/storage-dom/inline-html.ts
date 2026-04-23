/**
 * Minimal inline-markdown to Confluence-storage-HTML converter.
 *
 * Handles the subset of inline features we emit ourselves: code spans, bold,
 * inline images (converted to `<ac:image>`), and links (with Confluence-aware
 * handling of `page:`, `pageid:`, and `#attachment:` schemes).
 */

import { decodeBasicEntities, escapeHtml } from "./html-utils.js";

export function inlineHtml(s: string): string {
  // Protect escaped asterisks so they remain literal and are not interpreted
  // as formatting. We swap them with a durable token during processing and
  // restore at the end.
  let out = String(s).replace(/\\\*/g, "MD_ESC_STAR");
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

  // Code spans — stash contents behind placeholders so stray `*` inside code
  // can't be picked up by the bold/italic regexes below.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, inner) => {
    const idx = codeSpans.push(String(inner)) - 1;
    return `MD_CODE_SPAN_${idx}_END`;
  });

  // Bold
  out = out.replace(
    /\*\*([^*]+)\*\*/g,
    (_m, inner) => `<strong>${inner}</strong>`,
  );

  /**
   * Italic via single asterisks.
   *
   * Rules (pragmatic subset of CommonMark, enough to cover real-world notes):
   * - The opening `*` must not be immediately followed by whitespace.
   * - The closing `*` must not be immediately preceded by whitespace.
   * - The span may not cross a newline.
   * - The inner text may not contain another `*` (so bold has already been
   *   handled above and can't be eaten again here).
   *
   * This is deliberately placed before link conversion: that way a link
   * wrapped entirely in italics (e.g. `*see [text](pageid:...)*`) is first
   * wrapped in `<em>`, and the link regex then replaces the `[text](...)`
   * inside the `<em>` to produce `<em>see <ac:link>...</ac:link></em>`.
   */
  out = out.replace(
    /\*(?!\s)([^*\n]+?)(?<!\s)\*/g,
    (_m, inner) => `<em>${inner}</em>`,
  );

  /**
   * Convert markdown links to appropriate Confluence storage format.
   *
   * Why: Different link types in Confluence use different storage formats.
   * We detect special schemes (page:, pageid:, #attachment:) and convert them
   * to the appropriate Confluence <ac:link> format, falling back to <a href>
   * for regular URLs.
   */
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const hrefStr = String(href || "");

    // Page links by ID: [text](pageid:12345) or [text](pageid:SPACE:12345)
    if (hrefStr.startsWith("pageid:")) {
      const rest = hrefStr.slice(7);
      const plainText = decodeBasicEntities(String(text));
      const colonIdx = rest.indexOf(":");
      // pageid:SPACE:ID → ri:page with space-key + content-id
      if (colonIdx > 0) {
        const spaceKey = rest.slice(0, colonIdx);
        const contentId = rest.slice(colonIdx + 1);
        return `<ac:link><ri:page ri:space-key="${escapeHtml(spaceKey)}" ri:content-id="${escapeHtml(contentId)}"/><ac:plain-text-link-body><![CDATA[${plainText}]]></ac:plain-text-link-body></ac:link>`;
      }
      // pageid:ID → ri:content-entity (no space info)
      return `<ac:link><ri:content-entity ri:content-id="${escapeHtml(rest)}"/><ac:plain-text-link-body><![CDATA[${plainText}]]></ac:plain-text-link-body></ac:link>`;
    }

    // Page links by title or ID: [text](page:PageTitle) or [text](page:SPACE:PageTitle).
    // When the third segment is all-numeric it is treated as a page ID and
    // stored as a content-entity (rename-proof). The space key is dropped
    // because ri:content-entity has no space-key attribute; users who need
    // a space-qualified ID link should use the pageid: scheme instead.
    if (hrefStr.startsWith("page:")) {
      const pageRef = hrefStr.slice(5);
      const parts = pageRef.split(":");
      const plainText = decodeBasicEntities(String(text));
      if (parts.length >= 2 && parts[0]) {
        const spaceKey = parts[0];
        const titleOrId = parts.slice(1).join(":");
        if (/^\d+$/.test(titleOrId)) {
          return `<ac:link><ri:page ri:space-key="${escapeHtml(spaceKey)}" ri:content-id="${escapeHtml(titleOrId)}"/><ac:plain-text-link-body><![CDATA[${plainText}]]></ac:plain-text-link-body></ac:link>`;
        }
        return `<ac:link><ri:page ri:space-key="${escapeHtml(spaceKey)}" ri:content-title="${escapeHtml(titleOrId)}"/><ac:plain-text-link-body><![CDATA[${plainText}]]></ac:plain-text-link-body></ac:link>`;
      }
      return `<ac:link><ri:page ri:content-title="${escapeHtml(pageRef)}"/><ac:plain-text-link-body><![CDATA[${plainText}]]></ac:plain-text-link-body></ac:link>`;
    }

    // Attachment links: [text](#attachment:filename.pdf)
    if (hrefStr.startsWith("#attachment:")) {
      const filename = hrefStr.slice(12);
      const plainText = decodeBasicEntities(String(text));
      return `<ac:link><ri:attachment ri:filename="${escapeHtml(filename)}"/><ac:plain-text-link-body><![CDATA[${plainText}]]></ac:plain-text-link-body></ac:link>`;
    }

    return `<a href="${escapeHtml(hrefStr)}">${text}</a>`;
  });

  // Restore code spans that were stashed before bold/italic processing.
  out = out.replace(
    /MD_CODE_SPAN_(\d+)_END/g,
    (_m, idx) => `<code>${codeSpans[Number(idx)] || ""}</code>`,
  );

  // Restore literal asterisks
  out = out.replace(/MD_ESC_STAR/g, "*");
  return out;
}
