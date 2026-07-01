/**
 * Registered zlib provider for the mermaid.ink pako URL (see renderMermaidBlock).
 *
 * Same rationale as ./dom.ts: node:zlib on the CLI, fflate in the plugin. The
 * provider imports no platform code so it bundles for the browser.
 */

import type { Deflater } from "../core/ports.js";

let current: Deflater | null = null;

export function setDeflater(deflater: Deflater): void {
  current = deflater;
}

export function getDeflater(): Deflater {
  if (!current) {
    throw new Error(
      "Deflater not registered. Call setDeflater() at startup (CLI: cli.ts; " +
        "plugin: main.ts; tests: vitest setup).",
    );
  }
  return current;
}
