/**
 * Download a Confluence page and produce Obsidian markdown + sidecar.
 *
 * storage HTML → (enrich links) → canonical markdown → Obsidian dialect.
 * Platform-agnostic: the caller supplies the client, an id generator, and the
 * download timestamp (kept injectable for deterministic tests).
 */

import type { ConfluenceClient } from "../../api.js";
import type { HeaderMeta } from "../../md-header.js";
import { enrichContentEntityLinks } from "../../storage-dom/enrich-links.js";
import {
  canonicalToObsidian,
  type ObsidianSidecar,
} from "../dialect/obsidian.js";
import { storageToCanonical } from "./storage-to-canonical.js";
import { remoteMergeBase } from "./three-way.js";

export interface DownloadResult {
  title: string;
  version: number;
  markdown: string;
  sidecar: ObsidianSidecar;
}

export interface DownloadOptions {
  genId: () => string;
  /** ISO timestamp recorded as confluenceDownloadedAt. */
  now: string;
  /** Optional status to seed the header (from page properties). */
  status?: string;
  /** Optional step-progress callback. */
  onStep?: (message: string) => void;
  /** Confluence marker refs of comments resolved locally — excluded from the
   * download so they don't reappear. */
  resolvedRefs?: string[];
}

export async function downloadPageToObsidian(
  client: ConfluenceClient,
  pageId: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const step = opts.onStep ?? (() => {});
  step("Fetching page…");
  const page = await client.getPageStorage(pageId);
  step("Fetching comments…");
  let comments = await client.getPageComments(pageId).catch(() => []);
  if (opts.resolvedRefs?.length) {
    const resolved = new Set(opts.resolvedRefs);
    comments = comments.filter(
      (c: any) => !resolved.has(c?.extensions?.inlineProperties?.markerRef),
    );
  }
  step("Resolving links…");
  const enriched = await enrichContentEntityLinks(page.storageHtml, (id) =>
    client.getPageSpaceKey(id),
  );
  step("Converting…");

  const meta: HeaderMeta = {
    pageId,
    spaceId: page.spaceId,
    title: page.title,
    status: opts.status,
  };
  const canonical = storageToCanonical(enriched, comments, meta);

  const { markdown, sidecar } = canonicalToObsidian(canonical, {
    version: page.version,
    downloadedAt: opts.now,
    genId: opts.genId,
  });
  // Record the remote exactly as a later merge will read it, so an unchanged
  // page compares equal instead of drifting through the markdown round-trip.
  sidecar.baseBlocks = remoteMergeBase(enriched, comments);

  return { title: page.title, version: page.version, markdown, sidecar };
}
