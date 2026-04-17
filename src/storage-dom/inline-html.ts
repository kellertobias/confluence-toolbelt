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
   * We detect special schemes (page:, pageid:, #attachment:) and convert them
   * to the appropriate Confluence <ac:link> format, falling back to <a href>
   * for regular URLs.
   */
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const hrefStr = String(href || "");

    // Page links by ID: [text](pageid:12345) — cross-space, rename-proof
    if (hrefStr.startsWith("pageid:")) {
      const contentId = hrefStr.slice(7);
      const plainText = decodeBasicEntities(String(text));
      return `<ac:link><ri:content-entity ri:content-id="${escapeHtml(contentId)}"/><ac:plain-text-link-body><![CDATA[${plainText}]]></ac:plain-text-link-body></ac:link>`;
    }

    // Page links by title: [text](page:PageTitle) or [text](page:SPACE:PageTitle)
    if (hrefStr.startsWith("page:")) {
      const pageRef = hrefStr.slice(5);
      const parts = pageRef.split(":");
      const plainText = decodeBasicEntities(String(text));
      if (parts.length >= 2 && parts[0]) {
        const spaceKey = parts[0];
        const contentTitle = parts.slice(1).join(":");
        return `<ac:link><ri:page ri:space-key="${escapeHtml(spaceKey)}" ri:content-title="${escapeHtml(contentTitle)}"/><ac:plain-text-link-body><![CDATA[${plainText}]]></ac:plain-text-link-body></ac:link>`;
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

  // Restore literal asterisks
  out = out.replace(/MD_ESC_STAR/g, "*");
  return out;
}
