/**
 * Reading-view renderer for Confluence comments.
 *
 * Highlights the anchored text and places a comment icon in the left margin
 * (not in the text flow, so it can't be edited out). Clicking the icon opens an
 * overlay with the thread and a per-comment Resolve action.
 */

import { type MarkdownPostProcessorContext, TFile } from "obsidian";

import { parseObsidianComments } from "../core/dialect/obsidian.js";
import {
  createCommentIcon,
  type CommentThreadEntry,
} from "./comment-overlay.js";
import { resolveComment } from "./commands.js";
import type ConfluenceToolsPlugin from "./main.js";

export function renderConfluenceComments(
  plugin: ConfluenceToolsPlugin,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): void {
  const info = ctx.getSectionInfo(el);
  if (!info) return;
  const source = info.text
    .split("\n")
    .slice(info.lineStart, info.lineEnd + 1)
    .join("\n");
  const comments = parseObsidianComments(source);
  if (!comments.length) return;

  const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);

  for (const comment of comments) {
    const threads: CommentThreadEntry[] = comment.threads.map((t) => ({
      author: t.author,
      body: t.body,
    }));
    const onResolve =
      file instanceof TFile
        ? () => resolveComment(plugin, file, comment.ids)
        : undefined;
    const anchor = comment.anchor.trim();
    const mark = anchor ? highlightAnchor(el, anchor) : null;

    const icon = createCommentIcon(el.ownerDocument, threads, onResolve);
    if (mark) {
      // Place the icon in the left margin, aligned to the anchored line.
      el.style.position = "relative";
      icon.addClass("cf-margin-icon");
      icon.style.top = `${mark.offsetTop}px`;
      el.appendChild(icon);
    } else {
      el.appendChild(icon);
    }
  }
}

/** Wrap the anchor text in a coloured <mark>; returns the mark element or null. */
function highlightAnchor(el: HTMLElement, anchor: string): HTMLElement | null {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const idx = text.indexOf(anchor);
    if (idx >= 0) {
      const range = doc.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + anchor.length);
      const mark = doc.createElement("mark");
      mark.addClass("cf-comment-anchor");
      try {
        range.surroundContents(mark);
      } catch {
        return null;
      }
      return mark;
    }
  }
  return null;
}
