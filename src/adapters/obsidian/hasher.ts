/**
 * SHA-256 via Web Crypto (works in the Electron renderer and on mobile).
 */

import type { Hasher } from "../../core/ports.js";

export const subtleHasher: Hasher = {
  async sha256Hex(data: Uint8Array): Promise<string> {
    const view = new Uint8Array(data); // ensure a plain ArrayBuffer-backed view
    const digest = await crypto.subtle.digest("SHA-256", view);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  },
};
