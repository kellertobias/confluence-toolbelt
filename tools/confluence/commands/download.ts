/**
 * Download command: fetch pages and write markdown with header and inline tags.
 */

import fs from "fs";
import path from "path";
import { fromEnv } from "../api.js";
import { emitHeader, parseHeader } from "../md-header.js";
import { storageToMarkdownBlocks } from "../storage-dom.js";
import { emitTag } from "../inline-tags.js";

interface Options { cwd: string; args?: string[] }

export async function downloadAll(opts: Options): Promise<void> {
  const force = opts.args?.includes("--force");
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
    const blocks = storageToMarkdownBlocks(storageHtml);
    const body = blocks
      .map((b) => (b.nodeId ? emitTag({ tagType: "content", nodeId: b.nodeId }) : "") + b.markdown + "\n")
      .join("\n");
    // Preserve optional header fields (emoji/status/image) from existing file header if present
    const existingText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const existingHeader = parseHeader(existingText).meta;
    const header = emitHeader({
      pageId: meta.id,
      spaceId: meta.spaceId || remoteSpaceId,
      title: meta.title || remoteTitle,
      emoji: existingHeader.emoji,
      status: existingHeader.status,
      image: existingHeader.image,
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


