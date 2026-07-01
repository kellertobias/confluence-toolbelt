/**
 * Assemble canonical markdown from Confluence storage HTML + inline comments.
 *
 * Mirrors the CLI download command's block assembly so the plugin produces
 * identical canonical markdown (which the dialect then renders to Obsidian).
 * Pure: DOM access goes through the registered provider (getDom) inside
 * storageToMarkdownBlocks.
 */

import { emitHeader, type HeaderMeta } from "../../md-header.js";
import { emitTag } from "../../inline-tags.js";
import { storageToMarkdownBlocks } from "../../storage-dom.js";
import { embedCommentThreads } from "./embed-comments.js";

/** Build the canonical body (with node tags + comment markers) from already
 * link-enriched storage HTML and the page's unresolved comments. */
export function assembleCanonicalBody(
  storageHtml: string,
  comments: Parameters<typeof embedCommentThreads>[1],
): string {
  const blocks = storageToMarkdownBlocks(storageHtml);
  let body = blocks
    .map(
      (b) =>
        `${b.nodeId ? emitTag({ tagType: "content", nodeId: b.nodeId }) : ""}${b.markdown}\n`,
    )
    .join("\n");

  // Defensive: decode any comment-marker tokens that survived per-block decoding.
  body = body
    .replace(
      /MD(?:\\)?_CMT_START\(([^)]+)\)/g,
      (_m, enc: string) =>
        `<!-- comment:${decodeURIComponent(String(enc || ""))} -->`,
    )
    .replace(
      /MD(?:\\)?_CMT_END\(([^)]+)\)/g,
      (_m, enc: string) =>
        `<!-- commend-end:${decodeURIComponent(String(enc || ""))} -->`,
    );

  return embedCommentThreads(body, comments);
}

/** Build a full canonical document (header + body) from storage + comments. */
export function storageToCanonical(
  storageHtml: string,
  comments: Parameters<typeof embedCommentThreads>[1],
  meta: HeaderMeta,
): string {
  const body = assembleCanonicalBody(storageHtml, comments);
  return `${emitHeader(meta)}${body.trim()}\n`;
}
