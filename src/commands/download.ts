/**
 * Download command: fetch pages and write markdown with header and inline tags.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ConfluenceClient } from '../api.js';
import { fromEnv } from '../adapters/node/confluence.js';
import { commitFile } from '../git.js';
import { parseHeader } from '../md-header.js';
import { loadPageCache, type PageCache, savePageCache } from '../page-cache.js';
import { writeBaseSidecar } from '../sync/base-source.js';
import { writeLocalBaseSidecar } from '../sync/local-changes.js';
import {
  formatDatePrefix,
  resolvePageId,
  sanitizeTitle,
  walkMarkdown,
} from './page-files.js';
import { composeDocument, renderPage } from './render-page.js';

interface Options {
  cwd: string;
  args?: string[];
}

/**
 * Persist a rendered page and its sync baselines, then commit.
 *
 * Shared by every download variant so the sidecars can never fall out of step
 * with the markdown they describe.
 */
export async function writePageFile(
  cwd: string,
  filePath: string,
  next: string,
  storageHtml: string,
  label: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, 'utf8');
  // Also refresh the sync sidecars so `sync` has a clean base to diff against
  // and a later download can tell local edits from remote ones.
  try {
    writeBaseSidecar(filePath, storageHtml ?? '');
    writeLocalBaseSidecar(filePath, next);
  } catch (err) {
    console.warn(
      `[download] Failed to write sync base sidecar for ${label}:`,
      err instanceof Error ? err.message : err,
    );
  }
  console.log(`[download] Wrote ${label}`);
  /**
   * Automatically commit downloaded files to git for version tracking.
   * Why: Keep git history in sync with Confluence downloads, making it easy to
   * track what was downloaded and when.
   */
  await commitFile(cwd, filePath);
}

/**
 * Display warning if document uses unsupported features.
 * Why: Users need to know that uploading this document back will lose
 * certain formatting and layout features that cannot be represented in markdown.
 */
export function warnUnsupported(features: string[]): void {
  if (features.length > 0) {
    console.warn(
      `⚠️  Warning: This document uses unsupported features that will be lost on upload:`,
    );
    console.warn(`   ${features.join(', ')}`);
  }
}

/** Write the original Confluence storage HTML next to the markdown file using a
 * hidden filename: `.<filename>.confluence`.
 *
 * Why: Useful for debugging mapping issues and ensuring partial updates map
 * correctly back to original nodes. */
export function writeVerboseHtml(filePath: string, storageHtml: string): void {
  const verbosePath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.confluence`,
  );
  try {
    fs.writeFileSync(verbosePath, storageHtml ?? '', 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[download] Failed to write verbose file: ${err}`);
  }
}

