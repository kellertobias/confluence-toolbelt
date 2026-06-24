import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AttachmentCache,
  getCachedHash,
  hashContent,
  loadAttachmentCache,
  saveAttachmentCache,
  setCachedHash,
} from '../attachment-cache.js';

const TMP = path.join(import.meta.dirname ?? __dirname, '.tmp-attachment-cache');

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('hashContent', () => {
  it('is deterministic and content-sensitive', () => {
    const a = hashContent(Buffer.from([1, 2, 3]));
    const b = hashContent(Buffer.from([1, 2, 3]));
    const c = hashContent(Buffer.from([1, 2, 4]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('get/set cached hash', () => {
  it('round-trips a hash through the in-memory cache', () => {
    const cache: AttachmentCache = {};
    expect(getCachedHash(cache, '1', 'a.png')).toBeUndefined();
    setCachedHash(cache, '1', 'a.png', 'deadbeef');
    expect(getCachedHash(cache, '1', 'a.png')).toBe('deadbeef');
    // distinct pages are isolated
    expect(getCachedHash(cache, '2', 'a.png')).toBeUndefined();
  });
});

describe('load/save attachment cache', () => {
  it('returns an empty object when no cache file exists', () => {
    expect(loadAttachmentCache(TMP)).toEqual({});
  });

  it('persists and reloads the cache', () => {
    const cache: AttachmentCache = { '123': { 'logo.png': 'abc123' } };
    saveAttachmentCache(TMP, cache);
    expect(fs.existsSync(path.join(TMP, '.attachments.json'))).toBe(true);
    expect(loadAttachmentCache(TMP)).toEqual(cache);
  });

  it('tolerates a corrupt cache file', () => {
    fs.writeFileSync(path.join(TMP, '.attachments.json'), 'not json', 'utf8');
    expect(loadAttachmentCache(TMP)).toEqual({});
  });
});
