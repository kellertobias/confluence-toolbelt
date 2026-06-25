/**
 * Upload local image files referenced in markdown as Confluence attachments.
 *
 * Why: Authors embed images either as a relative path (`![x](assets/x.png)`) or,
 * after a download round-trip, as an attachment reference (`![x](#x.png)`).
 * Confluence cannot render a relative URL, so on upload each referenced local
 * image must be uploaded as an attachment on the page. This module handles both
 * forms:
 *
 *   - Local path (`assets/x.png`): the file is uploaded and the reference is
 *     rewritten to the `#filename` attachment scheme that
 *     `markdownToStorageHtml` / `inlineHtml` convert to `<ri:attachment>`.
 *   - Attachment ref (`#x.png`): if a local file named `x.png` exists near the
 *     markdown (searched under the file's folder, then the workspace), the
 *     attachment is kept in sync with it (upload-if-changed). The reference is
 *     left as-is. If no local file matches, it simply references the existing
 *     attachment, unchanged. This is what lets an edited image propagate after a
 *     download has rewritten its reference to `#filename`.
 *
 * Supported formats: png, jpg/jpeg, gif, svg, webp, bmp.
 *
 * External URLs (`http(s)://`, `data:` …) are never touched.
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

/** Directories never worth searching for a local image. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
]);

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

/** True when a filename has one of our supported image extensions. */
function isSupportedImage(filename: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase());
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
 * Build a `basename -> absolute path` index by walking the given roots
 * breadth-first (skipping heavy/irrelevant directories). Earlier roots and
 * shallower files win, so a file next to the markdown takes precedence over a
 * deeper one or one elsewhere in the workspace with the same name. Traversal is
 * sorted for deterministic results.
 */
function buildFileIndex(roots: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const root of roots) {
    let queue: string[] = [root];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const subdirs: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) {
            subdirs.push(path.join(dir, entry.name));
          }
        } else if (entry.isFile() && !index.has(entry.name)) {
          index.set(entry.name, path.join(dir, entry.name));
        }
      }
      queue = [...queue, ...subdirs];
    }
  }
  return index;
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

interface UploadTask {
  abs: string;
  filename: string;
}

/**
 * Upload local images referenced in `markdown` as attachments on the page and
 * rewrite local-path references to the `![alt](#filename)` scheme. Attachment
 * references (`#filename`) backed by a matching local file are kept in sync but
 * left textually unchanged.
 *
 * Unresolvable local paths and unsupported file types are left unchanged with a
 * warning. External URLs are never touched.
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

  // Lazily-built basename -> path index for matching `#filename` refs to local
  // files. Built at most once per call, and only when an attachment ref needs it.
  let fileIndex: Map<string, string> | null = null;
  const indexRoots = currentDir === cwd ? [currentDir] : [currentDir, cwd];
  const lookupLocalFile = (filename: string): string | null => {
    if (!fileIndex) {
      fileIndex = buildFileIndex(indexRoots);
    }
    return fileIndex.get(filename) ?? null;
  };

  // Pass 1: discover images to upload.
  // - tasks:    abs path -> attachment filename (deduped uploads)
  // - rewrites: original local src -> "#filename" (only local-path refs)
  const tasks = new Map<string, UploadTask>();
  const rewrites = new Map<string, string>();
  const takenFilenames = new Map<string, string>(); // filename -> abs
  const seenLocalSrc = new Set<string>();
  const seenAttachmentNames = new Set<string>();

  for (const m of markdown.matchAll(IMAGE_RE)) {
    const src = m[2] ?? "";

    if (isLocalImageRef(src)) {
      if (seenLocalSrc.has(src)) {
        continue;
      }
      seenLocalSrc.add(src);
      const abs = resolveImagePath(src, currentDir, cwd);
      if (!abs) {
        warn(
          `⚠️  [images] Local image not found, leaving reference unchanged: ${src}`,
        );
        continue;
      }
      if (!isSupportedImage(abs)) {
        warn(
          `⚠️  [images] Unsupported image type (${path.extname(abs) || "no extension"}), leaving reference unchanged: ${src}`,
        );
        continue;
      }
      const existing = tasks.get(abs);
      const filename = existing
        ? existing.filename
        : pickFilename(abs, takenFilenames);
      if (!existing) {
        tasks.set(abs, { abs, filename });
        takenFilenames.set(filename, abs);
      }
      rewrites.set(src, `#${filename}`);
      continue;
    }

    // Attachment reference: keep in sync with a matching local file if present.
    if (src.startsWith("#")) {
      const filename = src.slice(1).trim();
      if (
        !filename ||
        seenAttachmentNames.has(filename) ||
        !isSupportedImage(filename)
      ) {
        continue;
      }
      seenAttachmentNames.add(filename);
      const abs = lookupLocalFile(filename);
      if (!abs) {
        continue; // no local file → references an existing attachment, leave it
      }
      if (!tasks.has(abs)) {
        tasks.set(abs, { abs, filename });
        takenFilenames.set(filename, abs);
        dbg(`attachment ref #${filename} matched local file ${abs}`);
      }
      // No rewrite — the reference is already in #filename form.
    }
  }

  if (tasks.size === 0) {
    return markdown;
  }

  // Pass 2: upload each unique file once, skipping any whose bytes are unchanged
  // since the last upload (per the optional hash cache).
  const cache = opts.cache;
  for (const { abs, filename } of tasks.values()) {
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

  // Pass 3: rewrite local-path refs to #filename attachment references.
  if (rewrites.size === 0) {
    return markdown;
  }
  return markdown.replace(IMAGE_RE, (match, alt: string, rawSrc: string) => {
    const replacement = rewrites.get(rawSrc);
    return replacement ? `![${alt}](${replacement})` : match;
  });
}
