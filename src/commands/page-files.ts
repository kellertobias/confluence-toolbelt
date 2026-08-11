/**
 * Shared filename/discovery helpers for the download commands.
 *
 * Kept separate from `download.ts` so the single-page and tree downloads can
 * both use them without importing each other.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseHeader } from '../md-header.js';

/**
 * Extract pageId from a Confluence URL.
 * Supports formats like:
 * - https://domain.atlassian.net/wiki/spaces/SPACE/pages/123456/Page+Title
 * - https://domain.com/wiki/spaces/SPACE/pages/123456
 *
 * Why: Allow users to download pages directly from browser URLs without manually
 * extracting pageId.
 *
 * How: Match the /pages/<pageId> pattern in the URL path.
 */
export function extractPageIdFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Match pattern: /pages/<pageId> or /pages/<pageId>/anything
    const match = urlObj.pathname.match(/\/pages\/(\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Accept either a bare pageId or any Confluence page URL. */
export function resolvePageId(urlOrPageId: string): string | null {
  const trimmed = urlOrPageId.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  return extractPageIdFromUrl(trimmed);
}

/**
 * Sanitize a page title to create a safe filename.
 * Why: Page titles may contain characters not allowed in filenames.
 * How: Replace unsafe characters with hyphens and collapse multiple hyphens.
 */
export function sanitizeTitle(title: string): string {
  return title
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
    .substring(0, 100); // Limit length
}

/**
 * Format a date as YYMMDD.
 * Why: Create compact, sortable date prefixes for downloaded files.
 */
export function formatDatePrefix(date: Date): string {
  const yy = String(date.getFullYear()).substring(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * True for our own hidden markdown sidecar (`.<name>.base.md`, a copy of the
 * markdown last downloaded/uploaded for `<name>`).
 *
 * Why: it carries a full page header, so any "markdown file with a pageId"
 * scan would otherwise mistake it for a real note.
 */
export function isSidecarMarkdown(filename: string): boolean {
  return /^\..*\.base\.mdx?$/.test(filename);
}

/**
 * All markdown files under `dir`, recursively.
 *
 * Dotfiles and dot-folders are skipped: those are our own hidden sidecars
 * (`.<name>.base.md` holds a copy of a note's markdown) and `.git`, never
 * documents the user manages.
 */
export function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.')) {
      continue;
    }
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      out.push(...walkMarkdown(p));
    } else if (/\.mdx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Map pageId → existing file (POSIX path relative to `cwd`).
 *
 * Why: a tree download should refresh the notes the user already has rather
 * than writing a second copy under the tree layout.
 */
export function indexPagesById(cwd: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of walkMarkdown(cwd)) {
    try {
      const { meta } = parseHeader(fs.readFileSync(file, 'utf8'));
      if (meta.pageId && !index.has(String(meta.pageId))) {
        index.set(
          String(meta.pageId),
          path.relative(cwd, file).split(path.sep).join('/'),
        );
      }
    } catch {
      // unreadable file — ignore
    }
  }
  return index;
}
