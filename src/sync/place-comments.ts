/**
 * Extract remote comments from a block and place them around the user's
 * edited text. Comments whose anchor text no longer appears (even fuzzily)
 * are detached — the caller collects these for the Detached Comments section.
 */

import DiffMatchPatch from 'diff-match-patch';

export interface CommentInfo {
  uuid: string;
  threadTags: string; // concatenated <!-- # Author: body --> tags
  anchorText: string;
  /** Character position of the comment start in the marker-free remote text. */
  strippedPos: number;
}

export interface DetachedComment {
  uuid: string;
  threadTags: string;
  anchorText: string;
}

export interface PlaceResult {
  merged: string;
  detached: DetachedComment[];
}

const COMMENT_START_RE = /<!--\s*comment:([^\s>]+)\s*-->/g;
const ANY_COMMENT_MARKER_RE =
  /<!--\s*(?:comment:[^>]*?|commend-end:[^>]*?|#[\s\S]*?)-->/g;

/**
 * Strip every comment-related marker from a string. Used to reconcile the
 * marker-free text for alignment and placement.
 */
export function stripCommentMarkers(text: string): string {
  return text.replace(ANY_COMMENT_MARKER_RE, '');
}

/**
 * Find every comment in a block and return their IDs, thread content, anchor
 * text, and approximate positions in the marker-free version of the text.
 */
export function extractComments(text: string): {
  stripped: string;
  comments: CommentInfo[];
} {
  const stripped = stripCommentMarkers(text);
  const comments: CommentInfo[] = [];

  COMMENT_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COMMENT_START_RE.exec(text))) {
    const uuid = m[1] ?? '';
    if (!uuid) continue;
    const startIdx = m.index;
    let cursor = startIdx + m[0].length;

    // Absorb adjacent <!-- # Author: body --> thread tags.
    let threadTags = '';
    const threadRe = /<!--\s*#[\s\S]*?-->/y;
    while (true) {
      threadRe.lastIndex = cursor;
      const tm = threadRe.exec(text);
      if (!tm) break;
      threadTags += tm[0];
      cursor = threadRe.lastIndex;
      // Allow whitespace between adjacent thread tags.
      while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor++;
    }

    const endRe = new RegExp(
      `<!--\\s*commend-end:${escapeRegex(uuid)}\\s*-->`,
    );
    const rest = text.slice(cursor);
    const endMatch = endRe.exec(rest);
    if (!endMatch) continue; // unbalanced; skip rather than corrupt output
    const endIdx = cursor + endMatch.index;

    const rawAnchor = text.slice(cursor, endIdx);
    const anchorText = stripCommentMarkers(rawAnchor);
    const strippedPos = stripCommentMarkers(text.slice(0, startIdx)).length;

    comments.push({ uuid, threadTags, anchorText, strippedPos });
  }

  return { stripped, comments };
}

/**
 * Place remote comments around the corresponding text in a local (edited)
 * block. Local markers are stripped first — remote is the source of truth for
 * which comments exist. Comments whose anchors can't be located are returned
 * in `detached`.
 */
export function placeComments(
  localText: string,
  remoteText: string,
): PlaceResult {
  const cleanLocal = stripCommentMarkers(localText);
  const { comments } = extractComments(remoteText);

  interface Placement {
    start: number;
    end: number;
    uuid: string;
    threadTags: string;
  }
  const placements: Placement[] = [];
  const detached: DetachedComment[] = [];

  const dmp = new DiffMatchPatch();
  dmp.Match_Threshold = 0.5;
  dmp.Match_Distance = 1000;

  for (const c of comments) {
    if (!c.anchorText) {
      // Zero-length anchor: nothing to wrap. Confluence still tracks these via
      // the comment itself; we keep it as detached so nothing is lost.
      detached.push({
        uuid: c.uuid,
        threadTags: c.threadTags,
        anchorText: c.anchorText,
      });
      continue;
    }

    const found = locateAnchor(cleanLocal, c, dmp);
    if (found === -1) {
      detached.push({
        uuid: c.uuid,
        threadTags: c.threadTags,
        anchorText: c.anchorText,
      });
      continue;
    }

    const end = Math.min(found + c.anchorText.length, cleanLocal.length);
    // If another comment already claims this range, fall back to detached
    // rather than produce overlapping markers.
    const overlaps = placements.some(
      (p) => !(end <= p.start || found >= p.end),
    );
    if (overlaps) {
      detached.push({
        uuid: c.uuid,
        threadTags: c.threadTags,
        anchorText: c.anchorText,
      });
      continue;
    }

    placements.push({
      start: found,
      end,
      uuid: c.uuid,
      threadTags: c.threadTags,
    });
  }

  // Apply right-to-left so earlier placements' indexes stay valid.
  placements.sort((a, b) => b.start - a.start);
  let merged = cleanLocal;
  for (const p of placements) {
    const before = merged.slice(0, p.start);
    const anchor = merged.slice(p.start, p.end);
    const after = merged.slice(p.end);
    merged = `${before}<!-- comment:${p.uuid} -->${p.threadTags}${anchor}<!-- commend-end:${p.uuid} -->${after}`;
  }

  return { merged, detached };
}

function locateAnchor(
  text: string,
  c: CommentInfo,
  dmp: DiffMatchPatch,
): number {
  if (!c.anchorText) return -1;

  // Exact match: if unique, done. If multiple, prefer the occurrence closest
  // to the original position (users usually preserve relative ordering).
  const occurrences: number[] = [];
  let idx = text.indexOf(c.anchorText);
  while (idx !== -1) {
    occurrences.push(idx);
    idx = text.indexOf(c.anchorText, idx + 1);
  }
  if (occurrences.length > 0) {
    return occurrences.reduce((best, cur) =>
      Math.abs(cur - c.strippedPos) < Math.abs(best - c.strippedPos)
        ? cur
        : best,
    );
  }

  // Fuzzy match — anchor text survives small edits inside the commented range.
  // match_main's pattern is limited to 32 chars on most builds, so for long
  // anchors we search for a shorter key derived from the start of the anchor.
  const key = c.anchorText.length > 28 ? c.anchorText.slice(0, 28) : c.anchorText;
  const loc = Math.min(Math.max(c.strippedPos, 0), text.length);
  const hit = dmp.match_main(text, key, loc);
  return hit;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
