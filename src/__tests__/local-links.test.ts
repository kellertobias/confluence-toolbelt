import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findUnparsedConfluenceLinks, resolveConfluencePageUrls, resolveLocalPageLinks } from '../local-links.js';

const TMP = path.join(import.meta.dirname ?? __dirname, '.tmp-local-links');

function writeFile(relativePath: string, content: string) {
  const abs = path.join(TMP, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

beforeEach(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('resolveLocalPageLinks', () => {
  it('resolves a relative .md link to pageid:<id>', () => {
    writeFile(
      'REFS/target-page.md',
      '<!--\nspaceId: 111\npageId: 123\ntitle: Target Page Title\n-->\n\nContent',
    );
    const current = writeFile(
      'docs/source.md',
      '<!--\nspaceId: 111\npageId: 456\ntitle: Source\n-->\n\nSee [Target](../REFS/target-page.md)',
    );

    const result = resolveLocalPageLinks(
      'See [Target](../REFS/target-page.md)',
      current,
      TMP,
    );

    expect(result).toBe('See [Target](pageid:123)');
  });

  it('resolves cross-space links using pageId', () => {
    writeFile(
      'other-space/page.md',
      '<!--\nspaceId: 999\npageId: 777\ntitle: Cross Space Page\n-->\n\nContent',
    );
    const current = writeFile(
      'my-space/source.md',
      '<!--\nspaceId: 111\npageId: 456\ntitle: Source\n-->\n\n',
    );

    const result = resolveLocalPageLinks(
      '[Cross Space](../other-space/page.md)',
      current,
      TMP,
    );

    expect(result).toBe('[Cross Space](pageid:777)');
  });

  it('resolves .mdx links the same way', () => {
    writeFile(
      'page.mdx',
      '<!--\nspaceId: SP\npageId: 111\ntitle: MDX Page\n-->\n\nContent',
    );
    const current = writeFile('source.md', '');

    const result = resolveLocalPageLinks(
      '[MDX Link](page.mdx)',
      current,
      TMP,
    );

    expect(result).toBe('[MDX Link](pageid:111)');
  });

  it('keeps original link when target file does not exist', () => {
    const current = writeFile('source.md', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = resolveLocalPageLinks(
      '[Missing](nonexistent.md)',
      current,
      TMP,
    );

    expect(result).toBe('[Missing](nonexistent.md)');
    warn.mockRestore();
  });

  it('keeps original link when target has no pageId', () => {
    writeFile('no-id.md', '<!--\ntitle: No ID Page\n-->\n\nContent');
    const current = writeFile('source.md', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = resolveLocalPageLinks(
      '[No ID](no-id.md)',
      current,
      TMP,
    );

    expect(result).toBe('[No ID](no-id.md)');
    warn.mockRestore();
  });

  it('does not touch non-.md links', () => {
    const current = writeFile('source.md', '');

    const result = resolveLocalPageLinks(
      '[Google](https://google.com) and [Page](page:Some Page)',
      current,
      TMP,
    );

    expect(result).toBe(
      '[Google](https://google.com) and [Page](page:Some Page)',
    );
  });

  it('resolves multiple local links in the same body', () => {
    writeFile(
      'a.md',
      '<!--\nspaceId: S\npageId: 1\ntitle: Page A\n-->\n\nA',
    );
    writeFile(
      'b.md',
      '<!--\nspaceId: S\npageId: 2\ntitle: Page B\n-->\n\nB',
    );
    const current = writeFile('source.md', '');

    const result = resolveLocalPageLinks(
      'See [A](a.md) and [B](b.md)',
      current,
      TMP,
    );

    expect(result).toBe('See [A](pageid:1) and [B](pageid:2)');
  });

  it('resolves nested directory paths', () => {
    writeFile(
      'REFS/sub/deep.md',
      '<!--\nspaceId: DEEP\npageId: 42\ntitle: Deep Page\n-->\n\nDeep',
    );
    const current = writeFile('docs/source.md', '');

    const result = resolveLocalPageLinks(
      '[Deep](../REFS/sub/deep.md)',
      current,
      TMP,
    );

    expect(result).toBe('[Deep](pageid:42)');
  });

  it('tries cwd-relative resolution when dir-relative fails', () => {
    writeFile(
      'REFS/page.md',
      '<!--\nspaceId: CWD\npageId: 55\ntitle: CWD Page\n-->\n\nContent',
    );
    const current = writeFile('subdir/source.md', '');

    const result = resolveLocalPageLinks(
      '[CWD](REFS/page.md)',
      current,
      TMP,
    );

    expect(result).toBe('[CWD](pageid:55)');
  });
});

describe('resolveConfluencePageUrls', () => {
  const BASE = 'https://mycompany.atlassian.net';

  it('converts a full Confluence page URL to pageid:SPACE:ID format', () => {
    const result = resolveConfluencePageUrls(
      '[My Page](https://mycompany.atlassian.net/wiki/spaces/MYSPACE/pages/12345/My-Page)',
      BASE,
    );
    expect(result).toBe('[My Page](pageid:MYSPACE:12345)');
  });

  it('works when the URL has no trailing title segment', () => {
    const result = resolveConfluencePageUrls(
      '[My Page](https://mycompany.atlassian.net/wiki/spaces/MYSPACE/pages/12345)',
      BASE,
    );
    expect(result).toBe('[My Page](pageid:MYSPACE:12345)');
  });

  it('handles http:// URLs', () => {
    const result = resolveConfluencePageUrls(
      '[Page](http://mycompany.atlassian.net/wiki/spaces/SP/pages/99)',
      BASE,
    );
    expect(result).toBe('[Page](pageid:SP:99)');
  });

  it('ignores URLs from a different host', () => {
    const md = '[External](https://other.atlassian.net/wiki/spaces/SP/pages/99/Title)';
    expect(resolveConfluencePageUrls(md, BASE)).toBe(md);
  });

  it('ignores non-page URLs on the same host', () => {
    const md = '[Blog](https://mycompany.atlassian.net/blog/2024)';
    expect(resolveConfluencePageUrls(md, BASE)).toBe(md);
  });

  it('converts multiple links in one body', () => {
    const result = resolveConfluencePageUrls(
      'See [A](https://mycompany.atlassian.net/wiki/spaces/SP/pages/1/A) and [B](https://mycompany.atlassian.net/wiki/spaces/SP/pages/2/B)',
      BASE,
    );
    expect(result).toBe('See [A](pageid:SP:1) and [B](pageid:SP:2)');
  });

  it('returns the original markdown when baseUrl is empty', () => {
    const md = '[Page](https://mycompany.atlassian.net/wiki/spaces/SP/pages/1)';
    expect(resolveConfluencePageUrls(md, '')).toBe(md);
  });

  it('handles baseUrl that already includes /wiki path', () => {
    const result = resolveConfluencePageUrls(
      '[Page](https://mycompany.atlassian.net/wiki/spaces/SP/pages/42/Title)',
      'https://mycompany.atlassian.net/wiki',
    );
    expect(result).toBe('[Page](pageid:SP:42)');
  });
});

describe('findUnparsedConfluenceLinks', () => {
  const BASE = 'https://mycompany.atlassian.net';

  it('returns links on the Confluence host that were not converted to page:SPACE:ID', () => {
    const md = '[Blog](https://mycompany.atlassian.net/blog/2024/article)';
    expect(findUnparsedConfluenceLinks(md, BASE)).toEqual([
      'https://mycompany.atlassian.net/blog/2024/article',
    ]);
  });

  it('does not flag already-converted page:SPACE:ID links', () => {
    const md = '[Doc](page:SP:123)';
    expect(findUnparsedConfluenceLinks(md, BASE)).toHaveLength(0);
  });

  it('does not flag pageid: links', () => {
    const md = '[Doc](pageid:123)';
    expect(findUnparsedConfluenceLinks(md, BASE)).toHaveLength(0);
  });

  it('does not flag URLs from other hosts', () => {
    const md = '[External](https://other.atlassian.net/wiki/spaces/SP/pages/99)';
    expect(findUnparsedConfluenceLinks(md, BASE)).toHaveLength(0);
  });

  it('returns empty array when baseUrl is empty', () => {
    const md = '[Blog](https://mycompany.atlassian.net/blog/post)';
    expect(findUnparsedConfluenceLinks(md, '')).toHaveLength(0);
  });

  it('returns multiple unparsed links', () => {
    const md = '[A](https://mycompany.atlassian.net/search) [B](https://mycompany.atlassian.net/profile)';
    expect(findUnparsedConfluenceLinks(md, BASE)).toHaveLength(2);
  });
});
