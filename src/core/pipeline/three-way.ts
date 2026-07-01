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
  /** Canonical body (no header) of the last-synced base, or null for 2-way. */
  baseBody: string | null;
  /** Canonical body (no header) of the user's current note. */
  localBody: string;
  /** Enriched remote storage HTML. */
  remoteStorageHtml: string;
  remoteComments: RawComment[];
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
  const baseBlocks: SyncBlock[] | null = input.baseBody
    ? toBlocks(input.baseBody)
    : null;

  const result = mergeDocument({
    base: baseBlocks,
    local: localBlocks,
    remote: remoteBlocks,
    existingDetached,
    remoteHeadings: buildHeadingMap(remoteBlocks),
  });

  return { body: result.body, hasConflicts: result.hasConflicts };
}
