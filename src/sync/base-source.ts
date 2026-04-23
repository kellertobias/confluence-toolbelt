/**
 * Resolve the "base" version of a synced markdown file — the last-known remote
 * state — used as the third leg of the three-way merge in `sync`.
 *
 * Priority:
 *   1. Sidecar `.<name>.base.confluence` (raw Confluence storage HTML).
 *   2. Git HEAD of the file (markdown we've already rendered at last pull).
 *   3. None — caller falls back to a 2-way merge.
 */

import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { baseSidecarPath } from './sidecar.js';

export type BaseSource =
  | { kind: 'sidecar'; storageHtml: string }
  | { kind: 'git'; markdown: string }
  | { kind: 'none' };

export async function loadBase(
  cwd: string,
  filePath: string,
): Promise<BaseSource> {
  const sidecar = baseSidecarPath(filePath);
  if (fs.existsSync(sidecar)) {
    try {
      const storageHtml = fs.readFileSync(sidecar, 'utf8');
      return { kind: 'sidecar', storageHtml };
    } catch {
      // fall through to git
    }
  }

  try {
    const git = simpleGit({ baseDir: cwd });
    const rel = path.isAbsolute(filePath)
      ? path.relative(cwd, filePath)
      : filePath;
    const markdown = await git.show([`HEAD:${rel}`]);
    if (typeof markdown === 'string' && markdown.length > 0) {
      return { kind: 'git', markdown };
    }
  } catch {
    // file not in git, or not a repo
  }

  return { kind: 'none' };
}

export function writeBaseSidecar(
  filePath: string,
  storageHtml: string,
): void {
  const sidecar = baseSidecarPath(filePath);
  fs.writeFileSync(sidecar, storageHtml ?? '', 'utf8');
}
