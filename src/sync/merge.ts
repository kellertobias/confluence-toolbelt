/**
 * Three-way block merge orchestrator for `sync`.
 *
 * Produces the merged body of a synced markdown file plus the running list of
 * detached comments. Uses `align.ts` to match base↔local blocks (tolerant of
 * missing nodeIds and edits), `place-comments.ts` to attach comments to the
 * edited text, and `conflict.ts` to emit markers when both sides diverged.
 */

import { emitTag } from '../inline-tags.js';
import { AlignBlock, alignBlocks, canonicalText } from './align.js';
import { emitConflictBlock } from './conflict.js';
import {
  buildLocator,
  DetachedEntry,
  emitDetachedSection,
} from './detached.js';
import { extractComments, placeComments, stripCommentMarkers } from './place-comments.js';

export interface SyncBlock {
  nodeId?: string;
  /** Block body in markdown; for remote blocks this still contains comment markers. */
  text: string;
}

export interface MergeInput {
  /** Blocks from the last-known remote (base). May be empty when no base exists. */
  base: SyncBlock[] | null;
  /** Blocks from the user's current file. */
  local: SyncBlock[];
  /** Blocks from the fresh Confluence pull, with inline comment markers. */
  remote: SyncBlock[];
  /** Detached entries already present in the local file, keyed by uuid. */
  existingDetached: DetachedEntry[];
  /** Map of nodeId → nearest preceding heading in the remote doc. */
  remoteHeadings: Record<string, string>;
}

export interface MergeResult {
  body: string;
  hasConflicts: boolean;
  /** Final list of detached entries after reconciliation. */
  detached: DetachedEntry[];
  /** Count of comments that fell into the detached bucket this run. */
  newlyDetachedCount: number;
}

export function mergeDocument(input: MergeInput): MergeResult {
  const { local, remote, existingDetached, remoteHeadings } = input;
  const base = input.base ?? remote; // fallback: treat remote as pseudo-base
  const twoWay = input.base === null;

  // base↔remote: prefer nodeId match; fall back to text alignment for blocks
  // that Confluence didn't assign a nodeId (e.g. newly-created pages).
  const baseToRemote = buildBaseToRemoteMap(base, remote);
  const remoteConsumed = new Set<number>();

  // base↔local via the tolerant aligner.
  const { localToBase } = alignBlocks(base as AlignBlock[], local as AlignBlock[]);

  const out: string[] = [];
  const detachedFromMerge: DetachedEntry[] = [];
  let hasConflicts = false;

  const pushDetached = (
    remoteIdx: number,
    entries: { uuid: string; threadTags: string; anchorText: string }[],
  ) => {
    const remoteBlock = remote[remoteIdx];
    const section = remoteBlock?.nodeId
      ? remoteHeadings[remoteBlock.nodeId] ?? ''
      : '';
    for (const e of entries) {
      detachedFromMerge.push({
        uuid: e.uuid,
        threadTags: e.threadTags,
        anchorText: buildLocator(e.threadTags, section) || e.anchorText || '(no context)',
      });
    }
  };

  // Walk local blocks in their current order.
  for (let j = 0; j < local.length; j++) {
    const lb = local[j];
    if (!lb) continue;
    const i = localToBase[j] ?? -1;

    if (i === -1) {
      // Local-only: new content the user added offline. No comments to merge.
      out.push(renderBlock(lb));
      continue;
    }

    const k = baseToRemote[i] ?? -1;
    if (k === -1) {
      // Base block has no remote counterpart (deleted on server). Keep local.
      out.push(renderBlock(lb));
      continue;
    }

    const bb = base[i];
    const rb = remote[k];
    if (!bb || !rb) {
      out.push(renderBlock(lb));
      continue;
    }
    remoteConsumed.add(k);

    const localCanon = canonicalText(lb.text);
    const baseCanon = canonicalText(bb.text);
    const remoteCanon = canonicalText(rb.text);

    const localUnchanged = localCanon === baseCanon;
    const remoteUnchanged = remoteCanon === baseCanon;
    const sameResult = localCanon === remoteCanon;

    if (twoWay) {
      // Without a base we can't classify; keep local text, port remote comments.
      if (sameResult) {
        out.push(renderRemoteBlock(rb, lb));
      } else {
        const { merged, detached } = placeComments(lb.text, rb.text);
        out.push(renderBlockWithText(lb, merged));
        if (detached.length > 0) pushDetached(k, detached);
      }
      continue;
    }

    if (localUnchanged) {
      // User didn't touch it — remote wins (picks up any new comments / edits).
      out.push(renderRemoteBlock(rb, lb));
    } else if (remoteUnchanged) {
      // Only local changed — keep local text, reattach any still-anchorable comments.
      const { merged, detached } = placeComments(lb.text, rb.text);
      out.push(renderBlockWithText(lb, merged));
      if (detached.length > 0) pushDetached(k, detached);
    } else if (sameResult) {
      // Both changed to the same thing — take remote (has whatever comments exist).
      out.push(renderRemoteBlock(rb, lb));
    } else {
      // Both changed differently — conflict.
      hasConflicts = true;
      out.push(
        renderBlockWithText(
          lb,
          emitConflictBlock({
            localText: stripCommentMarkers(lb.text).trim(),
            remoteText: rb.text.trim(),
          }),
        ),
      );
    }
  }

  // Remote blocks that nothing local consumed fall into two groups.
  for (let k = 0; k < remote.length; k++) {
    if (remoteConsumed.has(k)) continue;
    const rb = remote[k];
    if (!rb) continue;
    // Is there a base block this remote matches? If so the user deleted it
    // locally; detach its comments instead of resurrecting the block.
    const baseIdxForRemote = remoteToBaseIndex(baseToRemote, k);
    if (baseIdxForRemote !== -1 && !twoWay) {
      const { comments } = extractComments(rb.text);
      pushDetached(k, comments);
      continue;
    }
    // Remote-only (new on server) — append with comments intact.
    out.push(renderBlock(rb));
  }

  // Reconcile detached list: drop entries whose uuid now appears in the body,
  // drop entries whose uuid isn't present anywhere on remote, keep others.
  const bodyText = out.join('\n\n');
  const placedUuids = new Set<string>();
  {
    const re = /<!--\s*comment:([^\s>]+)\s*-->/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bodyText))) {
      if (m[1]) placedUuids.add(m[1]);
    }
  }
  const remoteUuids = collectRemoteCommentUuids(remote);

  const combined = new Map<string, DetachedEntry>();
  for (const e of existingDetached) {
    if (placedUuids.has(e.uuid)) continue; // moved back into the body
    if (!remoteUuids.has(e.uuid)) continue; // no longer exists remotely
    combined.set(e.uuid, e);
  }
  for (const e of detachedFromMerge) {
    if (placedUuids.has(e.uuid)) continue;
    if (!remoteUuids.has(e.uuid)) continue;
    // Prefer the freshly-computed locator over an existing one.
    combined.set(e.uuid, e);
  }
  const finalDetached = Array.from(combined.values());

  const body = `${bodyText.trim()}${emitDetachedSection(finalDetached)}`;

  return {
    body,
    hasConflicts,
    detached: finalDetached,
    newlyDetachedCount: detachedFromMerge.length,
  };
}

