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
