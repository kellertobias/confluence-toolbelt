import { describe, expect, it } from 'vitest';
import { alignBlocks, canonicalText, similarity } from '../sync/align.js';
import {
  emitConflictBlock,
  hasUnresolvedConflicts,
} from '../sync/conflict.js';
import {
  emitDetachedSection,
  splitDetachedSection,
} from '../sync/detached.js';
import {
  buildHeadingMap,
  mergeDocument,
  SyncBlock,
} from '../sync/merge.js';
import {
  extractComments,
  placeComments,
  stripCommentMarkers,
} from '../sync/place-comments.js';

describe('place-comments', () => {
  it('extracts comments with anchor text and thread tags', () => {
    const text =
      'Hello <!-- comment:abc --><!-- # Alice: Nit -->brown<!-- commend-end:abc --> fox.';
    const { stripped, comments } = extractComments(text);
    expect(stripped).toBe('Hello brown fox.');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      uuid: 'abc',
      anchorText: 'brown',
      threadTags: '<!-- # Alice: Nit -->',
    });
  });

  it('places remote comments on unchanged local text', () => {
    const local = 'The quick brown fox jumps.';
    const remote =
      'The quick <!-- comment:c1 --><!-- # Alice: Nit -->brown fox<!-- commend-end:c1 --> jumps.';
    const { merged, detached } = placeComments(local, remote);
    expect(merged).toContain('<!-- comment:c1 -->');
    expect(merged).toContain('<!-- # Alice: Nit -->');
    expect(merged).toContain('brown fox');
    expect(merged).toContain('<!-- commend-end:c1 -->');
    expect(detached).toHaveLength(0);
  });

  it('attaches when anchor still present in edited text', () => {
    const local = 'The fast brown fox leaps over lazy dogs.';
    const remote =
      'The quick <!-- comment:c1 -->brown fox<!-- commend-end:c1 --> jumps.';
    const { merged, detached } = placeComments(local, remote);
    expect(merged).toContain('<!-- comment:c1 -->brown fox<!-- commend-end:c1 -->');
    expect(detached).toHaveLength(0);
  });

  it('detaches when anchor text no longer present', () => {
    const local = 'The fast red fox leaps over lazy dogs.';
    const remote =
      'The quick <!-- comment:c1 -->hippopotamus herd<!-- commend-end:c1 --> waits.';
    const { detached } = placeComments(local, remote);
    expect(detached).toHaveLength(1);
    expect(detached[0]?.uuid).toBe('c1');
  });

  it('strips all comment markers including thread tags', () => {
    const text =
      'a <!-- comment:x --><!-- # A: body -->b<!-- commend-end:x --> c';
    expect(stripCommentMarkers(text)).toBe('a b c');
  });
});

describe('align', () => {
  it('matches by nodeId first', () => {
    const base = [
      { nodeId: 'n1', text: 'alpha' },
      { nodeId: 'n2', text: 'beta' },
    ];
    const local = [
      { nodeId: 'n2', text: 'beta modified' },
      { nodeId: 'n1', text: 'alpha' },
    ];
    const { baseToLocal, localToBase, similarity } = alignBlocks(base, local);
    expect(baseToLocal).toEqual([1, 0]);
    expect(localToBase).toEqual([1, 0]);
    expect(similarity[0]).toBe(1);
    expect(similarity[1]).toBeLessThan(1);
  });

  it('matches by canonical text when nodeIds are missing', () => {
    const base = [
      { text: 'The cat sat.' },
      { text: 'The dog ran.' },
    ];
    const local = [
      { text: 'The dog ran.' },
      { text: 'The cat sat.' },
    ];
    const { baseToLocal } = alignBlocks(base, local);
    expect(baseToLocal).toEqual([1, 0]);
  });

  it('leaves unrelated blocks unmatched', () => {
    const base = [
      { nodeId: 'n1', text: 'alpha beta gamma' },
    ];
    const local = [
      { text: 'completely different content' },
    ];
    const { baseToLocal, localToBase } = alignBlocks(base, local);
    expect(baseToLocal[0]).toBe(-1);
    expect(localToBase[0]).toBe(-1);
  });

  it('canonical text strips comment markers and node tags', () => {
    const out = canonicalText(
      '<!-- node:42 -->Hello <!-- comment:x -->world<!-- commend-end:x -->',
    );
    expect(out).toBe('Hello world');
  });

  it('similarity returns 1 for identical, high for near-identical, low for unrelated', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('hello world', 'hello WORLD')).toBeGreaterThan(0.4);
    expect(
      similarity('hello world', 'hello WORLD'),
    ).toBeGreaterThan(similarity('totally different', 'xyz'));
  });
});

