/**
 * Balanced scanning for Confluence `expand` macros.
 *
 * Why a scanner instead of a regex: the rest of `normalize-macros` matches
 * macros with `<ac:structured-macro ...>([\s\S]*?)</ac:structured-macro>`,
 * which stops at the *first* closing tag. That is fine for the leaf macros it
 * was written for, but an `expand` wraps arbitrary block content — a code
 * macro, a table, another expand — so its closing tag is never the first one.
 * This module walks the container tags instead and returns each macro with its
 * exact span, its title, its rich-text body, and the containers it sits in.
 *
 * The `ancestors` list is what decides whether an expand can round-trip: an
 * expand at the top level (or nested only inside other expands) becomes a pair
 * of `<!-- expand:… -->` / `<!-- /expand -->` markers, while one inside a table
 * cell or a panel body is consumed by those renderers and is genuinely lost.
 */

import { decodeHtmlEntities } from "./html-utils.js";

/** Container tags whose nesting has to be tracked to find a macro's real end. */
const CONTAINER_TAG_RE = /<(\/?)(ac:structured-macro|table)\b([^>]*)>/gi;

/**
 * Expand titles the tool writes itself. They carry configuration for another
 * construct (a deflist, a requirement table, a list table, footnote ids) or the
 * source of a rendered mermaid diagram, and each already has a dedicated
 * normalizer. They must never be turned into authoring markers.
 */
const INTERNAL_EXPAND_TITLES = new Set([
  "deflist-config",
  "req-table",
  "list-table-config",
  "footnotes-config",
]);

export interface ExpandMacro {
  /** Index of the `<` opening the `<ac:structured-macro>` tag. */
  start: number;
  /** Index just past the closing `</ac:structured-macro>` tag. */
  end: number;
  /** Tag-stripped, trimmed `title` parameter — empty when the macro has none. */
  title: string;
  /** Raw inner HTML of the macro's `<ac:rich-text-body>`, empty when absent. */
  body: string;
  /**
   * Enclosing containers, outermost first: the `ac:name` of each enclosing
   * structured macro and `"table"` for each enclosing table. Empty for a macro
   * at the top level of the document.
   */
  ancestors: string[];
}

interface OpenContainer {
  tag: string;
  name: string;
  start: number;
  ancestors: string[];
}

/**
 * @param html - Confluence storage HTML
 * @returns Every `expand` macro in document order, with its span and ancestry
 */
export function findExpandMacros(html: string): ExpandMacro[] {
  const stack: OpenContainer[] = [];
  const found: ExpandMacro[] = [];
  const re = new RegExp(CONTAINER_TAG_RE.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = re.exec(html)) !== null) {
    const isClosing = match[1] === "/";
    const tag = (match[2] || "").toLowerCase();
    const attrs = match[3] || "";

    if (isClosing) {
      // Pop back to the nearest open container of the same tag. Unbalanced
      // markup just discards the entries in between rather than throwing.
      for (let i = stack.length - 1; i >= 0; i--) {
        const open = stack[i];
        if (!open || open.tag !== tag) {
          continue;
        }
        stack.length = i;
        if (open.name === "expand") {
          const end = match.index + match[0].length;
          const outer = html.slice(open.start, end);
          found.push({
            start: open.start,
            end,
            title: extractTitle(outer),
            body: extractRichTextBody(outer),
            ancestors: open.ancestors,
          });
        }
        break;
      }
      continue;
    }

    if (/\/\s*$/.test(attrs)) {
      continue; // self-closing macro — never opens a scope
    }

    const name =
      tag === "table"
        ? "table"
        : (attrs.match(/\bac:name=["']([^"']+)["']/i)?.[1] || "").toLowerCase();
    stack.push({
      tag,
      name,
      start: match.index,
      ancestors: stack.map((entry) => entry.name),
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * True for the expands the tool emits for its own bookkeeping (see
 * `INTERNAL_EXPAND_TITLES`) and for mermaid diagram sources.
 */
export function isInternalExpandTitle(title: string): boolean {
  return /mermaid/i.test(title) || INTERNAL_EXPAND_TITLES.has(title);
}

/**
 * Percent-encode an expand title for the `MD_EXPAND_START(…)` token.
 *
 * `encodeURIComponent` leaves parentheses alone, which would terminate the
 * token early for a title like `Method (v2)`, so those two are encoded too.
 */
export function encodeExpandTitle(title: string): string {
  return encodeURIComponent(title).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * First `title` parameter of the macro as plain text.
 *
 * The title is pulled straight out of the storage string rather than through
 * the DOM, so it arrives with entities intact (`&mdash;`, `&amp;`) where the
 * body — which the DOM parser handles — is already decoded. Decoding here keeps
 * the two halves symmetric: without it, `escapeHtml` on the upload side would
 * turn a title read as `&mdash;` into the literal text `&amp;mdash;`.
 */
function extractTitle(macroHtml: string): string {
  const raw =
    macroHtml.match(
      /<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
    )?.[1] || "";
  return decodeHtmlEntities(raw.replace(/<[^>]+>/g, "")).trim();
}

/**
 * Inner HTML of the macro's own `<ac:rich-text-body>`, found by depth counting
 * so a nested expand's body doesn't terminate the outer one.
 */
function extractRichTextBody(macroHtml: string): string {
  const openRe = /<ac:rich-text-body\b[^>]*>/gi;
  const first = openRe.exec(macroHtml);
  if (!first) {
    return "";
  }
  const bodyStart = first.index + first[0].length;
  const boundaryRe = /<(\/?)ac:rich-text-body\b[^>]*>/gi;
  boundaryRe.lastIndex = bodyStart;
  let depth = 1;
  let boundary: RegExpExecArray | null;
  while ((boundary = boundaryRe.exec(macroHtml)) !== null) {
    depth += boundary[1] === "/" ? -1 : 1;
    if (depth === 0) {
      return macroHtml.slice(bodyStart, boundary.index);
    }
  }
  return macroHtml.slice(bodyStart);
}
