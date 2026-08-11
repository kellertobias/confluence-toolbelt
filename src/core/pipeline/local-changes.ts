/**
 * Decide whether a note holds edits that aren't in Confluence yet.
 *
 * This is the question behind "may I overwrite this note?". A page that only
 * moved on remotely has nothing to lose, so the download path must not warn
 * about it — the warning is reserved for notes the user actually changed.
 *
 * Pure so both hosts can share it and it can be tested without a vault: the
 * caller does the I/O and passes the note content, the recorded base, and the
 * mtime in.
 */

import { parseFrontmatter } from "../dialect/frontmatter.js";

export interface LocalChangeInputs {
  /** The note as stored, frontmatter included. `null` when it doesn't exist. */
  content: string | null;
  /** The note body at last sync (the sidecar's `baseObsidian`), if recorded. */
  base?: string | undefined;
  /** The note's modification time, for the no-base fallback. */
  mtime?: number | undefined;
  /** Answer to use when there is no recorded base, instead of the heuristic. */
  fallback?: boolean | undefined;
}

/** Line endings and trailing blank lines are not edits. */
function normalizeBody(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/**
 * Tolerance for the mtime fallback: the download's own write lands just after
 * the timestamp it records, and must not read as a user edit.
 */
const WRITE_TOLERANCE_MS = 10_000;

export function hasLocalChanges(input: LocalChangeInputs): boolean {
  if (input.content === null) {
    return false; // nothing there to overwrite
  }

  const { props, body } = parseFrontmatter(input.content);

  // The precise answer: compare the body against what we last wrote. Only the
  // body counts — the frontmatter carries sync bookkeeping (version, timestamp)
  // that the download itself rewrites.
  if (input.base != null) {
    return normalizeBody(body) !== normalizeBody(input.base);
  }

  if (input.fallback !== undefined) {
    return input.fallback;
  }

  // No recorded base (a note synced before one was kept): fall back to asking
  // whether the file was touched after the download that produced it.
  const downloadedAt = props.confluenceDownloadedAt;
  if (downloadedAt == null || input.mtime === undefined) {
    return true; // no baseline at all — assume changes rather than clobber
  }
  const at = Date.parse(String(downloadedAt));
  if (Number.isNaN(at)) {
    return true;
  }
  return input.mtime - at > WRITE_TOLERANCE_MS;
}
