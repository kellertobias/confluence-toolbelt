import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncOne, SyncClient } from '../commands/sync.js';
import { writeBaseSidecar } from '../sync/base-source.js';
import { emitHeader } from '../md-header.js';
import type { RawComment } from '../sync/blocks-from-storage.js';

// Skip git auto-commits in all tests.
beforeAll(() => { process.env.NO_AUTO_COMMIT = '1'; });
afterAll(() => { delete process.env.NO_AUTO_COMMIT; });

function mkTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-rt-'));
}

function makeFile(
  dir: string,
  body: string,
  meta: { pageId: string; spaceId: string; title: string } = {
    pageId: '42',
    spaceId: 'SPACE',
    title: 'Test Page',
  },
): string {
  const header = emitHeader(meta);
  const filePath = path.join(dir, 'page.md');
  fs.writeFileSync(filePath, `${header}${body}\n`, 'utf8');
  return filePath;
}

function mockComment(
  ref: string,
  author: string,
  text: string,
): RawComment {
  return {
    id: ref,
    extensions: { inlineProperties: { markerRef: ref } },
    ancestors: [],
    version: { by: { displayName: author }, when: '2024-01-01T00:00:00Z' },
    body: { view: { value: text } },
  };
}

function mockClient(storageHtml: string, comments: RawComment[] = []): SyncClient {
  return {
    getPageStorage: async () => ({
      storageHtml,
      title: 'Test Page',
      spaceId: 'SPACE',
      version: 2,
    }),
    getPageComments: async () => comments,
    getPageSpaceKey: async () => undefined,
  };
}

describe('sync round-trip (mocked Confluence API)', () => {
  it('ports a new remote comment onto unchanged local text', async () => {
    const dir = mkTemp();
    try {
      const filePath = makeFile(dir, 'Hello world.');
      writeBaseSidecar(
        filePath,
        '<p>Hello world.</p>',
      );

      await syncOne(dir, filePath, mockClient(
        '<p>Hello <ac:inline-comment-marker ac:ref="c1">world</ac:inline-comment-marker>.</p>',
        [mockComment('c1', 'Alice', 'Nit: typo here')],
      ), { verbose: false, noUpload: true });

      const out = fs.readFileSync(filePath, 'utf8');
      expect(out).toContain('<!-- comment:c1 -->');
      expect(out).toContain('world');
      expect(out).toContain('<!-- commend-end:c1 -->');
      expect(out).toContain('Alice');
      expect(out).not.toContain('# Detached Comments');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('keeps local edits and attaches comment when anchor text still present', async () => {
    const dir = mkTemp();
    try {
      // Local edit: "Hello" → "Hi", but "world" still present
      const filePath = makeFile(dir, 'Hi world.');
      writeBaseSidecar(filePath, '<p>Hello world.</p>');

      await syncOne(dir, filePath, mockClient(
        '<p>Hello <ac:inline-comment-marker ac:ref="c2">world</ac:inline-comment-marker>.</p>',
        [mockComment('c2', 'Bob', 'Good point')],
      ), { verbose: false, noUpload: true });

      const out = fs.readFileSync(filePath, 'utf8');
      expect(out).toContain('Hi'); // local edit preserved
      expect(out).toContain('<!-- comment:c2 -->');
      expect(out).toContain('world');
      expect(out).not.toContain('# Detached Comments');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('detaches comment to trailing section when anchor text is gone', async () => {
    const dir = mkTemp();
    try {
      // "world" was replaced by "there" locally — anchor gone
      const filePath = makeFile(dir, 'Hi there.');
      writeBaseSidecar(filePath, '<p>Hello world.</p>');

      await syncOne(dir, filePath, mockClient(
        '<p>Hello <ac:inline-comment-marker ac:ref="c3">world</ac:inline-comment-marker>.</p>',
        [mockComment('c3', 'Carol', 'Detachable comment')],
      ), { verbose: false, noUpload: true });

      const out = fs.readFileSync(filePath, 'utf8');
      expect(out).toContain('Hi there.');
      expect(out).toContain('# Detached Comments');
      expect(out).toContain('<!-- comment:c3 -->');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('produces conflict markers when both sides changed the same block', async () => {
    const dir = mkTemp();
    try {
      const filePath = makeFile(dir, 'The cat sat on the rug.');
      writeBaseSidecar(filePath, '<p>The cat sat.</p>');

      const shouldUpload = await syncOne(dir, filePath, mockClient(
        '<p>The feline sat on the mat.</p>',
      ), { verbose: false, noUpload: false });

      const out = fs.readFileSync(filePath, 'utf8');
      expect(out).toContain('<<<<<<< LOCAL');
      expect(out).toContain('>>>>>>> REMOTE');
      expect(shouldUpload).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('falls back to 2-way merge when no sidecar and no git history', async () => {
    const dir = mkTemp();
    try {
      // No sidecar written → loadBase returns { kind: 'none' }
      const filePath = makeFile(dir, 'Hello world.');

      await syncOne(dir, filePath, mockClient(
        '<p>Hello <ac:inline-comment-marker ac:ref="c4">world</ac:inline-comment-marker>.</p>',
        [mockComment('c4', 'Dave', 'Nice')],
      ), { verbose: false, noUpload: true });

      const out = fs.readFileSync(filePath, 'utf8');
      expect(out).toContain('Hello');
      expect(out).toContain('<!-- comment:c4 -->');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('sidecar is refreshed after a clean sync', async () => {
    const dir = mkTemp();
    try {
      const filePath = makeFile(dir, 'Hello world.');
      const sidecarBefore = '<p>Hello world.</p>';
      writeBaseSidecar(filePath, sidecarBefore);

      const newStorageHtml =
        '<p>Hello <ac:inline-comment-marker ac:ref="c5">world</ac:inline-comment-marker>.</p>';
      await syncOne(dir, filePath, mockClient(
        newStorageHtml,
        [mockComment('c5', 'Eve', 'Looks good')],
      ), { verbose: false, noUpload: true });

      const sidecarPath = path.join(dir, '.page.md.base.confluence');
      expect(fs.existsSync(sidecarPath)).toBe(true);
      const sidecarContent = fs.readFileSync(sidecarPath, 'utf8');
      expect(sidecarContent).toBe(newStorageHtml);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('does NOT refresh sidecar when conflicts are present', async () => {
    const dir = mkTemp();
    try {
      const filePath = makeFile(dir, 'The cat sat on the rug.');
      const originalSidecar = '<p>The cat sat.</p>';
      writeBaseSidecar(filePath, originalSidecar);

      await syncOne(dir, filePath, mockClient(
        '<p>The feline sat on the mat.</p>',
      ), { verbose: false, noUpload: false });

      const sidecarPath = path.join(dir, '.page.md.base.confluence');
      const sidecarContent = fs.readFileSync(sidecarPath, 'utf8');
      expect(sidecarContent).toBe(originalSidecar); // unchanged
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

});
