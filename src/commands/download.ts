/**
 * Download command: fetch pages and write markdown with header and inline tags.
 */

import fs from "fs";
import path from "path";
import { fromEnv } from "../api.js";
import { emitHeader, parseHeader } from "../md-header.js";
import { storageToMarkdownBlocks, extractHeaderExtrasFromStorage } from "../storage-dom.js";
import { emitTag } from "../inline-tags.js";
import { commitFile } from "../git.js";

interface Options { cwd: string; args?: string[] }

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
function extractPageIdFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Match pattern: /pages/<pageId> or /pages/<pageId>/anything
    const match = urlObj.pathname.match(/\/pages\/(\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Sanitize a page title to create a safe filename.
 * Why: Page titles may contain characters not allowed in filenames.
 * How: Replace unsafe characters with hyphens and collapse multiple hyphens.
 */
function sanitizeTitle(title: string): string {
  return title
    .replace(/[^\w\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-')     // Replace spaces with hyphens
    .replace(/-+/g, '-')      // Collapse multiple hyphens
    .replace(/^-|-$/g, '')    // Remove leading/trailing hyphens
    .substring(0, 100);       // Limit length
}

/**
 * Format a date as YYMMDD.
 * Why: Create compact, sortable date prefixes for downloaded files.
 */
function formatDatePrefix(date: Date): string {
  const yy = String(date.getFullYear()).substring(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export async function downloadAll(opts: Options): Promise<void> {
  const force = opts.args?.includes("--force");
  const verbose = opts.args?.includes("--verbose");
  const client = fromEnv();
  
  // Extract non-flag arguments (potential URLs or file paths)
  const urlArgs = (opts.args || []).filter((a) => !a.startsWith("--"));
  
  /**
   * Mode 1: Download from URLs if provided
   * Why: Allow users to quickly download pages from browser URLs
   * How: Extract pageId from URL, fetch metadata, generate filename
   * 
   * Supports:
   * - Single URL: download https://...
   * - URL with custom path: download https://... path/to/file.md
   * - Multiple URLs: download URL1 URL2 URL3
   */
  if (urlArgs.length > 0) {
    // Check if first argument looks like a URL or pageId
    const firstArg = urlArgs[0];
    if (!firstArg) return; // Safety check
    
    const isUrl = firstArg.includes('http') || /^\d+$/.test(firstArg);
    
    if (isUrl) {
      // Check if second argument is a file path (not a URL)
      const secondArg = urlArgs[1];
      const hasCustomPath = secondArg && !secondArg.includes('http') && !/^\d+$/.test(secondArg);
      
      if (hasCustomPath) {
        // Single URL with custom file path
        await downloadFromUrl(opts.cwd, firstArg, { 
          force: force || false, 
          verbose: verbose || false, 
          client,
          customPath: secondArg 
        });
        return;
      } else {
        // One or more URLs without custom paths
        const urlsToDownload = urlArgs.filter(arg => {
          return arg.includes('http') || /^\d+$/.test(arg);
        });
        
        for (const urlOrPageId of urlsToDownload) {
          await downloadFromUrl(opts.cwd, urlOrPageId, { 
            force: force || false, 
            verbose: verbose || false, 
            client 
          });
        }
        return;
      }
    }
  }
  
  /**
   * Mode 2: Download existing markdown files with pageId headers
   * Why: Update local files that already have Confluence page mappings
   */
  // Discover .md files and extract pageId from header
  const all = walkMarkdown(opts.cwd);
  const entries = all
    .map((p) => ({ p, h: parseHeader(fs.readFileSync(p, "utf8")) }))
    .filter((x) => x.h.meta.pageId)
    .map((x) => [path.relative(opts.cwd, x.p), { id: String(x.h.meta.pageId), spaceId: x.h.meta.spaceId, title: x.h.meta.title }] as const);

  for (const [relPath, meta] of entries) {
    const filePath = path.resolve(opts.cwd, relPath);
    const { storageHtml, title: remoteTitle, spaceId: remoteSpaceId } = await client.getPageStorage(meta.id);
    const adf = await client.getPageAtlasDoc(meta.id);
    const v1 = await client.getPageV1Content(meta.id);
    const extras = extractHeaderExtrasFromStorage(storageHtml, remoteTitle);
    // If ADF contains a page metadata block with icon/cover/status, prefer it
    if (adf) {
      try {
        const doc = adf;
        // Find status panel block
        const statusNode = JSON.stringify(doc).match(/"type"\s*:\s*"status"[\s\S]*?"text"\s*:\s*"([^"]+)"/i);
        if (statusNode && !extras.status) extras.status = `grey:${statusNode[1]}`;
        const media = JSON.stringify(doc).match(/"type"\s*:\s*"media"[\s\S]*?"url"\s*:\s*"([^"]+)"/i);
        if (media && !extras.image) extras.image = media[1];
      } catch {}
    }
    // When verbose, persist the raw storage HTML in a hidden sibling file for inspection/debugging.
    if (verbose) {
      /**
       * Write the original Confluence storage HTML next to the markdown file
       * using a hidden filename: `.<filename>.confluence`.
       *
       * Why: Useful for debugging mapping issues and ensuring partial updates
       * map correctly back to original nodes.
       */
      const verbosePath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.confluence`);
      try {
        fs.writeFileSync(verbosePath, storageHtml ?? "", "utf8");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[download] Failed to write verbose file: ${path.relative(opts.cwd, verbosePath)}:`, err);
      }
    }

    const blocks = storageToMarkdownBlocks(storageHtml);
    // Join blocks and apply a final token decode pass for any durable tokens that might
    // have survived the per-block decoding (defensive against edge conversions)
    let body = blocks
      .map((b) => (b.nodeId ? emitTag({ tagType: "content", nodeId: b.nodeId }) : "") + b.markdown + "\n")
      .join("\n");
    body = body
      .replace(/MD(?:\\)?_CMT_START\(([^)]+)\)/g, (_m, enc) => `<!-- comment:${decodeURIComponent(String(enc || ''))} -->`)
      .replace(/MD(?:\\)?_CMT_END\(([^)]+)\)/g, (_m, enc) => `<!-- commend-end:${decodeURIComponent(String(enc || ''))} -->`);
    // Preserve optional header fields (emoji/status/image/readonly) from existing file header if present
    const existingText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const existingHeader = parseHeader(existingText).meta;
    const header = emitHeader({
      readonly: existingHeader.readonly, // preserve READONLY flag if it was set
      pageId: meta.id,
      spaceId: meta.spaceId || remoteSpaceId,
      title: meta.title || remoteTitle,
      status: (v1?.metadata?.properties?.status?.value) ?? extras.status ?? existingHeader.status,
    });
    const next = header + body.trim() + "\n";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    if (!force && existing === next) {
      console.log(`[download] No changes for ${relPath}`);
    } else {
      fs.writeFileSync(filePath, next, "utf8");
      console.log(`[download] Wrote ${relPath}`);
      
      /**
       * Automatically commit downloaded files to git for version tracking.
       * Why: Keep git history in sync with Confluence downloads, making it easy to
       * track what was downloaded and when.
       */
      await commitFile(opts.cwd, filePath);
    }
  }
}