function renderBlock(b: SyncBlock): string {
  if (b.nodeId) {
    return `${emitTag({ tagType: 'content', nodeId: b.nodeId })}${b.text}`;
  }
  return b.text;
}

function renderBlockWithText(b: SyncBlock, text: string): string {
  if (b.nodeId) {
    return `${emitTag({ tagType: 'content', nodeId: b.nodeId })}${text}`;
  }
  return text;
}

function renderRemoteBlock(remote: SyncBlock, local: SyncBlock): string {
  // Remote is authoritative but we may want to keep the local block's tag
  // (e.g., if local has a stable nodeId the user can see). In practice
  // remote always carries its own nodeId, which is what we want.
  const nodeId = remote.nodeId ?? local.nodeId;
  if (nodeId) {
    return `${emitTag({ tagType: 'content', nodeId })}${remote.text}`;
  }
  return remote.text;
}

function buildBaseToRemoteMap(base: SyncBlock[], remote: SyncBlock[]): number[] {
  // Pass 1: match by nodeId (fast, unambiguous).
  const remoteById = new Map<string, number>();
  for (let k = 0; k < remote.length; k++) {
    const id = remote[k]?.nodeId;
    if (id) remoteById.set(id, k);
  }
  const out: number[] = new Array(base.length).fill(-1);
  const remoteUsed = new Set<number>();
  for (let i = 0; i < base.length; i++) {
    const id = base[i]?.nodeId;
    if (!id) continue;
    const k = remoteById.get(id);
    if (k !== undefined) {
      out[i] = k;
      remoteUsed.add(k);
    }
  }

  // Pass 2: text-based alignment for blocks without nodeIds, using the same
  // tolerant aligner used for base↔local. This handles pages where Confluence
  // didn't assign data-node-id attributes.
  const unmappedBase = base
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => out[i] === -1);
  const unmappedRemote = remote
    .map((b, k) => ({ b, k }))
    .filter(({ k }) => !remoteUsed.has(k));

  if (unmappedBase.length > 0 && unmappedRemote.length > 0) {
    const { baseToLocal: baseToUnmappedRemote } = alignBlocks(
      unmappedBase.map(({ b }) => b as AlignBlock),
      unmappedRemote.map(({ b }) => b as AlignBlock),
    );
    for (let ui = 0; ui < unmappedBase.length; ui++) {
      const uk = baseToUnmappedRemote[ui];
      if (uk === -1 || uk === undefined) continue;
      const originalBaseIdx = unmappedBase[ui]?.i;
      const originalRemoteIdx = unmappedRemote[uk]?.k;
      if (originalBaseIdx !== undefined && originalRemoteIdx !== undefined) {
        out[originalBaseIdx] = originalRemoteIdx;
      }
    }
  }

  return out;
}

function remoteToBaseIndex(baseToRemote: number[], k: number): number {
  for (let i = 0; i < baseToRemote.length; i++) {
    if (baseToRemote[i] === k) return i;
  }
  return -1;
}

function collectRemoteCommentUuids(remote: SyncBlock[]): Set<string> {
  const uuids = new Set<string>();
  for (const b of remote) {
    const re = /<!--\s*comment:([^\s>]+)\s*-->/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b.text))) {
      if (m[1]) uuids.add(m[1]);
    }
  }
  return uuids;
}

/**
 * Build a nodeId → nearest-preceding-heading map from the remote block list,
 * used to label detached comments with "Author @ Section".
 */
export function buildHeadingMap(blocks: SyncBlock[]): Record<string, string> {
  const out: Record<string, string> = {};
  let current = '';
  for (const b of blocks) {
    const headingMatch = b.text.match(/^\s*#{1,6}\s+(.+?)\s*$/m);
    if (headingMatch) {
      current = (headingMatch[1] ?? '').trim();
    }
    if (b.nodeId) out[b.nodeId] = current;
  }
  return out;
}
