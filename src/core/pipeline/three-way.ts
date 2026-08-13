/**
 * Three-way merge over canonical markdown, reusing the sync engine.
 *
 * base    = sidecar.baseMarkdown (canonical body at last sync)
 * local   = the user's current note, converted to canonical
 * remote  = a fresh Confluence pull (storage HTML + comments)
 *
 * Returns the merged canonical body and whether git-style conflict markers were
 * emitted. Pure (no platform deps).
 */

import { parseBlocks } from "../../inline-tags.js";
import {
  blocksFromStorage,
  type RawComment,
} from "../../sync/blocks-from-storage.js";
import { splitDetachedSection } from "../../sync/detached.js";
import { buildHeadingMap, mergeDocument, type SyncBlock } from "../../sync/merge.js";

export interface ThreeWayInput {
  /**
   * The last-synced remote, already in block form — the exact output of
   * `remoteMergeBase` at the previous sync. Preferred over `baseBody`.
   *
   * Why it matters: the base has to be expressed the way the *merge* reads the
   * remote, not the way the note is written. Deriving it from canonical
   * markdown instead loses the distinction — re-parsing splits any block that
   * contains a blank line, and normalizes whitespace the storage converter
   * emits — so nearly every block looked "changed on the remote" even when
   * Confluence held exactly what we last uploaded, and any block the user had
   * also edited became a conflict.
   */
  baseBlocks?: SyncBlock[] | null;
  /** Canonical body of the last-synced base. Fallback for sidecars written
   * before `baseBlocks` was recorded, and for the 2-way case (null). */
  baseBody: string | null;
  /** Canonical body (no header) of the user's current note. */
  localBody: string;
  /** Enriched remote storage HTML. */
  remoteStorageHtml: string;
  remoteComments: RawComment[];
}

/**
 * The merge's view of a remote page: the block list a later merge will compare
 * against. Persist this at every sync point as the next merge's base.
 */
export function remoteMergeBase(
  storageHtml: string,
  comments: RawComment[] = [],
): SyncBlock[] {
  return blocksFromStorage(storageHtml, comments);
}

/** True when the remote holds exactly what the base recorded. */
export function sameAsBase(base: SyncBlock[], remote: SyncBlock[]): boolean {
  if (base.length !== remote.length) return false;
  return base.every(
    (b, i) => b.text === remote[i]?.text && b.nodeId === remote[i]?.nodeId,
  );
}

export interface ThreeWayResult {
  body: string;
  hasConflicts: boolean;
}

function toBlocks(canonicalBody: string): SyncBlock[] {
  const { content } = splitDetachedSection(canonicalBody);
  return parseBlocks(content).map((b) => ({
    nodeId: b.tag?.nodeId,
    text: b.text,
  }));
}

export function threeWayMerge(input: ThreeWayInput): ThreeWayResult {
  const { content: localContent, detached: existingDetached } =
    splitDetachedSection(input.localBody);
  const localBlocks: SyncBlock[] = parseBlocks(localContent).map((b) => ({
    nodeId: b.tag?.nodeId,
    text: b.text,
  }));
  const remoteBlocks: SyncBlock[] = blocksFromStorage(
    input.remoteStorageHtml,
    input.remoteComments,
  );
  const baseBlocks: SyncBlock[] | null =
    input.baseBlocks ?? (input.baseBody ? toBlocks(input.baseBody) : null);

  const result = mergeDocument({
    base: baseBlocks,
    local: localBlocks,
    remote: remoteBlocks,
    existingDetached,
    remoteHeadings: buildHeadingMap(remoteBlocks),
  });

  return { body: result.body, hasConflicts: result.hasConflicts };
}
