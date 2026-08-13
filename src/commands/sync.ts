/**
 * Sync command: pull remote comments and edits into a locally-edited file.
 *
 * Flow per file:
 *   1. Fetch remote storage HTML + inline comments.
 *   2. Load a base version (sidecar → git HEAD → none).
 *   3. Parse local file into blocks and split off any existing Detached section.
 *   4. Three-way merge (or 2-way when no base is available).
 *   5. If conflict markers were produced, write and skip upload until resolved.
 *   6. Otherwise, write the file, refresh the sidecar, and upload.
 */

import fs from 'node:fs';
import path from 'node:path';
import enquirer from 'enquirer';
import { fromEnv } from '../adapters/node/confluence.js';
import { commitFile, listChangedMarkdownFiles } from '../git.js';
import { parseBlocks } from '../inline-tags.js';
import { emitHeader, parseHeader } from '../md-header.js';
import { blocksFromStorage } from '../sync/blocks-from-storage.js';
import { enrichContentEntityLinks } from '../storage-dom/enrich-links.js';
import { loadBase, writeBaseSidecar } from '../sync/base-source.js';
import { hasUnresolvedConflicts } from '../sync/conflict.js';
import { splitDetachedSection } from '../sync/detached.js';
import { buildHeadingMap, mergeDocument, SyncBlock } from '../sync/merge.js';
import { RawComment } from '../sync/blocks-from-storage.js';
import { isSidecarMarkdown } from './page-files.js';
import { uploadAll } from './upload.js';

const { prompt } = enquirer;

export interface SyncClient {
  getPageStorage(pageId: string): Promise<{
    storageHtml: string;
    title: string;
    spaceId?: string;
    version: number;
  }>;
  getPageComments(pageId: string): Promise<RawComment[]>;
  getPageSpaceKey(pageId: string): Promise<string | undefined>;
}

interface Options {
  cwd: string;
  args?: string[];
}

export async function syncAll(opts: Options): Promise<void> {
  const args = opts.args ?? [];
  const all = args.includes('--all');
  const verbose = args.includes('--verbose');
  const noUpload = args.includes('--no-upload');
  const client = fromEnv();

  const explicitPaths = args.filter((a) => !a.startsWith('--'));
  const files = await resolveFiles(opts.cwd, { all, explicitPaths });
  if (files.length === 0) {
    console.log('[sync] No files selected');
    return;
  }

  const toUpload: string[] = [];
  for (const file of files) {
    const rel = path.relative(opts.cwd, file);
    if (!fs.existsSync(file)) {
      console.warn(`[sync] Skip (missing): ${rel}`);
      continue;
    }
    const md = fs.readFileSync(file, 'utf8');
    const { meta } = parseHeader(md);
    if (!meta.pageId) {
      console.log(`[sync] Skip (no pageId): ${rel}`);
      continue;
    }
    if (meta.readonly) {
      console.log(`[sync] Skip (READONLY): ${rel}`);
      continue;
    }
    if (hasUnresolvedConflicts(md)) {
      console.warn(
        `[sync] Skip (unresolved conflict markers from previous sync): ${rel}`,
      );
      continue;
    }

    const shouldUpload = await syncOne(opts.cwd, file, client, {
      verbose,
      noUpload,
    });
    if (shouldUpload) toUpload.push(file);
  }

  if (toUpload.length > 0 && !noUpload) {
    console.log(`[sync] Uploading ${toUpload.length} file(s)...`);
    await uploadAll({ cwd: opts.cwd, args: [...toUpload, ...(verbose ? ['--verbose'] : [])] });
  }
}

