/**
 * Decide whether overwriting a local markdown file would destroy local edits.
 *
 * Baseline priority (mirrors `base-source.ts`):
 *   1. `.<name>.base.md` sidecar — the exact markdown we last wrote.
 *   2. Git HEAD of the file — what was last committed (downloads auto-commit).
 *   3. Unknown — no baseline, so we cannot promise the file is untouched.
 *
 * Callers treat `unknown` conservatively (skip unless forced): a file we have
 * no record of writing may well be hand-authored.
 */

import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { localBaseSidecarPath } from './sidecar.js';

export type LocalState = 'missing' | 'clean' | 'dirty' | 'unknown';

/** Ignore line-ending and trailing-newline noise when comparing. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

export function writeLocalBaseSidecar(
  filePath: string,
  markdown: string,
): void {
  fs.writeFileSync(localBaseSidecarPath(filePath), markdown ?? '', 'utf8');
}

/**
 * Classify a local file against the last version we wrote.
 *
 * @param cwd Repository root (for the git fallback).
 * @param filePath Absolute path of the markdown file.
 */
export async function detectLocalChanges(
  cwd: string,
  filePath: string,
): Promise<LocalState> {
  if (!fs.existsSync(filePath)) {
    return 'missing';
  }
  const current = normalize(fs.readFileSync(filePath, 'utf8'));

  const sidecar = localBaseSidecarPath(filePath);
  if (fs.existsSync(sidecar)) {
    try {
      const base = normalize(fs.readFileSync(sidecar, 'utf8'));
      return current === base ? 'clean' : 'dirty';
    } catch {
      // fall through to git
    }
  }

  try {
    const git = simpleGit({ baseDir: cwd });
    const rel = path.isAbsolute(filePath)
      ? path.relative(cwd, filePath)
      : filePath;
    const head = await git.show([`HEAD:${rel}`]);
    if (typeof head === 'string' && head.length > 0) {
      return current === normalize(head) ? 'clean' : 'dirty';
    }
  } catch {
    // not a repo, or the file was never committed
  }

  return 'unknown';
}
