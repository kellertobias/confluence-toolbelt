/**
 * Registered DOM provider for the conversion code.
 *
 * Why: `storageToMarkdownBlocks`, `replaceNodesById`, and `replaceTableTokens`
 * need to parse HTML, but the parser differs per host — `linkedom` on the Node
 * CLI, the renderer's native `DOMParser` in the Obsidian plugin (which also
 * works on mobile). Threading an adapter through every call site (and 60+ tests)
 * would be enormous churn, so instead each host registers its `DomAdapter` once
 * at startup via `setDom`, and the conversion code resolves it lazily with
 * `getDom`. This module imports NO platform code, so it bundles for the browser.
 */

import type { DomAdapter } from "../core/ports.js";

let current: DomAdapter | null = null;

export function setDom(adapter: DomAdapter): void {
  current = adapter;
}

export function getDom(): DomAdapter {
  if (!current) {
    throw new Error(
      "DOM adapter not registered. Call setDom() at startup (CLI: cli.ts; " +
        "plugin: main.ts; tests: vitest setup).",
    );
  }
  return current;
}