export async function syncOne(
  cwd: string,
  file: string,
  client: SyncClient,
  opts: { verbose: boolean; noUpload: boolean },
): Promise<boolean> {
  const rel = path.relative(cwd, file);
  const md = fs.readFileSync(file, 'utf8');
  const { meta, body: rawBody } = parseHeader(md);
  const { content: localContent, detached: existingDetached } =
    splitDetachedSection(rawBody);

  const pageId = String(meta.pageId);
  if (opts.verbose) console.log(`[sync] Fetching page ${pageId} for ${rel}`);
  const { storageHtml, title: remoteTitle, spaceId: remoteSpaceId, version } =
    await client.getPageStorage(pageId);
  const comments = await client.getPageComments(pageId).catch(() => []);

  const enrichedHtml = await enrichContentEntityLinks(storageHtml, (id) =>
    client.getPageSpaceKey(id),
  );
  const remoteBlocks: SyncBlock[] = blocksFromStorage(enrichedHtml, comments);
  const localBlocks: SyncBlock[] = parseBlocks(localContent).map((b) => ({
    nodeId: b.tag?.nodeId,
    text: b.text,
  }));

  const baseSource = await loadBase(cwd, file);
  let baseBlocks: SyncBlock[] | null;
  if (baseSource.kind === 'sidecar') {
    baseBlocks = blocksFromStorage(baseSource.storageHtml, []);
  } else if (baseSource.kind === 'git') {
    const { body: baseBody } = parseHeader(baseSource.markdown);
    const { content: baseContent } = splitDetachedSection(baseBody);
    baseBlocks = parseBlocks(baseContent).map((b) => ({
      nodeId: b.tag?.nodeId,
      text: b.text,
    }));
  } else {
    baseBlocks = null;
    console.warn(
      `[sync] ${rel}: no base found — falling back to 2-way merge (remote text changes may be lost)`,
    );
  }

  const result = mergeDocument({
    base: baseBlocks,
    local: localBlocks,
    remote: remoteBlocks,
    existingDetached,
    remoteHeadings: buildHeadingMap(remoteBlocks),
  });

  const header = emitHeader({
    readonly: meta.readonly,
    pageId,
    spaceId: meta.spaceId || remoteSpaceId,
    title: meta.title || remoteTitle,
    status: meta.status,
  });
  const next = `${header}${result.body.trim()}\n`;

  fs.writeFileSync(file, next, 'utf8');
  console.log(
    `[sync] Wrote ${rel}` +
      (result.newlyDetachedCount > 0
        ? ` (+${result.newlyDetachedCount} detached comment${result.newlyDetachedCount === 1 ? '' : 's'})`
        : '') +
      (result.hasConflicts ? ' — CONFLICTS detected' : ''),
  );

  if (result.hasConflicts) {
    console.warn(
      `[sync] ${rel}: resolve <<<<<<< / >>>>>>> markers and run sync again. Upload skipped.`,
    );
    // Intentionally do NOT refresh the sidecar — the user hasn't yet decided
    // which side to keep, so we want the next sync to still see the original
    // base for re-merging.
    return false;
  }

  // Refresh sidecar with the remote we just pulled (becomes the new base).
  writeBaseSidecar(file, storageHtml);
  // Commit the merged file; upload will create its own post-upload commit.
  await commitFile(cwd, file);
  void version; // reserved for future conflict detection via remote version bumps
  return !opts.noUpload;
}

async function resolveFiles(
  cwd: string,
  opts: { all: boolean; explicitPaths: string[] },
): Promise<string[]> {
  if (opts.all) {
    return walkMarkdown(cwd);
  }
  if (opts.explicitPaths.length > 0) {
    return opts.explicitPaths.map((p) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found: ${p}`);
      }
      return abs;
    });
  }
  // Interactive picker, same shape as upload's.
  const allMd = walkMarkdown(cwd, true);
  const candidates = allMd.filter((f) => {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      const { meta } = parseHeader(txt);
      return !!meta.pageId && !meta.readonly;
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) {
    console.log('[sync] No candidate files found');
    return [];
  }
  const changed = new Set(
    (await listChangedMarkdownFiles(cwd)).map((p) => path.resolve(cwd, p)),
  );
  const sorted = [...candidates].sort((a, b) => {
    const aC = changed.has(a);
    const bC = changed.has(b);
    if (aC && !bC) return -1;
    if (!aC && bC) return 1;
    return a.localeCompare(b);
  });
  const choices = sorted.map((f) => {
    const rel = path.relative(cwd, f);
    const indicator = changed.has(f) ? '● ' : '○ ';
    return { name: indicator + rel, value: f, message: indicator + rel };
  });
  try {
    const response = await prompt<{ files: string[] }>({
      type: 'multiselect',
      name: 'files',
      message:
        'Select files to sync (● = changed locally, ○ = unchanged | space to select, enter to confirm)',
      choices,
      initial: 0,
      result(names: string[]) {
        return names;
      },
    } as any);
    const selected = response.files || [];
    return selected.map((f) => {
      if (f.startsWith('● ') || f.startsWith('○ ')) {
        return path.resolve(cwd, f.substring(2));
      }
      return f;
    });
  } catch {
    return [];
  }
}

function walkMarkdown(dir: string, includeHidden = false): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const ignoredDirs = new Set([
    '.git',
    'node_modules',
    '.next',
    '.nuxt',
    'dist',
    'build',
    '.cache',
  ]);
  for (const entry of fs.readdirSync(dir)) {
    if (!includeHidden && (entry.startsWith('.') || ignoredDirs.has(entry))) {
      continue;
    }
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      out.push(...walkMarkdown(p, includeHidden));
    } else if (/\.mdx?$/.test(entry) && !isSidecarMarkdown(entry)) {
      out.push(p);
    }
  }
  return out;
}
