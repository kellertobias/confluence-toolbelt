/**
 * Download command: fetch pages and write markdown with header and inline tags.
 */

import fs from "fs";
import path from "path";
import { fromEnv } from "../api.js";
import { emitHeader, parseHeader } from "../md-header.js";
import { storageToMarkdownBlocks, extractHeaderExtrasFromStorage } from "../storage-dom.js";
import { emitTag } from "../inline-tags.js";

interface Options { cwd: string; args?: string[] }

export async function downloadAll(opts: Options): Promise<void> {
  const force = opts.args?.includes("--force");
  const verbose = opts.args?.includes("--verbose");
  const client = fromEnv();
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
    // Preserve optional header fields (emoji/status/image) from existing file header if present
    const existingText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const existingHeader = parseHeader(existingText).meta;
    const header = emitHeader({
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
    }
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