export async function downloadAll(opts: Options): Promise<void> {
  const force = opts.args?.includes('--force');
  const verbose = opts.args?.includes('--verbose');
  const client = fromEnv();
  const pageCache = loadPageCache(opts.cwd);

  // Extract non-flag arguments (potential URLs or file paths)
  const urlArgs = (opts.args || []).filter((a) => !a.startsWith('--'));

  /**
   * Mode 1: Download from URLs if provided
   * Why: Allow users to quickly download pages from browser URLs
   * How: Extract pageId from URL, fetch metadata, generate filename
   *
   * Supports:
   * - Single URL: download https://...
   * - URL with custom path: download https://... path/to/file.md
   * - Multiple URLs: download URL1 URL2 URL3
   */
  if (urlArgs.length > 0) {
    // Check if first argument looks like a URL or pageId
    const firstArg = urlArgs[0];
    if (!firstArg) {
      return; // Safety check
    }

    const isUrl = firstArg.includes('http') || /^\d+$/.test(firstArg);

    if (isUrl) {
      // Check if second argument is a file path (not a URL)
      const secondArg = urlArgs[1];
      const hasCustomPath =
        secondArg && !secondArg.includes('http') && !/^\d+$/.test(secondArg);

      if (hasCustomPath) {
        // Single URL with custom file path
        await downloadFromUrl(opts.cwd, firstArg, {
          force: force || false,
          verbose: verbose || false,
          client,
          customPath: secondArg,
          pageCache,
        });
      } else {
        // One or more URLs without custom paths
        const urlsToDownload = urlArgs.filter((arg) => {
          return arg.includes('http') || /^\d+$/.test(arg);
        });

        for (const urlOrPageId of urlsToDownload) {
          await downloadFromUrl(opts.cwd, urlOrPageId, {
            force: force || false,
            verbose: verbose || false,
            client,
            pageCache,
          });
        }
      }
      savePageCache(opts.cwd, pageCache);
      return;
    }
  }

  /**
   * Mode 2: Download existing markdown files with pageId headers
   * Why: Update local files that already have Confluence page mappings
   */
  // Discover .md files and extract pageId from header
  const all = walkMarkdown(opts.cwd);
  const entries = all
    .map((p) => ({ p, h: parseHeader(fs.readFileSync(p, 'utf8')) }))
    .filter((x) => x.h.meta.pageId)
    .map(
      (x) =>
        [
          path.relative(opts.cwd, x.p),
          {
            id: String(x.h.meta.pageId),
            spaceId: x.h.meta.spaceId,
            title: x.h.meta.title,
          },
        ] as const,
    );

  for (const [relPath, meta] of entries) {
    const filePath = path.resolve(opts.cwd, relPath);
    const page = await renderPage(client, meta.id, { pageCache });

    // When verbose, persist the raw storage HTML in a hidden sibling file for
    // inspection/debugging.
    if (verbose) {
      writeVerboseHtml(filePath, page.storageHtml);
    }

    // Preserve optional header fields (title/spaceId/status/readonly) from the
    // existing file header.
    const existingText = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf8')
      : '';
    const next = composeDocument(page, meta.id, parseHeader(existingText).meta, {
      preferExistingMeta: true,
    });

    if (!force && existingText === next) {
      console.log(`[download] No changes for ${relPath}`);
    } else {
      await writePageFile(
        opts.cwd,
        filePath,
        next,
        page.storageHtml,
        relPath,
      );
      warnUnsupported(page.unsupportedFeatures);
    }
  }

  savePageCache(opts.cwd, pageCache);
}

/**
 * Download a page from a Confluence URL or pageId.
 *
 * Why: Allow users to quickly download pages by pasting URLs from their browser.
 *
 * How: Extract pageId from URL, fetch page metadata (including last modified date),
 * generate filename as YYMMDD-Title.md (or use custom path if provided), download content, and commit to git.
 *
 * @param cwd - Current working directory
 * @param urlOrPageId - Confluence URL or pageId
 * @param opts - Options including force, verbose, client, and optional customPath
 */
async function downloadFromUrl(
  cwd: string,
  urlOrPageId: string,
  opts: {
    force: boolean;
    verbose: boolean;
    client: ConfluenceClient;
    customPath?: string;
    pageCache: PageCache;
  },
): Promise<void> {
  const { force, verbose, client, customPath, pageCache } = opts;

  const pageId = resolvePageId(urlOrPageId);
  if (!pageId) {
    console.error(`[download] Could not extract pageId from: ${urlOrPageId}`);
    return;
  }

  console.log(`[download] Fetching page ${pageId}...`);

  const page = await renderPage(client, pageId, { pageCache });
  if (!page.v1) {
    console.warn(`[download] No v1 metadata for ${pageId} — using today's date`);
  }

  // Determine file path: use custom path if provided, otherwise generate from title and date
  let filePath: string;
  let filename: string;

  if (customPath) {
    // Use custom path provided by user
    filePath = path.isAbsolute(customPath)
      ? customPath
      : path.resolve(cwd, customPath);
    filename = path.basename(filePath);
  } else {
    // Generate filename from last modified date and title
    const lastModified = page.v1?.version?.when
      ? new Date(page.v1.version.when)
      : new Date();
    filename = `${formatDatePrefix(lastModified)}-${sanitizeTitle(page.title)}.md`;
    filePath = path.join(cwd, filename);
  }

  // Write verbose HTML if requested
  if (verbose) {
    writeVerboseHtml(filePath, page.storageHtml);
    console.log(`[download] Wrote verbose HTML next to ${filename}`);
  }

  // Check if file already exists to preserve READONLY flag
  const existingText = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '';
  const next = composeDocument(page, pageId, parseHeader(existingText).meta);

  if (!force && existingText === next) {
    console.log(`[download] No changes for ${filename}`);
    return;
  }
  await writePageFile(cwd, filePath, next, page.storageHtml, filename);
  warnUnsupported(page.unsupportedFeatures);
}
