/**
 * Parse and emit the `# Detached Comments` section appended to a file by
 * `sync` when a remote comment's anchor couldn't be placed in the edited
 * local text.
 *
 * Entry format:
 *   - <!-- comment:UUID --><!-- # Author: body -->Author @ Section<!-- commend-end:UUID -->
 *
 * The anchor text between the markers is a human-readable locator, not the
 * original comment text — the actual comment body stays in the thread tag.
 */

import { extractComments } from './place-comments.js';

export interface DetachedEntry {
  uuid: string;
  threadTags: string;
  /** Display text between the markers: e.g. "Alice @ 2.3 Widgets". */
  anchorText: string;
}

const SECTION_HEADING = '# Detached Comments';

/**
 * Split the body into content and detached section. The detached section is
 * the final `# Detached Comments` heading and everything that follows.
 */
export function splitDetachedSection(body: string): {
  content: string;
  detached: DetachedEntry[];
} {
  const re = /(^|\n)#\s+Detached\s+Comments\s*\n/gi;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    lastMatch = m;
  }
  if (!lastMatch) {
    return { content: body, detached: [] };
  }
  const contentEnd = lastMatch.index + (lastMatch[1] === '\n' ? 1 : 0);
  const content = body.slice(0, contentEnd).replace(/\s+$/, '');
  const tail = body.slice(lastMatch.index + lastMatch[0].length);
  const detached = parseDetachedEntries(tail);
  return { content, detached };
}

function parseDetachedEntries(tail: string): DetachedEntry[] {
  const entries: DetachedEntry[] = [];
  for (const rawLine of tail.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;
    const stripped = line.replace(/^-\s*/, '');
    const { comments } = extractComments(stripped);
    const first = comments[0];
    if (!first) continue;
    // Anchor text for detached is the text between markers — use whatever is
    // there as the display locator, preserving exactly what the user sees.
    entries.push({
      uuid: first.uuid,
      threadTags: first.threadTags,
      anchorText: first.anchorText,
    });
  }
  return entries;
}

export function emitDetachedSection(entries: DetachedEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [`\n\n${SECTION_HEADING}\n`];
  for (const e of entries) {
    const anchor = e.anchorText || '(no context)';
    lines.push(
      `- <!-- comment:${e.uuid} -->${e.threadTags}${anchor}<!-- commend-end:${e.uuid} -->`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Build a display locator for a detached entry: "Author @ Section Title".
 * Falls back gracefully when author or section are unavailable.
 */
export function buildLocator(
  threadTags: string,
  sectionTitle: string | undefined,
): string {
  const author = firstAuthor(threadTags);
  const section = (sectionTitle ?? '').trim();
  if (author && section) return `${author} @ ${section}`;
  if (author) return author;
  if (section) return `@ ${section}`;
  return '';
}

function firstAuthor(threadTags: string): string {
  const m = threadTags.match(/<!--\s*#\s*([^:]+):/);
  if (!m) return '';
  return (m[1] ?? '').trim();
}
