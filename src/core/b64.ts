/**
 * Base64 helpers that work in both Node 18+ and the browser/Electron renderer.
 *
 * Why: the conversion code must bundle for the Obsidian plugin (browser), where
 * `Buffer` does not exist. `btoa`/`atob` are globals in Node 18+ and the
 * renderer, but only handle latin1 — so we round-trip through TextEncoder/
 * TextDecoder to stay UTF-8 safe.
 */

export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

export function base64ToUtf8(input: string): string {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/** Encode raw bytes as URL-safe base64 (RFC 4648 §5, no padding) — used for the
 * mermaid.ink `pako:` URL. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