/**
 * Download a page from a Confluence URL or pageId.
 * 
 * Why: Allow users to quickly download pages by pasting URLs from their browser.
 * 
 * How: Extract pageId from URL, fetch page metadata (including last modified date),
 * generate filename as YYMMDD-Title.md (or use custom path if provided), download content, and commit to git.
 * 
 * @param cwd - Current working directory
 * @param urlOrPageId - Confluence URL or pageId
 * @param opts - Options including force, verbose, client, and optional customPath
 */
async function downloadFromUrl(
  cwd: string,
  urlOrPageId: string,
  opts: { force: boolean; verbose: boolean; client: any; customPath?: string }
): Promise<void> {
  const { force, verbose, client, customPath } = opts;
  
  // Extract pageId from URL or use directly if it's already a pageId
  let pageId: string | null = null;
  if (/^\d+$/.test(urlOrPageId)) {
    // Already a pageId
    pageId = urlOrPageId;
  } else {
    // Try to extract from URL
    pageId = extractPageIdFromUrl(urlOrPageId);
  }
  
  if (!pageId) {
    console.error(`[download] Could not extract pageId from: ${urlOrPageId}`);
    return;
  }
  
  console.log(`[download] Fetching page ${pageId}...`);
  
  // Fetch page metadata to get last modified date and title
  const v1 = await client.getPageV1Content(pageId);
  if (!v1) {
    console.error(`[download] Failed to fetch page metadata for ${pageId}`);
    return;
  }
  
  const { storageHtml, title: remoteTitle, spaceId: remoteSpaceId } = await client.getPageStorage(pageId);
  const adf = await client.getPageAtlasDoc(pageId);
  
  // Determine file path: use custom path if provided, otherwise generate from title and date
  let filePath: string;
  let filename: string;
  
  if (customPath) {
    // Use custom path provided by user
    filePath = path.isAbsolute(customPath) ? customPath : path.resolve(cwd, customPath);
    filename = path.basename(filePath);
  } else {
    // Generate filename from last modified date and title
    const lastModified = v1.version?.when ? new Date(v1.version.when) : new Date();
    const datePrefix = formatDatePrefix(lastModified);
    const sanitizedTitle = sanitizeTitle(remoteTitle);
    filename = `${datePrefix}-${sanitizedTitle}.md`;
    filePath = path.join(cwd, filename);
  }
  
  // Extract additional metadata
  const extras = extractHeaderExtrasFromStorage(storageHtml, remoteTitle);
  if (adf) {
    try {
      const doc = adf;
      const statusNode = JSON.stringify(doc).match(/"type"\s*:\s*"status"[\s\S]*?"text"\s*:\s*"([^"]+)"/i);
      if (statusNode && !extras.status) extras.status = `grey:${statusNode[1]}`;
      const media = JSON.stringify(doc).match(/"type"\s*:\s*"media"[\s\S]*?"url"\s*:\s*"([^"]+)"/i);
      if (media && !extras.image) extras.image = media[1];
    } catch {}
  }
  
  // Write verbose HTML if requested
  if (verbose) {
    const verbosePath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.confluence`);
    try {
      fs.writeFileSync(verbosePath, storageHtml ?? "", "utf8");
      console.log(`[download] Wrote verbose HTML to ${path.relative(cwd, verbosePath)}`);
    } catch (err) {
      console.warn(`[download] Failed to write verbose file: ${err}`);
    }
  }
  
  // Convert storage HTML to markdown
  const blocks = storageToMarkdownBlocks(storageHtml);
  let body = blocks
    .map((b) => (b.nodeId ? emitTag({ tagType: "content", nodeId: b.nodeId }) : "") + b.markdown + "\n")
    .join("\n");
  body = body
    .replace(/MD(?:\\)?_CMT_START\(([^)]+)\)/g, (_m, enc) => `<!-- comment:${decodeURIComponent(String(enc || ''))} -->`)
    .replace(/MD(?:\\)?_CMT_END\(([^)]+)\)/g, (_m, enc) => `<!-- commend-end:${decodeURIComponent(String(enc || ''))} -->`);
  
  // Check if file already exists to preserve READONLY flag
  const existingText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const existingHeader = parseHeader(existingText).meta;
  
  // Create header with metadata
  const header = emitHeader({
    readonly: existingHeader.readonly,
    pageId: pageId,
    spaceId: remoteSpaceId,
    title: remoteTitle,
    status: (v1?.metadata?.properties?.status?.value) ?? extras.status ?? existingHeader.status,
  });
  
  const next = header + body.trim() + "\n";
  
  // Check if content has changed
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (!force && existing === next) {
    console.log(`[download] No changes for ${filename}`);
  } else {
    fs.writeFileSync(filePath, next, "utf8");
    console.log(`[download] Wrote ${filename}`);
    
    // Commit to git
    await commitFile(cwd, filePath);
  }
}

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) out.push(...walkMarkdown(p));
    else if (/\.mdx?$/.test(entry)) out.push(p);
  }
  return out;
}


