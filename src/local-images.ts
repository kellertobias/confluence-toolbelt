/**
 * Upload local image files referenced in markdown as Confluence attachments.
 *
 * Why: Authors embed images with relative paths like `![diagram](assets/x.png)`.
 * Confluence cannot render a relative URL, so on upload each local image must be
 * uploaded as an attachment on the page and the reference rewritten to the
 * `#filename` attachment scheme that `markdownToStorageHtml` / `inlineHtml`
 * convert to `<ri:attachment>`. This also round-trips cleanly: on download such
 * images come back as `![alt](#filename)` and re-upload references the same
 * attachment.
 *
 * Supported formats: png, jpg/jpeg, gif, svg, webp, bmp.
 *
 * Already-attached refs (`#name`), external URLs (`http(s)://`, `data:` …) are
 * left untouched.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type AttachmentCache,
  getCachedHash,
  hashContent,
  setCachedHash,
} from "./attachment-cache.js";

/** File extensions we treat as uploadable images. */
export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
]);

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Minimal interface satisfied by `ConfluenceClient` (kept narrow for tests). */
export interface AttachmentUploader {
  uploadAttachment(
    pageId: string,
    filename: string,
    data: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void>;
}

/** Map a filename to a sensible MIME type, defaulting to octet-stream. */
export function contentTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * True when an image `src` points to a local file that should be uploaded as an
 * attachment, rather than an existing attachment (`#name`), an external URL, or
 * a `data:` URI.
 *
 * A leading scheme of two or more characters followed by `:` (e.g. `http:`,
 * `https:`, `data:`, `file:`) marks a URI. A single leading letter + `:` is
 * treated as a local path so Windows drive letters (`C:\…`) aren't mistaken for
 * a URI scheme.
 */
export function isLocalImageRef(src: string): boolean {
  const s = (src || "").trim();
  if (!s) {
    return false;
  }
  if (s.startsWith("#")) {
    return false; // existing attachment reference
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(s)) {
    return false; // URI scheme (http:, https:, data:, file:, page:, …)
  }
  return true;
}

/**
 * Resolve an image src to an absolute file path. Tries the markdown file's
 * directory first, then the workspace root, and also tries a percent-decoded
 * variant so `![](my%20image.png)` resolves to `my image.png`.
 */
function resolveImagePath(
  src: string,
  currentDir: string,
  cwd: string,
): string | null {
  const variants = new Set<string>([src]);
  try {
    variants.add(decodeURIComponent(src));
  } catch {
    /* malformed encoding — ignore */
  }
  for (const variant of variants) {
    for (const candidate of [
      path.resolve(currentDir, variant),
      path.resolve(cwd, variant),
    ]) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* ignore stat errors */
      }
    }
  }
  return null;
}

/**
 * Pick an attachment filename for an absolute path, disambiguating with a
 * numeric suffix when a different source file already claimed that basename
 * (attachments are keyed by filename per page).
 */
function pickFilename(abs: string, taken: Map<string, string>): string {
  const base = path.basename(abs);
  const existingOwner = taken.get(base);
  if (existingOwner === undefined || existingOwner === abs) {
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let i = 1;
  let candidate = `${stem}-${i}${ext}`;
  while (taken.has(candidate) && taken.get(candidate) !== abs) {
    i++;
    candidate = `${stem}-${i}${ext}`;
  }
  return candidate;
}

// Markdown image syntax: ![alt](src). src stops at whitespace or the closing ).
const IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;

/**
 * Upload every local image referenced in `markdown` as an attachment on the
 * given page and rewrite each reference to `![alt](#filename)`.
 *
 * Unresolvable paths and unsupported file types are left unchanged with a
 * warning. External URLs and existing `#name` references are never touched.
 *
 * @param markdown    - Markdown body (after the header has been stripped)
 * @param currentFile - Absolute path to the markdown file being uploaded
 * @param cwd         - Workspace root for fallback path resolution
 * @param uploader    - Confluence client (or compatible test double)
 * @param pageId      - Target Confluence page id
 * @param opts.cache  - Optional hash cache; when provided, images whose bytes
 *                      match the recorded hash are skipped (no re-upload).
 */
export async function resolveLocalImages(
  markdown: string,
  currentFile: string,
  cwd: string,
  uploader: AttachmentUploader,
  pageId: string,
  opts: {
    dbg?: (m: string) => void;
    warn?: (m: string) => void;
    cache?: AttachmentCache;
  } = {},
): Promise<string> {
  const dbg = opts.dbg ?? (() => {});
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const currentDir = path.dirname(currentFile);

  // Pass 1: discover unique local images to upload (keyed by original src).
  const srcToAbs = new Map<string, string>();
  for (const m of markdown.matchAll(IMAGE_RE)) {
    const src = m[2] ?? "";
    if (!isLocalImageRef(src) || srcToAbs.has(src)) {
      continue;
    }
    const abs = resolveImagePath(src, currentDir, cwd);
    if (!abs) {
      warn(
        `⚠️  [images] Local image not found, leaving reference unchanged: ${src}`,
      );
      continue;
    }
    const ext = path.extname(abs).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      warn(
        `⚠️  [images] Unsupported image type (${ext || "no extension"}), leaving reference unchanged: ${src}`,
      );
      continue;
    }
    srcToAbs.set(src, abs);
  }

  if (srcToAbs.size === 0) {
    return markdown;
  }

  // Assign attachment filenames, disambiguating basename collisions.
  const absToFilename = new Map<string, string>();
  const takenFilenames = new Map<string, string>(); // filename -> abs
  for (const abs of new Set(srcToAbs.values())) {
    if (absToFilename.has(abs)) {
      continue;
    }
    const filename = pickFilename(abs, takenFilenames);
    absToFilename.set(abs, filename);
    takenFilenames.set(filename, abs);
  }

  // Upload each unique file once, skipping any whose bytes are unchanged since
  // the last upload (per the optional hash cache).
  const cache = opts.cache;
  for (const [abs, filename] of absToFilename) {
    const data = fs.readFileSync(abs);
    const hash = hashContent(data);
    if (cache && getCachedHash(cache, pageId, filename) === hash) {
      dbg(`skipping unchanged attachment ${filename} (page ${pageId})`);
      continue;
    }
    const contentType = contentTypeForFilename(filename);
    dbg(
      `uploading attachment ${filename} (${data.length} bytes, ${contentType}) to page ${pageId}`,
    );
    await uploader.uploadAttachment(pageId, filename, data, contentType);
    if (cache) {
      setCachedHash(cache, pageId, filename, hash);
    }
  }

  // Pass 2: rewrite resolved local refs to #filename attachment references.
  return markdown.replace(IMAGE_RE, (match, alt: string, rawSrc: string) => {
    const abs = srcToAbs.get(rawSrc);
    if (!abs) {
      return match; // external URL, existing attachment, or unresolved — keep
    }
    const filename = absToFilename.get(abs);
    return filename ? `![${alt}](#${filename})` : match;
  });
}
