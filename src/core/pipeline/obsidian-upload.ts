/**
 * Upload an Obsidian note back to Confluence, with version-based conflict
 * detection (git's replacement on mobile).
 *
 * Obsidian markdown + sidecar → canonical markdown. If Confluence's version has
 * advanced past the sidecar's recorded version, someone edited online: run a
 * three-way merge (base = sidecar.baseMarkdown). Clean → push the merged result;
 * conflicting → return the merged-with-markers canonical without pushing so the
 * caller can surface it for resolution.
 */

import type { ConfluenceClient } from "../../api.js";
import { emitHeader, parseHeader } from "../../md-header.js";
import { enrichContentEntityLinks } from "../../storage-dom/enrich-links.js";
import { markdownToStorageHtml } from "../../storage-dom.js";
import { obsidianToCanonical, type ObsidianSidecar } from "../dialect/obsidian.js";
import { threeWayMerge } from "./three-way.js";

export interface UploadResult {
  status: "uploaded" | "conflict";
  /** New Confluence version (only when status === "uploaded"). */
  newVersion?: number;
  /** Full canonical document that was uploaded, or the merged-with-markers
   * document to surface on conflict. */
  canonical: string;
}

export type UploadSidecar = Pick<
  ObsidianSidecar,
  "comments" | "baseMarkdown" | "version"
>;

export async function uploadObsidianPage(
  client: ConfluenceClient,
  pageId: string,
  obsidianMarkdown: string,
  sidecar: UploadSidecar,
  onStep: (message: string) => void = () => {},
): Promise<UploadResult> {
  onStep("Converting…");
  const localCanonical = obsidianToCanonical(obsidianMarkdown, sidecar);
  const { meta, body: localBody } = parseHeader(localCanonical);

  onStep("Checking remote version…");
  const page = await client.getPageStorage(pageId);

  let bodyToUpload = localBody;
  const remoteAdvanced =
    sidecar.version !== undefined && page.version !== sidecar.version;

  if (remoteAdvanced) {
    onStep("Merging remote changes…");
    const comments = await client.getPageComments(pageId).catch(() => []);
    const enriched = await enrichContentEntityLinks(page.storageHtml, (id) =>
      client.getPageSpaceKey(id),
    );
    const merged = threeWayMerge({
      baseBody: sidecar.baseMarkdown || null,
      localBody,
      remoteStorageHtml: enriched,
      remoteComments: comments,
    });
    if (merged.hasConflicts) {
      return {
        status: "conflict",
        canonical: `${emitHeader(meta)}${merged.body.trim()}\n`,
      };
    }
    bodyToUpload = merged.body;
  }

  onStep("Publishing…");
  const storageHtml = markdownToStorageHtml(bodyToUpload);
  await client.updatePageStorage(
    pageId,
    storageHtml,
    page.version,
    meta.title || page.title,
    meta.spaceId || page.spaceId,
  );

  return {
    status: "uploaded",
    newVersion: page.version + 1,
    canonical: `${emitHeader(meta)}${bodyToUpload.trim()}\n`,
  };
}
