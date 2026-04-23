/**
 * Align base↔local markdown blocks for three-way merge.
 *
 * Produces a mapping between block indices in the base (last-known remote) and
 * local (user-edited) block lists, using:
 *   1. nodeId match (strong)
 *   2. exact canonical-text match (strong)
 *   3. fuzzy similarity via diff-match-patch (weak, above threshold)
 *
 * Blocks that don't map end up as base-only (deleted locally) or local-only
 * (added locally). The returned similarity score lets callers distinguish
 * "user didn't touch this" (≈1.0) from "user edited this" (lower).
 */

import DiffMatchPatch from 'diff-match-patch';

export interface AlignBlock {
  nodeId?: string;
  text: string;
}

export interface Alignment {
  /** base[i] maps to local[baseToLocal[i]]; -1 means base-only */
  baseToLocal: number[];
  /** local[j] maps to base[localToBase[j]]; -1 means local-only */
  localToBase: number[];
  /** similarity for each base[i] ↔ local[baseToLocal[i]] pair, 1.0 for exact */
  similarity: number[];
}

const FUZZY_THRESHOLD = 0.45;

export function alignBlocks(
  baseBlocks: AlignBlock[],
  localBlocks: AlignBlock[],
): Alignment {
  const b2l: number[] = new Array(baseBlocks.length).fill(-1);
  const l2b: number[] = new Array(localBlocks.length).fill(-1);
  const sim: number[] = new Array(baseBlocks.length).fill(0);

  const baseCanonical = baseBlocks.map((b) => canonicalText(b.text));
  const localCanonical = localBlocks.map((b) => canonicalText(b.text));

  // Pass 1: nodeId matches — unambiguous and strong.
  for (let i = 0; i < baseBlocks.length; i++) {
    const baseId = baseBlocks[i]?.nodeId;
    if (!baseId) continue;
    for (let j = 0; j < localBlocks.length; j++) {
      if (l2b[j] !== -1) continue;
      if (localBlocks[j]?.nodeId === baseId) {
        b2l[i] = j;
        l2b[j] = i;
        const baseText = baseCanonical[i] ?? '';
        const localText = localCanonical[j] ?? '';
        sim[i] = baseText === localText ? 1 : similarity(baseText, localText);
        break;
      }
    }
  }

  // Pass 2: exact canonical-text matches for unmapped blocks, preferring
  // nearest-by-position to keep order stable in the common case.
  for (let i = 0; i < baseBlocks.length; i++) {
    if (b2l[i] !== -1) continue;
    const baseText = baseCanonical[i] ?? '';
    if (!baseText) continue;
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < localBlocks.length; j++) {
      if (l2b[j] !== -1) continue;
      if (localCanonical[j] === baseText) {
        const dist = Math.abs(j - i);
        if (dist < bestDist) {
          bestDist = dist;
          best = j;
        }
      }
    }
    if (best !== -1) {
      b2l[i] = best;
      l2b[best] = i;
      sim[i] = 1;
    }
  }

  // Pass 3: fuzzy DP alignment over the remaining unmapped blocks. This
  // preserves order (no reshuffling), which matches how users actually edit
  // documents — inserting, deleting, and rewriting in place.
  const baseRemaining: number[] = [];
  const localRemaining: number[] = [];
  for (let i = 0; i < baseBlocks.length; i++) {
    if (b2l[i] === -1) baseRemaining.push(i);
  }
  for (let j = 0; j < localBlocks.length; j++) {
    if (l2b[j] === -1) localRemaining.push(j);
  }

  if (baseRemaining.length > 0 && localRemaining.length > 0) {
    const pairs = fuzzyAlign(
      baseRemaining.map((i) => baseCanonical[i] ?? ''),
      localRemaining.map((j) => localCanonical[j] ?? ''),
    );
    for (const [ri, rj, score] of pairs) {
      const i = baseRemaining[ri];
      const j = localRemaining[rj];
      if (i === undefined || j === undefined) continue;
      b2l[i] = j;
      l2b[j] = i;
      sim[i] = score;
    }
  }

  return { baseToLocal: b2l, localToBase: l2b, similarity: sim };
}

/**
 * Needleman–Wunsch over two lists of canonical block texts. Matches only stick
 * when similarity clears FUZZY_THRESHOLD; otherwise blocks fall through as
 * gaps (base-only / local-only) rather than being forced into bad pairings.
 */
function fuzzyAlign(
  a: string[],
  b: string[],
): Array<[number, number, number]> {
  const n = a.length;
  const m = b.length;
  const gap = -0.3;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  const back: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  // 0 = diagonal (match/mismatch), 1 = up (gap in b), 2 = left (gap in a)
  for (let i = 1; i <= n; i++) {
    dp[i]![0] = i * gap;
    back[i]![0] = 1;
  }
  for (let j = 1; j <= m; j++) {
    dp[0]![j] = j * gap;
    back[0]![j] = 2;
  }

  const cache = new Map<string, number>();
  const score = (ai: number, bj: number): number => {
    const key = `${ai}\u0000${bj}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const s = similarity(a[ai] ?? '', b[bj] ?? '');
    // Penalize sub-threshold matches so the aligner prefers gaps.
    const adjusted = s >= FUZZY_THRESHOLD ? s : s - 1;
    cache.set(key, adjusted);
    return adjusted;
  };

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1]![j - 1]! + score(i - 1, j - 1);
      const up = dp[i - 1]![j]! + gap;
      const left = dp[i]![j - 1]! + gap;
      let best = diag;
      let dir = 0;
      if (up > best) {
        best = up;
        dir = 1;
      }
      if (left > best) {
        best = left;
        dir = 2;
      }
      dp[i]![j] = best;
      back[i]![j] = dir;
    }
  }

  const pairs: Array<[number, number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const dir = back[i]![j]!;
    if (dir === 0) {
      const s = similarity(a[i - 1] ?? '', b[j - 1] ?? '');
      if (s >= FUZZY_THRESHOLD) {
        pairs.push([i - 1, j - 1, s]);
      }
      i -= 1;
      j -= 1;
    } else if (dir === 1) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return pairs;
}

/**
 * Strip comment markers and normalize whitespace so alignment compares the
 * user-visible text, not incidental tooling artifacts.
 */
export function canonicalText(text: string): string {
  return text
    .replace(/<!--\s*node:[^>]*?-->/g, '')
    .replace(/<!--\s*comment:[^>]*?-->/g, '')
    .replace(/<!--\s*commend-end:[^>]*?-->/g, '')
    .replace(/<!--\s*#[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Similarity in [0, 1] derived from diff-match-patch edit distance.
 * 1.0 = identical; 0.0 = completely different.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 0.5;
  const diffs = dmp.diff_main(a, b);
  dmp.diff_cleanupSemantic(diffs);
  let edits = 0;
  for (const [op, text] of diffs) {
    if (op !== 0) edits += text.length;
  }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return Math.max(0, 1 - edits / (maxLen * 2));
}
