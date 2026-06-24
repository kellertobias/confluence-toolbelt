/**
 * Content-hash cache for uploaded image attachments.
 *
 * Why: Local images are re-uploaded as attachments on every upload, which
 * creates a fresh attachment version each time even when the file is byte-for-
 * byte identical. This module records a SHA-256 of the bytes last uploaded for
 * each (pageId, filename) so unchanged images can be skipped, avoiding version
 * churn and needless network traffic.
 *
 * Cache semantics:
 * - Keyed by Confluence page id, then by attachment filename → hex SHA-256.
 * - Persisted to `.attachments.json` at the workspace root, mirroring the
 *   `.pages.json` page cache. It is a local optimisation only; deleting it just
 *   forces every referenced image to upload once more.
 * - The cache is trusted for skip decisions: if you delete an attachment in the
 *   Confluence UI by hand, remove `.attachments.json` (or that entry) to force
 *   a re-upload.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** pageId -> (attachment filename -> hex sha256 of last-uploaded bytes). */
export type AttachmentCache = Record<string, Record<string, string>>;

const CACHE_FILE = ".attachments.json";

/** Hex SHA-256 of a buffer — the identity used to detect content changes. */
export function hashContent(data: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function loadAttachmentCache(cwd: string): AttachmentCache {
  try {
    const raw = fs.readFileSync(path.join(cwd, CACHE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as AttachmentCache)
      : {};
  } catch {
    return {};
  }
}

export function saveAttachmentCache(cwd: string, cache: AttachmentCache): void {
  fs.writeFileSync(
    path.join(cwd, CACHE_FILE),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
}

/** Hash recorded for an attachment, or undefined when never uploaded. */
export function getCachedHash(
  cache: AttachmentCache,
  pageId: string,
  filename: string,
): string | undefined {
  return cache[pageId]?.[filename];
}

/** Record the hash uploaded for an attachment (mutates `cache`). */
export function setCachedHash(
  cache: AttachmentCache,
  pageId: string,
  filename: string,
  hash: string,
): void {
  (cache[pageId] ??= {})[filename] = hash;
}
