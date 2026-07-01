/**
 * Per-line change detection for the editor change-bar gutter.
 *
 * Pure (no platform deps). Given a `base` snapshot and the `current` text, it
 * reports, for each 0-based line index in `current`, whether that line was
 * added or changed, plus where deletions fall (so the gutter can draw a wedge).
 *
 * Diffing is line-mode (diff-match-patch): we collapse the document to one
 * symbol per line, diff, then expand — fast and stable for whole notes.
 */

import DiffMatchPatch from "diff-match-patch";

export type ChangeKind = "added" | "changed";

export interface LineChanges {
  /** 0-based line index in `current` → kind of change on that line. */
  byLine: Map<number, ChangeKind>;
  /** 0-based indices in `current` with a deletion gap immediately above. */
  removedBefore: Set<number>;
  /** A deletion trails the final line (gap below the last line). */
  removedAtEnd: boolean;
}

/** Normalise so the last line is treated consistently: strip CR and trailing
 * blank lines, then guarantee exactly one trailing newline. This keeps every
 * line — including the last — newline-terminated for the line-mode diff. Empty
 * input stays empty (no phantom blank line). */
function normalize(text: string): string {
  const t = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return t === "" ? "" : `${t}\n`;
}

/** Count document lines a diff chunk spans. Every chunk is newline-terminated
 * after {@link normalize}, so it's just the newline count. */
function lineCount(chunk: string): number {
  let n = 0;
  for (let i = 0; i < chunk.length; i++) if (chunk[i] === "\n") n++;
  return n;
}

export function computeLineChanges(base: string, current: string): LineChanges {
  const byLine = new Map<number, ChangeKind>();
  const removedBefore = new Set<number>();
  let removedAtEnd = false;

  const a = normalize(base);
  const b = normalize(current);
  if (a === b) return { byLine, removedBefore, removedAtEnd };

  const dmp = new DiffMatchPatch();
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);

  const DELETE = -1;
  const INSERT = 1;
  const EQUAL = 0;

  let line = 0; // 0-based index into `current` lines
  for (let i = 0; i < diffs.length; i++) {
    const [op, text] = diffs[i] as [number, string];
    if (op === EQUAL) {
      line += lineCount(text);
      continue;
    }
    if (op === DELETE) {
      const next = diffs[i + 1] as [number, string] | undefined;
      if (next && next[0] === INSERT) {
        // delete-then-insert ⇒ those current lines are modifications.
        const insLines = lineCount(next[1]);
        const delLines = lineCount(text);
        for (let k = 0; k < insLines; k++) byLine.set(line + k, "changed");
        line += insLines;
        // More lines removed than re-inserted: a deletion gap trails the block.
        if (delLines > insLines) removedBefore.add(line);
        i++; // consume the paired insert
      } else {
        // pure deletion ⇒ a gap above the current line (or after the last one).
        removedBefore.add(line);
      }
      continue;
    }
    // pure insertion ⇒ added lines.
    const insLines = lineCount(text);
    for (let k = 0; k < insLines; k++) byLine.set(line + k, "added");
    line += insLines;
  }

  // A deletion recorded at or past the final line is an end-of-document gap.
  const total = lineCount(b);
  if (removedBefore.has(total)) {
    removedBefore.delete(total);
    removedAtEnd = true;
  }

  return { byLine, removedBefore, removedAtEnd };
}
