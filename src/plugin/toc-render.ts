/**
 * Renderer for Confluence widget placeholders.
 *
 * A downloaded note carries the TOC macro as a block-level placeholder
 * (`<div class="cf-widget" data-widget="TOC">`). This post-processor replaces
 * that placeholder's contents with the note's actual headings, so the note
 * shows a real table of contents the way the Confluence page does.
 *
 * Only the rendered DOM is touched — the placeholder in the file is left alone,
 * so the widget still round-trips back to `<!-- widget:TOC -->` and then to the
 * Confluence macro. That also keeps the TOC always current: it is rebuilt from
 * the metadata cache on every render rather than baked into the note.
 */

import {
  type HeadingCache,
  type MarkdownPostProcessorContext,
  TFile,
} from "obsidian";

import type ConfluenceToolsPlugin from "./main.js";

/**
 * Mark callouts that carry no title of their own.
 *
 * A downloaded Confluence panel becomes a bare `> [!info]`, and Obsidian fills
 * the empty title with the callout type's name. Confluence shows no such
 * heading, so flag those callouts for the stylesheet to hide the invented text
 * (the icon stays). A callout the user deliberately titled "Info" is left be —
 * the match is against the default label only.
 */
export function markUntitledPanels(el: HTMLElement): void {
  for (const callout of Array.from(
    el.querySelectorAll<HTMLElement>(".callout[data-callout]"),
  )) {
    const type = (callout.dataset.callout ?? "").toLowerCase();
    const title =
      callout
        .querySelector<HTMLElement>(":scope > .callout-title > .callout-title-inner")
        ?.textContent?.trim()
        .toLowerCase() ?? "";
    if (title && title === type) {
      callout.addClass("cf-panel-untitled");
    }
  }
}

export function renderConfluenceWidgets(
  plugin: ConfluenceToolsPlugin,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): void {
  markUntitledPanels(el);
  const nodes = Array.from(el.querySelectorAll<HTMLElement>("div.cf-widget"));
  for (const node of nodes) {
    const name = (node.dataset.widget ?? "").toLowerCase();
    if (name === "toc") {
      renderToc(plugin, node, ctx);
    } else {
      // Unknown widget: keep the label but mark it as a placeholder so it's
      // visible rather than silently blank.
      node.addClass("cf-widget-box");
    }
  }
}

function renderToc(
  plugin: ConfluenceToolsPlugin,
  node: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): void {
  node.addClass("cf-widget-box");
  node.addClass("cf-toc");

  const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
  const headings =
    file instanceof TFile
      ? (plugin.app.metadataCache.getFileCache(file)?.headings ?? [])
      : [];

  node.empty();
  node.createDiv({ cls: "cf-widget-label", text: "Contents" });

  if (!headings.length) {
    node.createDiv({ cls: "cf-toc-empty", text: "No headings yet." });
    return;
  }

  const list = node.createEl("ul", { cls: "cf-toc-list" });
  // Indent relative to the shallowest heading, so a note whose sections are all
  // H2 (the usual shape after a download, where H1 is the page title) doesn't
  // render every entry one level in.
  const base = Math.min(...headings.map((h) => h.level));
  for (const h of headings) {
    const item = list.createEl("li", { cls: "cf-toc-item" });
    item.style.paddingLeft = `${(h.level - base) * 14}px`;
    const link = item.createEl("a", {
      cls: "internal-link cf-toc-link",
      text: headingText(h),
    });
    const target = `#${headingText(h)}`;
    link.setAttribute("href", target);
    // Obsidian's own link handler resolves `data-href` against sourcePath, so
    // the anchor scrolls to the heading instead of navigating away.
    link.setAttribute("data-href", target);
  }
}

/** The heading's display text, with any markdown emphasis/links flattened. */
function headingText(h: HeadingCache): string {
  return h.heading
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, alias) => alias || t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`~]/g, "")
    .trim();
}
