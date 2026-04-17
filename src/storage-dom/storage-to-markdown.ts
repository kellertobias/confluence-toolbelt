/**
 * Convert Confluence storage HTML into an ordered list of mappable markdown
 * blocks. Each block corresponds to a top-level DOM child node and carries
 * its `data-node-id` when present, enabling targeted partial updates.
 */

import { parseHTML } from "linkedom";

import { unescapeMarkdownUnderscores } from "./markdown-escapes.js";
import { normalizeMacros } from "./normalize-macros.js";
import {
  renderReqListMarkdown,
  renderTableMarkdown,
  replaceTableTokens,
} from "./render-table.js";
import { decodeMdCommentTokens } from "./tokens.js";
import { turndown } from "./turndown.js";

export interface MappedNode {
  nodeId?: string;
  markdown: string;
}

/**
 * Heuristics:
 * - Respect macro placeholders via `normalizeMacros`/`decodeMdCommentTokens`.
 * - Render tables to GFM using `renderTableMarkdown`.
 * - For generic elements, convert outerHTML via Turndown and trim.
 */
export function storageToMarkdownBlocks(storageHtml: string): MappedNode[] {
  const preprocessed = normalizeMacros(storageHtml || "");
  // Wrap in a full HTML document so linkedom always creates a valid body
  // element, even when the entire content is a text token (e.g. MD_WIDGET,
  // MD_CODE) with no HTML tags.
  const { document } = parseHTML(`<html><body>${preprocessed}</body></html>`);
  const root = document.body as any as Element;
  const blocks: MappedNode[] = [];

  const nodes = Array.from((root as any).childNodes || []) as any[];
  for (const node of nodes) {
    if (!node) {
      continue;
    }

    if (node.nodeType === 1) {
      const block = elementToBlock(node);
      if (block) {
        blocks.push(block);
      }
      continue;
    }

    if (node.nodeType === 3) {
      const t = String((node as any).textContent || "").trim();
      if (!t) {
        continue;
      }
      const md = unescapeMarkdownUnderscores(decodeMdCommentTokens(t));
      if (md.trim()) {
        blocks.push({ markdown: md.trim() });
      }
    }
  }

  if (blocks.length === 0) {
    return [fallbackConvertWholeDocument(preprocessed)];
  }

  return blocks;
}

function elementToBlock(element: any): MappedNode | null {
  const el = element as Element & {
    getAttribute?: (name: string) => string | null;
  };
  const nodeId = el.getAttribute?.("data-node-id") || undefined;
  const tag = String((el as any).tagName || "").toLowerCase();

  // Top-level table: render as GFM (or requirement list).
  if (tag === "table") {
    const md = isRequirementTable(el)
      ? renderReqListMarkdown(el)
      : renderTableMarkdown(el);
    return md.trim() ? { nodeId, markdown: md.trim() } : null;
  }

  // Element that contains a descendant table: render the inner table instead.
  const tableDesc = (el as any).querySelector?.("table") as Element | null;
  if (tableDesc) {
    const md = isRequirementTable(tableDesc)
      ? renderReqListMarkdown(tableDesc)
      : renderTableMarkdown(tableDesc);
    return md.trim() ? { nodeId, markdown: md.trim() } : null;
  }

  // Generic element → markdown via Turndown + token decode.
  const md = unescapeMarkdownUnderscores(
    decodeMdCommentTokens(
      turndown.turndown(
        (el as any).outerHTML || (el as any).textContent || "",
      ),
    ),
  );
  return md.trim() ? { nodeId, markdown: md.trim() } : null;
}

function isRequirementTable(el: Element): boolean {
  return (el as any).getAttribute?.("data-req-table") === "true";
}

/**
 * Fallback path when no top-level blocks were detected. Converts the entire
 * preprocessed document using the older page-wide pipeline to avoid returning
 * empty output.
 */
function fallbackConvertWholeDocument(preprocessed: string): MappedNode {
  // Tokenize tables first to preserve correct row formatting.
  const tables: string[] = [];
  const tokenized = preprocessed.replace(
    /<table[\s\S]*?<\/table>/gi,
    (match) => {
      const idx = tables.push(match) - 1;
      return `MD_TABLE(${idx})`;
    },
  );
  const mdRaw = turndown.turndown(tokenized || "");
  const decoded = decodeMdCommentTokens(mdRaw);
  let normalized = replaceTableTokens(decoded, tables);
  normalized = unescapeMarkdownUnderscores(normalized);
  // Ensure at most a single blank line between blocks.
  normalized = normalized.replace(/\n{3,}/g, "\n\n");
  return { markdown: `${normalized}\n` };
}
