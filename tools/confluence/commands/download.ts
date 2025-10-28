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
  const mappingPath = path.resolve(opts.cwd, "confluence-pages.json");
  const docsDir = path.resolve(opts.cwd, "docs");
  const mapping: Record<string, { id: string; title?: string }> = fs.existsSync(mappingPath)
    ? JSON.parse(fs.readFileSync(mappingPath, "utf8"))
    : {};

  let entries = Object.entries(mapping);
  if (entries.length === 0) {
    // Fallback: scan docs for header
    const all = walkMarkdown(docsDir);
    const headered = all
      .map((p) => ({ p, h: parseHeader(fs.readFileSync(p, "utf8")) }))
      .filter((x) => x.h.meta.pageId)
      .map((x) => [path.relative(opts.cwd, x.p), { id: String(x.h.meta.pageId) } as { id: string }]);
    entries = headered as any;
  }

  for (const [relPath, meta] of entries) {
    const filePath = path.resolve(opts.cwd, relPath);
    const { storageHtml } = await client.getPageStorage(meta.id);
    const blocks = storageToMarkdownBlocks(storageHtml);
    const body = blocks
      .map((b) => (b.nodeId ? emitTag({ tagType: "content", nodeId: b.nodeId }) : "") + b.markdown + "\n")
      .join("\n");
    const header = emitHeader({ pageId: meta.id, spaceId: undefined });
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


