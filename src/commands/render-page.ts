/**
 * Fetch one Confluence page and render it to the CLI's markdown flavour.
 *
 * Why: `download` (mapped files and URLs) and `download --tree` all need the
 * exact same fetch → convert → link-resolve → header pipeline. Keeping it in one
 * place stops the variants from drifting apart.
 *
 * The caller owns file paths: this module returns markdown, never writes.
 */

import type { ConfluenceClient } from '../api.js';
import { embedCommentThreads } from '../core/pipeline/embed-comments.js';
import { emitTag } from '../inline-tags.js';
import { resolveConfluencePageUrls } from '../local-links.js';
import { emitHeader, type HeaderMeta } from '../md-header.js';
import { type PageCache, resolvePageTitleLinks } from '../page-cache.js';
import {
  detectUnsupportedFeatures,
  extractHeaderExtrasFromStorage,
  storageToMarkdownBlocks,
} from '../storage-dom.js';
import { enrichContentEntityLinks } from '../storage-dom/enrich-links.js';

export interface RenderedPage {
  /** Title as it stands in Confluence. */
  title: string;
  spaceId?: string;
  /** Raw storage HTML, for the sync base sidecar and verbose dumps. */
  storageHtml: string;
  /** Converted markdown body (no header). */
  body: string;
  /** Header extras derived from the storage HTML / ADF (status, image, …). */
  extras: ReturnType<typeof extractHeaderExtrasFromStorage>;
  /** v1 content payload (metadata, version) — undefined when unavailable. */
  v1: any;
  /** Features that will be lost on a round-trip back to Confluence. */
  unsupportedFeatures: string[];
}

/** Pull status/image hints out of the ADF body when the storage HTML had none. */
function applyAdfExtras(
  extras: ReturnType<typeof extractHeaderExtrasFromStorage>,
  adf: unknown,
): void {
  if (!adf) {
    return;
  }
  try {
    const doc = JSON.stringify(adf);
    const statusNode = doc.match(
      /"type"\s*:\s*"status"[\s\S]*?"text"\s*:\s*"([^"]+)"/i,
    );
    if (statusNode && !extras.status) {
      extras.status = `grey:${statusNode[1]}`;
    }
    const media = doc.match(/"type"\s*:\s*"media"[\s\S]*?"url"\s*:\s*"([^"]+)"/i);
    if (media && !extras.image) {
      extras.image = media[1];
    }
  } catch {}
}

export async function renderPage(
  client: ConfluenceClient,
  pageId: string,
  opts: { pageCache: PageCache },
): Promise<RenderedPage> {
  const {
    storageHtml,
    title,
    spaceId,
  } = await client.getPageStorage(pageId);
  const adf = await client.getPageAtlasDoc(pageId);
  const v1 = await client.getPageV1Content(pageId);

  const extras = extractHeaderExtrasFromStorage(storageHtml, title);
  applyAdfExtras(extras, adf);

  const unsupportedFeatures = detectUnsupportedFeatures(storageHtml);

  // Fetch inline comments to embed their contents
  const comments = await client.getPageComments(pageId).catch(() => []);

  const enrichedHtml = await enrichContentEntityLinks(storageHtml, (id) =>
    client.getPageSpaceKey(id),
  );
  const blocks = storageToMarkdownBlocks(enrichedHtml);
  // Join blocks and apply a final token decode pass for any durable tokens that
  // might have survived the per-block decoding (defensive against edge cases).
  let body = blocks
    .map(
      (b) =>
        `${(b.nodeId ? emitTag({ tagType: 'content', nodeId: b.nodeId }) : '') + b.markdown}\n`,
    )
    .join('\n');
  body = body
    .replace(
      /MD(?:\\)?_CMT_START\(([^)]+)\)/g,
      (_m, enc) => `<!-- comment:${decodeURIComponent(String(enc || ''))} -->`,
    )
    .replace(
      /MD(?:\\)?_CMT_END\(([^)]+)\)/g,
      (_m, enc) =>
        `<!-- commend-end:${decodeURIComponent(String(enc || ''))} -->`,
    );

  body = embedCommentThreads(body, comments);

  // Normalise Confluence URLs and title-based links to stable pageid: references.
  const baseUrl =
    process.env.CONFLUENCE_BASE_URL || process.env.CONFLUENCE_URL || '';
  body = resolveConfluencePageUrls(body, baseUrl);
  body = await resolvePageTitleLinks(body, client, opts.pageCache);

  return {
    title,
    spaceId,
    storageHtml,
    body,
    extras,
    v1,
    unsupportedFeatures,
  };
}

/**
 * Compose the final document: header + body.
 *
 * `existing` is the header of the file already on disk — its READONLY flag and
 * (optionally) its title/spaceId win, so a locally-pinned mapping survives a
 * re-download.
 */
export function composeDocument(
  page: RenderedPage,
  pageId: string,
  existing: HeaderMeta,
  opts: { preferExistingMeta?: boolean } = {},
): string {
  const header = emitHeader({
    readonly: existing.readonly, // preserve READONLY flag if it was set
    pageId,
    spaceId:
      (opts.preferExistingMeta ? existing.spaceId : undefined) ||
      page.spaceId ||
      existing.spaceId,
    title:
      (opts.preferExistingMeta ? existing.title : undefined) || page.title,
    status:
      page.v1?.metadata?.properties?.status?.value ??
      page.extras.status ??
      existing.status,
  });
  return `${header + page.body.trim()}\n`;
}
