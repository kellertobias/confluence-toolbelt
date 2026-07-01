/**
 * Browser zlib deflater backed by fflate (used by the Obsidian plugin).
 * fflate's zlibSync produces zlib-wrapped output matching node:zlib.deflateSync,
 * which is what mermaid.ink's `pako:` URL expects.
 */

import { zlibSync } from "fflate";

import type { Deflater } from "../../core/ports.js";

export const fflateDeflater: Deflater = {
  zlib(data: Uint8Array): Uint8Array {
    return zlibSync(data, { level: 9 });
  },
};
