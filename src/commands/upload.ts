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
import enquirer from "enquirer";

const { prompt } = enquirer;

interface Options { cwd: string; args?: string[] }

export async function uploadAll(opts: Options): Promise<void> {
  const { args = [] } = opts;
  const all = args.includes("--all");
  const verbose = args.includes("--verbose");
  const client = fromEnv();

  /**
   * Determine which files to upload based on provided arguments.
   * Priority:
   * 1. --all flag → upload all markdown files
   * 2. Explicit file paths → upload those specific files
   * 3. Git-detected changes → upload modified files
   * 4. Interactive menu → let user select from available files
   */
  let files: string[] = [];
  
  // Extract file paths from args (anything that's not a flag)
  const explicitPaths = args.filter((a) => !a.startsWith("--"));
  
  if (all) {
    // Mode 1: Upload all markdown files
    files = walkMarkdown(opts.cwd);
  } else if (explicitPaths.length > 0) {
    // Mode 2: Upload explicitly specified files
    files = explicitPaths.map((p) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(opts.cwd, p);
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found: ${p}`);
      }
      return abs;
    });
  } else {
    // Mode 3 & 4: Git-detected changes or interactive menu
    files = (await listChangedMarkdownFiles(opts.cwd)).map((p) => path.resolve(opts.cwd, p));
    
    if (files.length === 0) {
      // No git changes detected, collect all markdown files with pageId
      const allMd = walkMarkdown(opts.cwd);
      const candidates = allMd.filter((f) => {
        try {
          const txt = fs.readFileSync(f, "utf8");
          const { meta } = parseHeader(txt);
          return !!meta.pageId;
        } catch { return false; }
      });

      if (candidates.length === 0) {
        console.log("[upload] No candidate files found");
        return;
      }

      // Mode 4: Show interactive menu for file selection
      console.log("[upload] No git changes detected.");
      console.log("[upload] You can also use: 'upload --all' or 'upload <file-path>'");
      console.log("");
      files = await selectFilesInteractively(opts.cwd, candidates);
      if (files.length === 0) {
        console.log("[upload] No files selected");
        return;
      }
    }
  }

  if (verbose) {
    /**
     * Print candidate files and selection strategy for transparency when requested.
     * Why: Speeds up debugging by showing exactly what will be considered for upload.
     */
    const rel = files.map((f) => path.relative(opts.cwd, f));
    console.log(`[upload] Mode=${all ? "all" : explicitPaths.length > 0 ? "explicit" : "git"} candidates=${rel.length}`);
    for (const r of rel) console.log(`[upload]   • ${r}`);
  }
  if (files.length === 0) { console.log("[upload] No candidate files"); return; }

  for (const file of files) {
    const md = fs.readFileSync(file, "utf8");
    const { meta, body } = parseHeader(md);
    if (!meta.pageId) { console.log(`[upload] Skip (no pageId): ${file}`); continue; }

    const { storageHtml, version, title, spaceId } = await client.getPageStorage(meta.pageId);
    // Header does not support emoji; keep param reserved for future parity with download extras
    const effectiveTitle = buildEffectiveTitle(meta.title || title, undefined, meta.status);
    const blocks = parseBlocks(body);

    if (verbose) {
      /**
       * Report resolved metadata for the page and the number of content blocks parsed.
       * How: Show pageId, effective title, space, and block counts to aid troubleshooting.
       */
      const rel = path.relative(opts.cwd, file);
      console.log(`[upload] Preparing ${rel}`);
      console.log(`[upload]   pageId=${meta.pageId} space=${meta.spaceId || spaceId || "(inherit)"}`);
      if (effectiveTitle) console.log(`[upload]   title=\"${effectiveTitle}\"`);
      console.log(`[upload]   blocks=${blocks.length}`);
    }

    // Build replacements for blocks that have nodeId tags (upload only those)
    const replacements: Record<string, string> = {};
    for (const b of blocks) {
      if (!b.tag?.nodeId) continue;
      const html = markdownToStorageHtml(b.text);
      if (html.trim()) replacements[b.tag.nodeId] = html;
    }

    if (Object.keys(replacements).length > 0) {
      if (verbose) {
        /**
         * When partial update is possible, show which nodeIds will be replaced.
         * Why: Helps detect mismatches between local tags and remote document nodes.
         */
        const keys = Object.keys(replacements);
        console.log(`[upload]   partial update: nodeIds=${keys.join(", ")}`);
      }
      const { html, missing } = replaceNodesById(storageHtml, replacements);
      if (missing.length > 0) {
        console.warn(`[upload] Missing nodeIds on page ${meta.pageId}: ${missing.join(", ")}. Falling back to full update.`);
        const fullHtml = markdownToStorageHtml(body);
        if (verbose) {
          const verbosePath = path.join(path.dirname(file), `.${path.basename(file)}.upload.confluence`);
          try {
            fs.writeFileSync(verbosePath, fullHtml, "utf8");
            console.log(`[upload]   wrote verbose outgoing HTML -> ${path.relative(opts.cwd, verbosePath)}`);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[upload] Failed to write verbose file: ${path.relative(opts.cwd, verbosePath)}:`, err);
          }
        }
        await client.updatePageStorage(meta.pageId, fullHtml, version, effectiveTitle, meta.spaceId || spaceId);
      } else {
        if (verbose) {
          const verbosePath = path.join(path.dirname(file), `.${path.basename(file)}.upload.confluence`);
          try {
            fs.writeFileSync(verbosePath, html, "utf8");
            console.log(`[upload]   wrote verbose outgoing HTML -> ${path.relative(opts.cwd, verbosePath)}`);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[upload] Failed to write verbose file: ${path.relative(opts.cwd, verbosePath)}:`, err);
          }
        }
        await client.updatePageStorage(meta.pageId, html, version, effectiveTitle, meta.spaceId || spaceId);
      }
    } else {
      // No tags -> full page replacement
      const fullHtml = markdownToStorageHtml(body);
      if (verbose) {
        console.log("[upload]   no tags detected -> full page update");
        const verbosePath = path.join(path.dirname(file), `.${path.basename(file)}.upload.confluence`);
        try {
          fs.writeFileSync(verbosePath, fullHtml, "utf8");
          console.log(`[upload]   wrote verbose outgoing HTML -> ${path.relative(opts.cwd, verbosePath)}`);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[upload] Failed to write verbose file: ${path.relative(opts.cwd, verbosePath)}:`, err);
        }
      }
      await client.updatePageStorage(meta.pageId, fullHtml, version, effectiveTitle, meta.spaceId || spaceId);
    }
    console.log(`[upload] Updated page ${meta.pageId} from ${path.relative(opts.cwd, file)}`);
  }
}

/**
 * Present an interactive menu to let users select which files to upload.
 * Why: When no changes are detected and no explicit paths provided, give users
 * a convenient way to choose files without typing full paths.
 * How: Use enquirer's multiselect prompt with relative paths for readability.
 */
async function selectFilesInteractively(cwd: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];

  // Build choices with relative paths for better UX
  const choices = candidates.map((f) => ({
    name: path.relative(cwd, f),
    value: f,
  }));

  try {
    const response = await prompt<{ files: string[] }>({
      type: "multiselect",
      name: "files",
      message: "Select files to upload (space to select, enter to confirm)",
      choices,
      initial: 0,
    } as any); // enquirer types are incomplete; limit and other options work at runtime
    return response.files || [];
  } catch (err) {
    // User cancelled (Ctrl+C) or other error
    return [];
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


