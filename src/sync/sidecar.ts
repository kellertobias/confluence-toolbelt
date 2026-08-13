/**
 * Sidecar file location for the "last pulled" storage HTML baseline.
 *
 * The sidecar is a hidden file next to a synced markdown document holding the
 * raw Confluence storage HTML from the last successful pull. `sync` uses it as
 * the base of a three-way merge. Hidden + gitignored (see commands/init.ts).
 */

import path from 'node:path';

export function baseSidecarPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.base.confluence`,
  );
}

/**
 * Sidecar holding the exact markdown we last wrote for a file.
 *
 * Why: lets a re-download tell "the user edited this locally" apart from "the
 * remote moved on" without relying on git being present. Hidden + gitignored,
 * same as the storage-HTML baseline.
 */
export function localBaseSidecarPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.base.md`,
  );
}
