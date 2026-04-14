/**
 * Resolve local markdown file links to Confluence pageid: links.
 *
 * Why: When editing locally, authors use relative file paths like
 * [Label](REFS/some-page.md). On upload these must become Confluence
 * page links so the published document links to the correct online page.
 *
 * How: Scan for markdown links whose href ends in .md or .mdx, resolve
 * the path relative to the current file, read the target's header for
 * pageId, and rewrite to the pageid: scheme that markdownToStorageHtml
 * converts to <ri:page ri:content-id="..."/>. This works cross-space
 * and is immune to page renames.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseHeader } from './md-header.js';

/**
 * Replace local .md/.mdx links in markdown with Confluence pageid: links.
 *
 * @param markdown    - Raw markdown body (after header has been stripped)
 * @param currentFile - Absolute path to the file being uploaded
 * @param cwd         - Workspace root for resolving paths
 * @returns markdown with local links replaced by pageid: links
 */
export function resolveLocalPageLinks(
  markdown: string,
  currentFile: string,
  cwd: string,
): string {
  const currentDir = path.dirname(currentFile);

  return markdown.replace(
    /\[([^\]]+)\]\(([^)]+\.mdx?)\)/g,
    (match, text, href) => {
      const targetPath = path.resolve(currentDir, href);

      if (!fs.existsSync(targetPath)) {
        const cwdRelative = path.resolve(cwd, href);
        if (fs.existsSync(cwdRelative)) {
          return resolveToPageLink(cwdRelative, text, match);
        }
        console.warn(
          `[local-links] Target not found, keeping original link: ${href}`,
        );
        return match;
      }

      return resolveToPageLink(targetPath, text, match);
    },
  );
}

function resolveToPageLink(
  targetPath: string,
  text: string,
  fallback: string,
): string {
  try {
    const content = fs.readFileSync(targetPath, 'utf8');
    const { meta } = parseHeader(content);

    if (!meta.pageId) {
      console.warn(
        `[local-links] Target has no pageId, keeping original: ${targetPath}`,
      );
      return fallback;
    }

    return `[${text}](pageid:${meta.pageId})`;
  } catch {
    console.warn(`[local-links] Failed to read target file: ${targetPath}`);
    return fallback;
  }
}
