/**
 * Replace nodes in storage HTML by `data-node-id` with HTML snippets.
 *
 * Used for partial page updates: if a nodeId is not found, storage is left
 * unchanged for that id and it is reported in the returned `missing` list.
 */

import { parseHTML } from "linkedom";

export function replaceNodesById(
  storageHtml: string,
  replacements: Record<string, string>,
): { html: string; missing: string[] } {
  const { document } = parseHTML(storageHtml);
  const missing: string[] = [];
  for (const [nodeId, html] of Object.entries(replacements)) {
    const target = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (!target) {
      missing.push(nodeId);
      continue;
    }
    const placeholder = document.createElement("div");
    placeholder.innerHTML = html;
    const parent = target.parentNode as Node | null;
    if (!parent) {
      missing.push(nodeId);
      continue;
    }
    const replacement =
      (placeholder.firstChild as Node | null) ??
      (placeholder as unknown as Node);
    parent.replaceChild(replacement, target);
  }
  return { html: document.body.innerHTML, missing };
}
