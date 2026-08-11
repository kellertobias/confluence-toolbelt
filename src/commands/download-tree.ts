/**
 * Download a whole Confluence page tree: a page plus every descendant the
 * caller can read.
 *
 * Layout mirrors the hierarchy — `<Title>.md` for a page, `<Title>/` for its
 * children — so the folder structure matches Confluence's own.
 *
 * Local edits are never clobbered silently: before overwriting an existing file
 * we compare it against the markdown we last wrote (`.<name>.base.md`, falling
 * back to git HEAD). Only files that are provably unchanged get overwritten;
 * anything else is skipped and reported, unless `--force` is given.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fromEnv } from '../adapters/node/confluence.js';
import {
  countPages,
  fetchPageTree,
  foldersForPlan,
  planTreeLayout,
} from '../core/pipeline/page-tree.js';
import { parseHeader } from '../md-header.js';
import { loadPageCache, savePageCache } from '../page-cache.js';
import { detectLocalChanges } from '../sync/local-changes.js';
import {
  warnUnsupported,
  writePageFile,
  writeVerboseHtml,
} from './download.js';
import { indexPagesById, resolvePageId, sanitizeTitle } from './page-files.js';
import { composeDocument, renderPage } from './render-page.js';

interface Options {
  cwd: string;
  args?: string[];
}

/** Parse `--depth n` (also `--depth=n`). Returns undefined when absent. */
function parseDepth(args: string[]): number | undefined {
  const idx = args.findIndex((a) => a === '--depth' || a.startsWith('--depth='));
  if (idx === -1) {
    return undefined;
  }
  const arg = args[idx] as string;
  const raw = arg.includes('=') ? arg.split('=')[1] : args[idx + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function downloadTree(opts: Options): Promise<void> {
  const args = opts.args ?? [];
  const force = args.includes('--force');
  const verbose = args.includes('--verbose');
  const depth = parseDepth(args);

  // Positional args: <url|pageId> [targetDir]. `--depth n` consumes its value.
  const depthIdx = args.findIndex((a) => a === '--depth');
  const positional = args.filter(
    (a, i) => !a.startsWith('--') && !(depthIdx !== -1 && i === depthIdx + 1),
  );

  const target = positional[0];
  if (!target) {
    console.error(
      '[download] Usage: cli download --tree <url|pageId> [targetDir] [--depth n] [--force]',
    );
    return;
  }
  const pageId = resolvePageId(target);
  if (!pageId) {
    console.error(`[download] Could not extract pageId from: ${target}`);
    return;
  }

  const root = path.resolve(opts.cwd, positional[1] ?? '.');
  fs.mkdirSync(root, { recursive: true });

  const client = fromEnv();
  const pageCache = loadPageCache(opts.cwd);

  console.log(`[download] Scanning page tree from ${pageId}…`);
  const tree = await fetchPageTree(client, pageId, {
    maxDepth: depth,
    onStep: (message, found) => {
      if (verbose) {
        console.log(`[download] ${message} (${found} page(s) so far)`);
      }
    },
  });
  const total = countPages(tree);
  console.log(
    `[download] Found ${total} page(s) under "${tree.title}"; writing to ${path.relative(opts.cwd, root) || '.'}`,
  );

  // Re-downloading a tree should refresh the notes already on disk rather than
  // creating a second copy under the tree layout.
  const existingById = indexPagesById(root);
  const plan = planTreeLayout(tree, {
    folder: '',
    sanitize: sanitizeTitle,
    existingPath: (id) => existingById.get(id) ?? null,
  });

  for (const dir of foldersForPlan(plan)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  let written = 0;
  let unchanged = 0;
  let failed = 0;
  const skipped: { notePath: string; reason: string }[] = [];

  for (const [i, page] of plan.entries()) {
    const filePath = path.join(root, page.notePath);
    const label = path.relative(opts.cwd, filePath);
    console.log(`[download] (${i + 1}/${plan.length}) ${page.title}`);

    // Refuse to overwrite work we cannot prove is ours.
    const state = await detectLocalChanges(opts.cwd, filePath);
    if (!force && (state === 'dirty' || state === 'unknown')) {
      const reason =
        state === 'dirty'
          ? 'has local changes'
          : 'exists with no known baseline';
      console.warn(`[download] Skipped ${label} — ${reason} (use --force)`);
      skipped.push({ notePath: label, reason });
      continue;
    }

    try {
      const rendered = await renderPage(client, page.id, { pageCache });
      const existingText = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, 'utf8')
        : '';
      const next = composeDocument(
        rendered,
        page.id,
        parseHeader(existingText).meta,
      );

      if (verbose) {
        writeVerboseHtml(filePath, rendered.storageHtml);
      }

      if (!force && existingText === next) {
        console.log(`[download] No changes for ${label}`);
        unchanged++;
        continue;
      }
      await writePageFile(
        opts.cwd,
        filePath,
        next,
        rendered.storageHtml,
        label,
      );
      warnUnsupported(rendered.unsupportedFeatures);
      written++;
    } catch (err) {
      failed++;
      console.error(
        `[download] Failed ${label}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  savePageCache(opts.cwd, pageCache);

  const parts = [`${written} written`, `${unchanged} unchanged`];
  if (skipped.length) {
    parts.push(`${skipped.length} skipped`);
  }
  if (failed) {
    parts.push(`${failed} failed`);
  }
  console.log(`[download] Tree complete: ${parts.join(', ')}.`);
  if (skipped.length) {
    console.log('[download] Skipped (local changes preserved):');
    for (const s of skipped) {
      console.log(`  - ${s.notePath} (${s.reason})`);
    }
  }
}