describe('detached section', () => {
  it('splits body from trailing detached section', () => {
    const body = [
      '# Intro',
      '',
      'Some content.',
      '',
      '# Detached Comments',
      '',
      '- <!-- comment:a --><!-- # Alice: nit -->Alice @ Intro<!-- commend-end:a -->',
    ].join('\n');
    const { content, detached } = splitDetachedSection(body);
    expect(content).toContain('Some content.');
    expect(content).not.toContain('Detached');
    expect(detached).toHaveLength(1);
    expect(detached[0]?.uuid).toBe('a');
    expect(detached[0]?.anchorText).toBe('Alice @ Intro');
  });

  it('emits detached section roundtrip', () => {
    const entries = [
      {
        uuid: 'a',
        threadTags: '<!-- # Alice: nit -->',
        anchorText: 'Alice @ Section',
      },
    ];
    const emitted = emitDetachedSection(entries);
    expect(emitted).toContain('# Detached Comments');
    expect(emitted).toContain('<!-- comment:a -->');
    const { detached } = splitDetachedSection(emitted);
    expect(detached).toHaveLength(1);
    expect(detached[0]?.uuid).toBe('a');
  });
});

describe('conflict markers', () => {
  it('emit and detect', () => {
    const block = emitConflictBlock({ localText: 'L', remoteText: 'R' });
    expect(block).toContain('<<<<<<< LOCAL');
    expect(block).toContain('>>>>>>> REMOTE');
    expect(hasUnresolvedConflicts(block)).toBe(true);
    expect(hasUnresolvedConflicts('normal text')).toBe(false);
  });
});

