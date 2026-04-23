/**
 * Page cache for upload-time link validation and download-time title resolution.
 *
 * Why: On upload we warn when a resolved internal link points to a missing page.
 * On download we normalise `page:SPACE:Title` links to `pageid:ID` so page
 * titles never land in local markdown (titles are noisy, AI-editable, and prone
 * to encoding drift). Both operations need live API calls that are expensive
 * to repeat — this module persists results in `.pages.json` so only genuinely
 * unknown pages hit the network.
 *
 * Cache semantics:
 * - Only confirmed pages are stored. Missing pages are never cached so they
 *   are always re-checked (warning clears automatically once the page exists).
 * - Entries expire after CACHE_TTL_MS so deleted/renamed pages are eventually
 *   detected.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ConfluenceClient } from './api.js';

export interface PageCacheEntry {
  title: string;
  spaceKey?: string;
  checkedAt: string;
}

export type PageCache = Record<string, PageCacheEntry>;

const CACHE_FILE = '.pages.json';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function loadPageCache(cwd: string): PageCache {
  try {
    const raw = fs.readFileSync(path.join(cwd, CACHE_FILE), 'utf8');
    return JSON.parse(raw) as PageCache;
  } catch {
    return {};
  }
}

export function savePageCache(cwd: string, cache: PageCache): void {
  fs.writeFileSync(
    path.join(cwd, CACHE_FILE),
    JSON.stringify(cache, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Extract all numeric page IDs referenced in the resolved markdown body.
 * Matches `pageid:12345`, `pageid:SPACE:12345`, and legacy `page:SPACE:12345`.
 */
export function extractLinkedPageIds(markdown: string): string[] {
  const ids = new Set<string>();
  // pageid:12345 (no space key)
  for (const m of markdown.matchAll(/\(pageid:(\d+)\)/g)) {
    if (m[1]) ids.add(m[1]);
  }
  // pageid:SPACE:12345 (with space key)
  for (const m of markdown.matchAll(/\(pageid:[^:)]+:(\d+)\)/g)) {
    if (m[1]) ids.add(m[1]);
  }
  // Legacy page:SPACE:12345
  for (const m of markdown.matchAll(/\(page:[^:)]+:(\d+)\)/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return [...ids];
}

function isFresh(entry: PageCacheEntry): boolean {
  return Date.now() - new Date(entry.checkedAt).getTime() < CACHE_TTL_MS;
}

function findByTitle(
  cache: PageCache,
  spaceKey: string,
  title: string,
): string | undefined {
  for (const [id, entry] of Object.entries(cache)) {
    if (entry.spaceKey === spaceKey && entry.title === title && isFresh(entry)) {
      return id;
    }
  }
  return undefined;
}

/**
 * Validate all numeric page IDs in the markdown against the Confluence API.
 *
 * Returns an array of human-readable warning strings for IDs that could not
 * be confirmed. Mutates `cache` in place with newly fetched entries so the
 * caller can persist the updated cache when convenient.
 */
export async function validatePageLinks(
  markdown: string,
  client: ConfluenceClient,
  cache: PageCache,
): Promise<string[]> {
  const ids = extractLinkedPageIds(markdown);
  if (ids.length === 0) return [];

  const toCheck = ids.filter((id) => {
    const entry = cache[id];
    return !entry || !isFresh(entry);
  });

  await Promise.all(
    toCheck.map(async (id) => {
      try {
        const page = await client.getPage(id);
        cache[id] = {
          title: page.title,
          checkedAt: new Date().toISOString(),
        };
      } catch {
        // Do not cache failures — always recheck so the warning clears as soon
        // as the page is created.
      }
    }),
  );

  return ids
    .filter((id) => !cache[id])
    .map((id) => `page not found in Confluence → pageid:${id}`);
}

/**
 * Resolve title-based page links in markdown to stable `pageid:ID` references.
 *
 * Why: `<ri:page>` links in Confluence storage carry the page title, which
 * Confluence renders as `page:SPACE:Title` on download. Titles are verbose,
 * break on renames, and are prone to AI/encoding drift. This function rewrites
 * them to `pageid:ID` using the API (with cache) so local files only ever
 * contain numeric IDs.
 *
 * Handles:
 *   `page:SPACE:Title`  — looked up by space key + title
 *   `page:SPACE:12345`  — numeric-only third part, already an ID (no API call)
 *
 * Links of the form `page:Title` (no space key) are left unchanged because
 * there is no reliable way to resolve them without knowing the current space.
 *
 * Mutates `cache` in place; caller should persist after all files are processed.
 */
export async function resolvePageTitleLinks(
  markdown: string,
  client: ConfluenceClient,
  cache: PageCache,
): Promise<string> {
  // Collect all unique page: refs that need resolution.
  const toResolve = new Map<string, { spaceKey: string; title: string }>();

  for (const m of markdown.matchAll(/\(page:([^:)]+):([^)]+)\)/g)) {
    const spaceKey = m[1];
    const titleOrId = m[2];
    if (!spaceKey || !titleOrId) continue;
    // Numeric third part is already an ID — handle inline below, no API call.
    if (/^\d+$/.test(titleOrId)) continue;
    const key = `${spaceKey}:${titleOrId}`;
    if (!toResolve.has(key)) {
      toResolve.set(key, { spaceKey, title: titleOrId });
    }
  }

  // For each unique (spaceKey, title), try cache first then API.
  const resolved = new Map<string, string>(); // "SPACE:Title" → pageId

  await Promise.all(
    [...toResolve.entries()].map(async ([key, { spaceKey, title }]) => {
      const cached = findByTitle(cache, spaceKey, title);
      if (cached) {
        resolved.set(key, cached);
        return;
      }
      try {
        const page = await client.getPageByTitle(spaceKey, title);
        if (page) {
          cache[page.id] = {
            title: page.title,
            spaceKey,
            checkedAt: new Date().toISOString(),
          };
          resolved.set(key, page.id);
        }
      } catch {
        // Leave unresolved — keep original page:SPACE:Title link.
      }
    }),
  );

  // Rewrite the markdown in a single pass.
  return markdown.replace(
    /\(page:([^:)]+):([^)]+)\)/g,
    (_m, spaceKey: string, titleOrId: string) => {
      // Numeric ID with space prefix → keep space, emit pageid:SPACE:ID
      if (/^\d+$/.test(titleOrId)) {
        return `(pageid:${spaceKey}:${titleOrId})`;
      }
      const pageId = resolved.get(`${spaceKey}:${titleOrId}`);
      return pageId
        ? `(pageid:${spaceKey}:${pageId})`
        : `(page:${spaceKey}:${titleOrId})`;
    },
  );
}
