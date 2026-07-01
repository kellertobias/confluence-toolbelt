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

/**
 * Replace Confluence page URLs in markdown links with page:SPACE:ID references.
 *
 * Why: Authors sometimes paste full Confluence browser URLs as link hrefs.
 * These break when pages are moved between spaces and are verbose. Normalising
 * them to the internal page:SPACE:ID scheme makes them uniform with other
 * internal page links and lets the upload path convert them correctly.
 *
 * How: Match links whose href starts with the configured Confluence host
 * and follows the /wiki/spaces/SPACE/pages/ID pattern, then rewrite to
 * the page:SPACE:ID scheme. Called on both upload and download so the
 * canonical format is consistent in local markdown files.
 *
 * @param markdown - Markdown body to process
 * @param baseUrl  - CONFLUENCE_BASE_URL (e.g. https://company.atlassian.net)
 * @returns markdown with Confluence page URLs replaced by page:SPACE:ID links
 */
export function resolveConfluencePageUrls(
  markdown: string,
  baseUrl: string,
): string {
  if (!baseUrl) return markdown;

  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return markdown;
  }
  if (!host) return markdown;

  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\[([^\\]]+)\\]\\(https?://${escapedHost}/(?:wiki/)?spaces/([^/]+)/pages/(\\d+)(?:/[^)]*)?\\)`,
    'g',
  );

  return markdown.replace(
    pattern,
    (_m, text: string, space: string, id: string) =>
      `[${text}](pageid:${space}:${id})`,
  );
}

/**
 * Find markdown links whose href is a URL on the Confluence host but could
 * not be parsed into the page:SPACE:ID scheme (e.g. blog posts, search pages,
 * or unusual paths).
 *
 * Why: After `resolveConfluencePageUrls` has run, any surviving URL that still
 * points to the same Confluence instance is either a non-page link or a URL
 * with an unexpected structure. We surface these so the author can fix them
 * rather than silently uploading a raw URL that Confluence renders as a plain
 * external link instead of a proper <ac:link>.
 *
 * @param markdown - Markdown body (should be called AFTER resolveConfluencePageUrls)
 * @param baseUrl  - CONFLUENCE_BASE_URL
 * @returns array of raw hrefs that look Confluencey but could not be parsed
 */
export function findUnparsedConfluenceLinks(
  markdown: string,
  baseUrl: string,
): string[] {
  if (!baseUrl) return [];

  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return [];
  }
  if (!host) return [];

  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\[[^\\]]+\\]\\((https?://${escapedHost}[^)]+)\\)`,
    'g',
  );

  const found: string[] = [];
  for (const m of markdown.matchAll(pattern)) {
    if (m[1]) found.push(m[1]);
  }
  return found;
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
