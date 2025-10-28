/**
 * Upload command: detect changed files and push updates to Confluence.
 */

import fs from "fs";
import path from "path";
import { fromEnv } from "../api.js";
import { parseHeader } from "../md-header.js";
import { parseBlocks } from "../inline-tags.js";
import { listChangedMarkdownFiles } from "../git.js";
import { markdownToStorageHtml, replaceNodesById } from "../storage-dom.js";

interface Options { cwd: string; args?: string[] }

export async function uploadAll(opts: Options): Promise<void> {
  const { args = [] } = opts;
  const all = args.includes("--all");
  const client = fromEnv();

  let files: string[] = [];
  if (all) {
    files = walkMarkdown(path.resolve(opts.cwd, "docs"));
  } else {
    files = (await listChangedMarkdownFiles(opts.cwd)).map((p) => path.resolve(opts.cwd, p));
  }
  if (files.length === 0) { console.log("[upload] No candidate files"); return; }

  for (const file of files) {
    const md = fs.readFileSync(file, "utf8");
    const { meta, body } = parseHeader(md);
    if (!meta.pageId) { console.log(`[upload] Skip (no pageId): ${file}`); continue; }

    const { storageHtml, version, title, spaceId } = await client.getPageStorage(meta.pageId);
    const effectiveTitle = buildEffectiveTitle(meta.title || title, meta.emoji, meta.status);
    const blocks = parseBlocks(body);

    // Build replacements for blocks that have nodeId tags (upload only those)
    const replacements: Record<string, string> = {};
    for (const b of blocks) {
      if (!b.tag?.nodeId) continue;
      const html = markdownToStorageHtml(b.text);
      if (html.trim()) replacements[b.tag.nodeId] = html;
    }

    if (Object.keys(replacements).length > 0) {
      const { html, missing } = replaceNodesById(storageHtml, replacements);
      if (missing.length > 0) {
        console.warn(`[upload] Missing nodeIds on page ${meta.pageId}: ${missing.join(", ")}. Falling back to full update.`);
        const fullHtml = markdownToStorageHtml(body);
        await client.updatePageStorage(meta.pageId, fullHtml, version, effectiveTitle, meta.spaceId || spaceId);
      } else {
        await client.updatePageStorage(meta.pageId, html, version, effectiveTitle, meta.spaceId || spaceId);
      }
    } else {
      // No tags -> full page replacement
      const fullHtml = markdownToStorageHtml(body);
      await client.updatePageStorage(meta.pageId, fullHtml, version, effectiveTitle, meta.spaceId || spaceId);
    }
    console.log(`[upload] Updated page ${meta.pageId} from ${path.relative(opts.cwd, file)}`);
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

function buildEffectiveTitle(baseTitle?: string, emoji?: string, status?: string): string | undefined {
  let title = baseTitle || undefined;
  if (emoji) {
    // Confluence renders :emoji: shortcodes; keep simple prefix
    title = `${emoji} ${title || ""}`.trim();
  }
  if (status) {
    // Append status label to title for visibility; Confluence Status macro in title is not supported, so use text
    const parts = status.split(":");
    const label = parts.slice(1).join(":") || status;
    title = `${title || ""} [${label}]`.trim();
  }
  return title;
}


