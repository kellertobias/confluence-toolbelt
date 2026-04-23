/**
 * Shared conversion: Confluence storage HTML + inline comments → sync blocks.
 *
 * Mirrors the body pipeline in `commands/download.ts`: convert HTML to markdown
 * blocks, decode leftover MD_CMT tokens into `<!-- comment:UUID -->` /
 * `<!-- commend-end:UUID -->` wrappers, and inject `<!-- # Author: body -->`
 * thread tags sourced from the comment API response.
 */

import { storageToMarkdownBlocks } from '../storage-dom.js';
import { SyncBlock } from './merge.js';

export interface RawComment {
  id: string;
  extensions?: { inlineProperties?: { markerRef?: string } };
  ancestors?: Array<{ id: string }>;
  version?: { by?: { displayName?: string }; when?: string };
  author?: { displayName?: string };
  history?: { createdBy?: { displayName?: string }; createdDate?: string };
  body?: {
    view?: { value?: string };
    storage?: { value?: string };
  };
}

export function blocksFromStorage(
  storageHtml: string,
  comments: RawComment[] = [],
): SyncBlock[] {
  const raw = storageToMarkdownBlocks(storageHtml || '');
  const decoded = raw.map((b) => ({
    nodeId: b.nodeId,
    text: decodeCommentTokens(b.markdown).trim(),
  }));
  injectCommentThreads(decoded, comments);
  return decoded;
}

function decodeCommentTokens(s: string): string {
  return s
    .replace(
      /MD(?:\\)?_CMT_START\(([^)]+)\)/g,
      (_m, enc) => `<!-- comment:${decodeURIComponent(String(enc || ''))} -->`,
    )
    .replace(
      /MD(?:\\)?_CMT_END\(([^)]+)\)/g,
      (_m, enc) =>
        `<!-- commend-end:${decodeURIComponent(String(enc || ''))} -->`,
    );
}

function injectCommentThreads(
  blocks: SyncBlock[],
  comments: RawComment[],
): void {
  // Build threads keyed by markerRef (the inline-comment-marker's ac:ref).
  const idToMarkerRef: Record<string, string> = {};
  const threads: Record<
    string,
    Array<{ author: string; text: string; date: Date }>
  > = {};
  for (const c of comments) {
    const ref = c.extensions?.inlineProperties?.markerRef;
    if (ref) {
      idToMarkerRef[c.id] = ref;
      threads[ref] = threads[ref] ?? [];
    }
  }
  for (const c of comments) {
    const rootId =
      c.ancestors && c.ancestors.length > 0 ? c.ancestors[0]?.id ?? c.id : c.id;
    const markerRef = idToMarkerRef[rootId];
    if (!markerRef) continue;
    const author =
      c.version?.by?.displayName ||
      c.author?.displayName ||
      c.history?.createdBy?.displayName ||
      'Unknown';
    const date = new Date(c.version?.when || c.history?.createdDate || 0);
    const text = (c.body?.view?.value || c.body?.storage?.value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/-->/g, '--&gt;')
      .trim();
    if (!text) continue;
    threads[markerRef] = threads[markerRef] ?? [];
    threads[markerRef]!.push({ author, text, date });
  }
  for (const [ref, thread] of Object.entries(threads)) {
    if (thread.length === 0) continue;
    thread.sort((a, b) => a.date.getTime() - b.date.getTime());
    const threadTags = thread
      .map((m) => `<!-- # ${m.author}: ${m.text} -->`)
      .join('');
    const startTag = `<!-- comment:${ref} -->`;
    for (const b of blocks) {
      if (b.text.includes(startTag)) {
        b.text = b.text.split(startTag).join(`${startTag}${threadTags}`);
      }
    }
  }
}
