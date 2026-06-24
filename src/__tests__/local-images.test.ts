import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  contentTypeForFilename,
  isLocalImageRef,
  resolveLocalImages,
  type AttachmentUploader,
} from '../local-images.js';

const TMP = path.join(import.meta.dirname ?? __dirname, '.tmp-local-images');

function writeFile(relativePath: string, content: string | Buffer) {
  const abs = path.join(TMP, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

interface RecordedCall {
  pageId: string;
  filename: string;
  size: number;
  contentType?: string;
}

function makeUploader(): AttachmentUploader & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async uploadAttachment(pageId, filename, data, contentType) {
      calls.push({ pageId, filename, size: data.length, contentType });
    },
  };
}

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('isLocalImageRef', () => {
  it('treats relative and absolute file paths as local', () => {
    expect(isLocalImageRef('assets/x.png')).toBe(true);
    expect(isLocalImageRef('./x.png')).toBe(true);
    expect(isLocalImageRef('../images/x.png')).toBe(true);
    expect(isLocalImageRef('/abs/x.png')).toBe(true);
    expect(isLocalImageRef('C:\\images\\x.png')).toBe(true);
  });

  it('does not treat existing attachments, URLs, or data URIs as local', () => {
    expect(isLocalImageRef('#existing.png')).toBe(false);
    expect(isLocalImageRef('https://example.com/x.png')).toBe(false);
    expect(isLocalImageRef('http://example.com/x.png')).toBe(false);
    expect(isLocalImageRef('data:image/png;base64,AAAA')).toBe(false);
    expect(isLocalImageRef('')).toBe(false);
  });
});

describe('contentTypeForFilename', () => {
  it('maps known image extensions', () => {
    expect(contentTypeForFilename('a.png')).toBe('image/png');
    expect(contentTypeForFilename('a.jpg')).toBe('image/jpeg');
    expect(contentTypeForFilename('a.jpeg')).toBe('image/jpeg');
    expect(contentTypeForFilename('a.svg')).toBe('image/svg+xml');
    expect(contentTypeForFilename('a.gif')).toBe('image/gif');
    expect(contentTypeForFilename('a.webp')).toBe('image/webp');
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(contentTypeForFilename('a.xyz')).toBe('application/octet-stream');
  });
});

describe('resolveLocalImages', () => {
  it('uploads a local image and rewrites the reference to #filename', async () => {
    writeFile('docs/assets/diagram.png', Buffer.from([1, 2, 3, 4]));
    const file = writeFile('docs/page.md', 'x');
    const uploader = makeUploader();

    const result = await resolveLocalImages(
      '![Architecture](assets/diagram.png)',
      file,
      TMP,
      uploader,
      '12345',
    );

    expect(result).toBe('![Architecture](#diagram.png)');
    expect(uploader.calls).toHaveLength(1);
    expect(uploader.calls[0]).toMatchObject({
      pageId: '12345',
      filename: 'diagram.png',
      size: 4,
      contentType: 'image/png',
    });
  });

  it('supports png, jpg, and svg', async () => {
    writeFile('a.png', Buffer.from([1]));
    writeFile('b.jpg', Buffer.from([2]));
    writeFile('c.svg', '<svg></svg>');
    const file = writeFile('page.md', 'x');
    const uploader = makeUploader();

    const result = await resolveLocalImages(
      '![](a.png)\n\n![](b.jpg)\n\n![](c.svg)',
      file,
      TMP,
      uploader,
      '1',
    );

    expect(result).toContain('![](#a.png)');
    expect(result).toContain('![](#b.jpg)');
    expect(result).toContain('![](#c.svg)');
    const types = uploader.calls.map((c) => c.contentType).sort();
    expect(types).toEqual(['image/jpeg', 'image/png', 'image/svg+xml']);
  });

  it('leaves external URLs and existing attachment refs untouched', async () => {
    const file = writeFile('page.md', 'x');
    const uploader = makeUploader();
    const md =
      '![remote](https://example.com/x.png) and ![attached](#already.png)';

    const result = await resolveLocalImages(md, file, TMP, uploader, '1');

    expect(result).toBe(md);
    expect(uploader.calls).toHaveLength(0);
  });

  it('uploads a referenced file only once even if used multiple times', async () => {
    writeFile('logo.png', Buffer.from([9, 9, 9]));
    const file = writeFile('page.md', 'x');
    const uploader = makeUploader();

    const result = await resolveLocalImages(
      '![one](logo.png) text ![two](logo.png)',
      file,
      TMP,
      uploader,
      '1',
    );

    expect(result).toBe('![one](#logo.png) text ![two](#logo.png)');
    expect(uploader.calls).toHaveLength(1);
  });

  it('falls back to cwd-relative resolution', async () => {
    writeFile('shared/pic.png', Buffer.from([1]));
    const file = writeFile('deep/nested/page.md', 'x');
    const uploader = makeUploader();

    const result = await resolveLocalImages(
      '![pic](shared/pic.png)',
      file,
      TMP,
      uploader,
      '1',
    );

    expect(result).toBe('![pic](#pic.png)');
    expect(uploader.calls).toHaveLength(1);
  });

  it('warns and keeps the reference when the file is missing', async () => {
    const file = writeFile('page.md', 'x');
    const uploader = makeUploader();
    const warn = vi.fn();

    const result = await resolveLocalImages(
      '![missing](nope.png)',
      file,
      TMP,
      uploader,
      '1',
      { warn },
    );

    expect(result).toBe('![missing](nope.png)');
    expect(uploader.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns and keeps the reference for unsupported file types', async () => {
    writeFile('movie.mp4', Buffer.from([1]));
    const file = writeFile('page.md', 'x');
    const uploader = makeUploader();
    const warn = vi.fn();

    const result = await resolveLocalImages(
      '![clip](movie.mp4)',
      file,
      TMP,
      uploader,
      '1',
      { warn },
    );

    expect(result).toBe('![clip](movie.mp4)');
    expect(uploader.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('disambiguates basename collisions between distinct files', async () => {
    writeFile('a/logo.png', Buffer.from([1]));
    writeFile('b/logo.png', Buffer.from([2, 2]));
    const file = writeFile('page.md', 'x');
    const uploader = makeUploader();

    const result = await resolveLocalImages(
      '![first](a/logo.png) ![second](b/logo.png)',
      file,
      TMP,
      uploader,
      '1',
    );

    expect(result).toBe('![first](#logo.png) ![second](#logo-1.png)');
    expect(uploader.calls.map((c) => c.filename).sort()).toEqual([
      'logo-1.png',
      'logo.png',
    ]);
  });

  it('resolves percent-encoded paths with spaces', async () => {
    writeFile('my image.png', Buffer.from([1]));
    const file = writeFile('page.md', 'x');
    const uploader = makeUploader();

    const result = await resolveLocalImages(
      '![](my%20image.png)',
      file,
      TMP,
      uploader,
      '1',
    );

    expect(result).toBe('![](#my image.png)');
    expect(uploader.calls[0]?.filename).toBe('my image.png');
  });
});
