/**
 * Shared TurndownService instance used across storage-dom conversion steps.
 *
 * Why a module-level singleton: TurndownService carries registered plugins
 * and rules as mutable state, and we want every call site in this package to
 * see identical configuration (GFM + our horizontal-rule override).
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
} as any);
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

/**
 * Convert a footnote reference (`<sup><a href="#fn-id">N</a></sup>`, emitted
 * by markdown-to-storage's footnote handling) back to `[^id]`. Matches on the
 * `#fn-` href prefix rather than the visible number, since repeated
 * references to the same footnote share one number but must all map back to
 * the same id.
 */
(turndown as any).addRule("footnoteReference", {
  filter: (node: any) =>
    node.nodeName === "SUP" &&
    node.childNodes?.length === 1 &&
    node.firstChild?.nodeName === "A" &&
    /^#fn-/.test(node.firstChild.getAttribute?.("href") || ""),
  replacement: (_content: string, node: any) => {
    const href = node.firstChild.getAttribute("href") || "";
    return `[^${href.replace(/^#fn-/, "")}]`;
  },
});
