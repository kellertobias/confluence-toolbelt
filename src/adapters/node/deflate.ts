/**
 * Node zlib deflater backed by node:zlib. Used by the CLI and unit tests.
 */

import { deflateSync } from "node:zlib";

import type { Deflater } from "../../core/ports.js";

export const nodeDeflater: Deflater = {
  zlib(data: Uint8Array): Uint8Array {
    return new Uint8Array(deflateSync(data, { level: 9 }));
  },
};