describe('mergeDocument', () => {
  const block = (nodeId: string | undefined, text: string): SyncBlock => ({
    nodeId,
    text,
  });

  it('takes remote when local is unchanged vs base', () => {
    const base = [block('n1', 'Hello world.')];
    const local = [block('n1', 'Hello world.')];
    const remote = [
      block(
        'n1',
        'Hello <!-- comment:c1 --><!-- # Alice: hi -->world<!-- commend-end:c1 -->.',
      ),
    ];
    const res = mergeDocument({
      base,
      local,
      remote,
      existingDetached: [],
      remoteHeadings: {},
    });
    expect(res.hasConflicts).toBe(false);
    expect(res.body).toContain('<!-- comment:c1 -->');
    expect(res.body).toContain('<!-- # Alice: hi -->');
  });

  it('keeps local edits and ports over still-anchorable comments', () => {
    const base = [block('n1', 'Hello brown fox.')];
    const local = [block('n1', 'Greetings, brown fox!')];
    const remote = [
      block(
        'n1',
        'Hello <!-- comment:c1 -->brown fox<!-- commend-end:c1 -->.',
      ),
    ];
    const res = mergeDocument({
      base,
      local,
      remote,
      existingDetached: [],
      remoteHeadings: {},
    });
    expect(res.hasConflicts).toBe(false);
    expect(res.body).toContain('Greetings');
    expect(res.body).toContain('<!-- comment:c1 -->brown fox<!-- commend-end:c1 -->');
  });

  it('detaches comments whose anchor text vanished', () => {
    const base = [block('n1', 'Hello brown fox.')];
    const local = [block('n1', 'Goodbye red birds!')];
    const remote = [
      block(
        'n1',
        'Hello <!-- comment:c1 --><!-- # Alice: nit -->brown fox<!-- commend-end:c1 -->.',
      ),
    ];
    const res = mergeDocument({
      base,
      local,
      remote,
      existingDetached: [],
      remoteHeadings: { n1: 'Intro' },
    });
    expect(res.hasConflicts).toBe(false);
    expect(res.body).toContain('# Detached Comments');
    expect(res.body).toContain('<!-- comment:c1 -->');
    expect(res.body).toContain('Alice @ Intro');
  });

  it('flags conflicts when both sides edited the same block differently', () => {
    const base = [block('n1', 'The cat sat.')];
    const local = [block('n1', 'The cat sat on the rug.')];
    const remote = [block('n1', 'The feline sat on the mat.')];
    const res = mergeDocument({
      base,
      local,
      remote,
      existingDetached: [],
      remoteHeadings: {},
    });
    expect(res.hasConflicts).toBe(true);
    expect(res.body).toContain('<<<<<<< LOCAL');
    expect(res.body).toContain('>>>>>>> REMOTE');
  });

  it('handles 2-way merge when base is null', () => {
    const local = [block('n1', 'Hello dear world.')];
    const remote = [
      block('n1', 'Hello <!-- comment:c1 -->dear<!-- commend-end:c1 --> world.'),
    ];
    const res = mergeDocument({
      base: null,
      local,
      remote,
      existingDetached: [],
      remoteHeadings: {},
    });
    expect(res.hasConflicts).toBe(false);
    expect(res.body).toContain('<!-- comment:c1 -->');
  });

  it('drops detached entries whose comments were re-anchored', () => {
    const base = [block('n1', 'brown fox')];
    const local = [block('n1', 'brown fox runs')];
    const remote = [
      block('n1', '<!-- comment:c1 -->brown fox<!-- commend-end:c1 -->'),
    ];
    const existing = [
      { uuid: 'c1', threadTags: '<!-- # A: old -->', anchorText: 'stale' },
    ];
    const res = mergeDocument({
      base,
      local,
      remote,
      existingDetached: existing,
      remoteHeadings: {},
    });
    expect(res.body).toContain('<!-- comment:c1 -->brown fox');
    expect(res.body).not.toContain('# Detached Comments');
  });

  it('drops detached entries whose comments no longer exist remotely', () => {
    const base = [block('n1', 'hello')];
    const local = [block('n1', 'hello')];
    const remote = [block('n1', 'hello')];
    const existing = [
      { uuid: 'gone', threadTags: '<!-- # A: old -->', anchorText: 'ghost' },
    ];
    const res = mergeDocument({
      base,
      local,
      remote,
      existingDetached: existing,
      remoteHeadings: {},
    });
    expect(res.body).not.toContain('gone');
    expect(res.body).not.toContain('# Detached Comments');
  });

  it('inserts new remote blocks at the end', () => {
    const base = [block('n1', 'old')];
    const local = [block('n1', 'old')];
    const remote = [
      block('n1', 'old'),
      block('n2', 'brand new remote block'),
    ];
    const res = mergeDocument({
      base,
      local,
      remote,
      existingDetached: [],
      remoteHeadings: {},
    });
    expect(res.body).toContain('brand new remote block');
    expect(res.body).toContain('<!-- node:n2 -->');
  });

  it('omits blocks the user deleted locally and detaches their comments', () => {
    const base = [
      block('n1', 'kept'),
      block('n2', 'to be deleted'),
    ];
    const local = [block('n1', 'kept')];
    const remote = [
      block('n1', 'kept'),
      block(
        'n2',
        '<!-- comment:c1 --><!-- # A: note -->to be deleted<!-- commend-end:c1 -->',
      ),
    ];
    const res = mergeDocument({
      base,
      local,
      remote,
      existingDetached: [],
      remoteHeadings: { n2: 'Old Section' },
    });
    expect(res.body).not.toMatch(/^\s*to be deleted\s*$/m);
    expect(res.body).toContain('# Detached Comments');
    expect(res.body).toContain('A @ Old Section');
  });

  it('buildHeadingMap walks preceding headings', () => {
    const blocks: SyncBlock[] = [
      { nodeId: 'h1', text: '# Intro' },
      { nodeId: 'p1', text: 'para under intro' },
      { nodeId: 'h2', text: '## Details' },
      { nodeId: 'p2', text: 'para under details' },
    ];
    const map = buildHeadingMap(blocks);
    expect(map.p1).toBe('Intro');
    expect(map.p2).toBe('Details');
  });
});
