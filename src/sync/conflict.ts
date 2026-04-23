/**
 * Git-style conflict markers for blocks that were edited on both sides.
 *
 * The format matches `git merge` so editors and users already know what to
 * do. `sync` refuses to upload a file containing unresolved markers and
 * detects them here on the next run.
 */

export interface ConflictBlock {
  localText: string;
  remoteText: string;
}

export function emitConflictBlock(b: ConflictBlock): string {
  return [
    '<<<<<<< LOCAL',
    b.localText,
    '=======',
    b.remoteText,
    '>>>>>>> REMOTE (confluence)',
  ].join('\n');
}

const CONFLICT_RE = /^<{7} LOCAL$[\s\S]*?^={7}$[\s\S]*?^>{7} REMOTE/m;

export function hasUnresolvedConflicts(text: string): boolean {
  return CONFLICT_RE.test(text);
}
