import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractLinkedPageIds,
  loadPageCache,
  resolvePageTitleLinks,
  savePageCache,
  validatePageLinks,
  type PageCache,
} from '../page-cache.js';

const TMP = path.join(import.meta.dirname ?? __dirname, '.tmp-page-cache');

beforeEach(() => fs.mkdirSync(TMP, { recursive: true }));
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// extractLinkedPageIds
// ---------------------------------------------------------------------------

describe('extractLinkedPageIds', () => {
  it('extracts pageid: links', () => {
    expect(extractLinkedPageIds('See [A](pageid:123) and [B](pageid:456)')).toEqual(
      expect.arrayContaining(['123', '456']),
    );
  });

  it('extracts pageid:SPACE:ID links', () => {
    expect(extractLinkedPageIds('[Doc](pageid:MYSPACE:789)')).toContain('789');
  });

  it('extracts legacy page:SPACE:ID links where ID is numeric', () => {
    expect(extractLinkedPageIds('[Doc](page:MYSPACE:789)')).toContain('789');
  });

  it('does not extract page:SPACE:Title links', () => {
    const ids = extractLinkedPageIds('[Doc](page:MYSPACE:My Page Title)');
    expect(ids).toHaveLength(0);
  });

  it('deduplicates the same ID referenced twice', () => {
    const ids = extractLinkedPageIds('[A](pageid:42) and [B](pageid:42)');
    expect(ids).toEqual(['42']);
  });

  it('deduplicates pageid:ID and pageid:SPACE:ID for the same ID', () => {
    const ids = extractLinkedPageIds('[A](pageid:42) and [B](pageid:SP:42)');
    expect(ids).toEqual(['42']);
  });

  it('returns empty array when no page links are present', () => {
    expect(extractLinkedPageIds('No links here')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadPageCache / savePageCache
// ---------------------------------------------------------------------------

describe('loadPageCache / savePageCache', () => {
  it('returns an empty object when the file does not exist', () => {
    expect(loadPageCache(TMP)).toEqual({});
  });

  it('round-trips a cache through save + load', () => {
    const cache: PageCache = {
      '123': { title: 'My Page', checkedAt: '2024-01-01T00:00:00.000Z' },
    };
    savePageCache(TMP, cache);
    expect(loadPageCache(TMP)).toEqual(cache);
  });
});

// ---------------------------------------------------------------------------
// validatePageLinks
// ---------------------------------------------------------------------------

describe('validatePageLinks', () => {
  function makeClient(found: Record<string, string>) {
    return {
      getPage: vi.fn(async (id: string) => {
        if (id in found) return { id, title: found[id] };
        throw new Error(`Not found: ${id}`);
      }),
    } as any;
  }

  it('returns no warnings when all IDs exist', async () => {
    const client = makeClient({ '123': 'Page A', '456': 'Page B' });
    const cache: PageCache = {};
    const warnings = await validatePageLinks(
      '[A](pageid:123) [B](pageid:456)',
      client,
      cache,
    );
    expect(warnings).toHaveLength(0);
    expect(cache['123']?.title).toBe('Page A');
    expect(cache['456']?.title).toBe('Page B');
  });

  it('returns a warning for each missing page ID', async () => {
    const client = makeClient({});
    const cache: PageCache = {};
    const warnings = await validatePageLinks('[X](pageid:999)', client, cache);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('999');
    expect(cache['999']).toBeUndefined();
  });

  it('skips the API call for IDs already in a fresh cache', async () => {
    const client = makeClient({ '42': 'Cached Page' });
    const cache: PageCache = {
      '42': { title: 'Cached Page', checkedAt: new Date().toISOString() },
    };
    await validatePageLinks('[Doc](pageid:42)', client, cache);
    expect(client.getPage).not.toHaveBeenCalled();
  });

  it('rechecks entries older than 7 days', async () => {
    const client = makeClient({ '42': 'Page' });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const cache: PageCache = {
      '42': { title: 'Old Page', checkedAt: eightDaysAgo },
    };
    await validatePageLinks('[Doc](pageid:42)', client, cache);
    expect(client.getPage).toHaveBeenCalledWith('42');
    expect(cache['42']?.title).toBe('Page');
  });

  it('returns no warnings when markdown has no page links', async () => {
    const client = makeClient({});
    const warnings = await validatePageLinks('No links here.', client, {});
    expect(warnings).toHaveLength(0);
    expect(client.getPage).not.toHaveBeenCalled();
  });

  it('warns for page:SPACE:ID links whose ID is not found', async () => {
    const client = makeClient({});
    const warnings = await validatePageLinks('[Doc](page:SP:777)', client, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('777');
  });
});

// ---------------------------------------------------------------------------
// resolvePageTitleLinks
// ---------------------------------------------------------------------------

describe('resolvePageTitleLinks', () => {
  function makeClient(byTitle: Record<string, { id: string; title: string }>) {
    return {
      getPageByTitle: vi.fn(async (spaceKey: string, title: string) => {
        return byTitle[`${spaceKey}:${title}`] ?? null;
      }),
    } as any;
  }

  it('rewrites page:SPACE:Title to pageid:SPACE:ID when the page is found', async () => {
    const client = makeClient({ 'SP:My Page': { id: '123', title: 'My Page' } });
    const result = await resolvePageTitleLinks(
      'See [doc](page:SP:My Page) here.',
      client,
      {},
    );
    expect(result).toBe('See [doc](pageid:SP:123) here.');
  });

  it('rewrites page:SPACE:ID (numeric) to pageid:SPACE:ID without an API call', async () => {
    const client = makeClient({});
    const result = await resolvePageTitleLinks(
      '[doc](page:SP:12345)',
      client,
      {},
    );
    expect(result).toBe('[doc](pageid:SP:12345)');
    expect(client.getPageByTitle).not.toHaveBeenCalled();
  });

  it('uses the cache to avoid an API call for a known title', async () => {
    const client = makeClient({ 'SP:Cached': { id: '42', title: 'Cached' } });
    const cache: PageCache = {
      '42': { title: 'Cached', spaceKey: 'SP', checkedAt: new Date().toISOString() },
    };
    const result = await resolvePageTitleLinks('[doc](page:SP:Cached)', client, cache);
    expect(result).toBe('[doc](pageid:SP:42)');
    expect(client.getPageByTitle).not.toHaveBeenCalled();
  });

  it('leaves the link unchanged when the page title is not found', async () => {
    const client = makeClient({});
    const md = '[doc](page:SP:Unknown Page)';
    const result = await resolvePageTitleLinks(md, client, {});
    expect(result).toBe(md);
  });

  it('leaves page:Title (no space key) links unchanged', async () => {
    const client = makeClient({});
    const md = '[doc](page:Title Without Space)';
    const result = await resolvePageTitleLinks(md, client, {});
    expect(result).toBe(md);
  });

  it('resolves multiple distinct titles in one pass', async () => {
    const client = makeClient({
      'SP:Page A': { id: '1', title: 'Page A' },
      'SP:Page B': { id: '2', title: 'Page B' },
    });
    const result = await resolvePageTitleLinks(
      '[A](page:SP:Page A) and [B](page:SP:Page B)',
      client,
      {},
    );
    expect(result).toBe('[A](pageid:SP:1) and [B](pageid:SP:2)');
    expect(client.getPageByTitle).toHaveBeenCalledTimes(2);
  });

  it('deduplicates API calls for the same title used twice', async () => {
    const client = makeClient({ 'SP:Same': { id: '9', title: 'Same' } });
    const result = await resolvePageTitleLinks(
      '[A](page:SP:Same) and [B](page:SP:Same)',
      client,
      {},
    );
    expect(result).toBe('[A](pageid:SP:9) and [B](pageid:SP:9)');
    expect(client.getPageByTitle).toHaveBeenCalledTimes(1);
  });

  it('stores resolved pages in the cache', async () => {
    const client = makeClient({ 'SP:New': { id: '77', title: 'New' } });
    const cache: PageCache = {};
    await resolvePageTitleLinks('[doc](page:SP:New)', client, cache);
    expect(cache['77']).toMatchObject({ title: 'New', spaceKey: 'SP' });
  });
});
