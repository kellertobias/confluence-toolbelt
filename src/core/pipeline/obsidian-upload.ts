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
import { remoteMergeBase, sameAsBase, threeWayMerge } from "./three-way.js";

export interface UploadResult {
  status: "uploaded" | "conflict";
  /** New Confluence version (only when status === "uploaded"). */
  newVersion?: number;
  /** The page as the merge reads it right after the upload landed — the base
   * for the next sync (only when status === "uploaded"). */
  baseBlocks?: { nodeId?: string; text: string }[];
  /** Full canonical document that was uploaded, or the merged-with-markers
   * document to surface on conflict. */
  canonical: string;
}

export type UploadSidecar = Pick<
  ObsidianSidecar,
  "comments" | "baseMarkdown" | "baseBlocks" | "version"
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
    const comments = await client.getPageComments(pageId).catch(() => []);
    const enriched = await enrichContentEntityLinks(page.storageHtml, (id) =>
      client.getPageSpaceKey(id),
    );
    const remote = remoteMergeBase(enriched, comments);

    // A higher version number does not mean the page changed. Confluence bumps
    // it for its own reasons — re-saving our upload with `local-id` attributes
    // added, an attachment upload, a label edit. Merging on the version alone
    // meant every upload after the first hit a needless three-way merge. Only
    // merge when the content actually moved.
    if (sidecar.baseBlocks && sameAsBase(sidecar.baseBlocks, remote)) {
      onStep("Remote unchanged…");
    } else {
      onStep("Merging remote changes…");
      const merged = threeWayMerge({
        baseBlocks: sidecar.baseBlocks ?? null,
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

  // Read the page back so the next sync's base is what Confluence actually
  // stored, not what we sent. The two differ: the storage round-trip is not
  // symmetric, and Confluence normalizes on save.
  onStep("Recording base…");
  let newVersion = page.version + 1;
  let baseBlocks: { nodeId?: string; text: string }[] | undefined;
  try {
    const saved = await client.getPageStorage(pageId);
    // Only trust a read that actually reflects our write. Anything else is a
    // stale copy, and recording it would make the next upload think the remote
    // had changed. Better no base than a wrong one.
    if (saved.version > page.version) {
      newVersion = saved.version;
      const savedComments = await client
        .getPageComments(pageId)
        .catch(() => []);
      const savedEnriched = await enrichContentEntityLinks(
        saved.storageHtml,
        (id) => client.getPageSpaceKey(id),
      );
      baseBlocks = remoteMergeBase(savedEnriched, savedComments);
    }
  } catch {
    // Read-back failed: fall through with no base recorded. The next upload
    // falls back to the markdown base.
  }

  return {
    status: "uploaded",
    newVersion,
    baseBlocks,
    canonical: `${emitHeader(meta)}${bodyToUpload.trim()}\n`,
  };
}
