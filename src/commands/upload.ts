/**
 * Upload command: detect changed files and push updates to Confluence.
 */

import fs from "fs";
import path from "path";
import { fromEnv } from "../api.js";
import { parseHeader } from "../md-header.js";
import { parseBlocks } from "../inline-tags.js";
import { listChangedMarkdownFiles, commitFile } from "../git.js";
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
   * 1. --all flag → upload all markdown files (including READONLY for explicit intent)
   * 2. Explicit file paths → upload those specific files (including READONLY for explicit intent)
   * 3. No args → ALWAYS show interactive menu with non-READONLY files (changed files first)
   */
  let files: string[] = [];
  
  // Extract file paths from args (anything that's not a flag)
  const explicitPaths = args.filter((a) => !a.startsWith("--"));
  
  if (all) {
    // Mode 1: Upload all markdown files (skip filtering in selection, will filter during upload)
    files = walkMarkdown(opts.cwd);
  } else if (explicitPaths.length > 0) {
    // Mode 2: Upload explicitly specified files (respect explicit user intent)
    files = explicitPaths.map((p) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(opts.cwd, p);
      if (!fs.existsSync(abs)) {
        throw new Error(`File not found: ${p}`);
      }
      return abs;
    });
  } else {
    // Mode 3: ALWAYS show interactive menu for file selection
    // Include ALL markdown files with pageId, even those in gitignore, but exclude READONLY
    const allMd = walkMarkdown(opts.cwd, true); // true = include gitignored files
    const candidates = allMd.filter((f) => {
      try {
        const txt = fs.readFileSync(f, "utf8");
        const { meta } = parseHeader(txt);
        // Include files with pageId that are NOT readonly
        return !!meta.pageId && !meta.readonly;
      } catch { return false; }
    });

    if (candidates.length === 0) {
      console.log("[upload] No candidate files found (files with pageId and not READONLY)");
      return;
    }

    // Show interactive menu for file selection
    console.log("[upload] Select files to upload (use --all to skip selection)");
    console.log("");
    const changedFilePaths = (await listChangedMarkdownFiles(opts.cwd)).map((p) => path.resolve(opts.cwd, p));
    files = await selectFilesInteractively(opts.cwd, candidates, new Set(changedFilePaths));
    if (files.length === 0) {
      console.log("[upload] No files selected");
      return;
    }
  }

  if (verbose) {
    /**
     * Print candidate files and selection strategy for transparency when requested.
     * Why: Speeds up debugging by showing exactly what will be considered for upload.
     * How: Sort to show git-changed files first for better visibility.
     */
    const changedFiles = (await listChangedMarkdownFiles(opts.cwd)).map((p) => path.resolve(opts.cwd, p));
    const changedSet = new Set(changedFiles);
    const sortedFiles = [...files].sort((a, b) => {
      const aChanged = changedSet.has(a);
      const bChanged = changedSet.has(b);
      if (aChanged && !bChanged) return -1;
      if (!aChanged && bChanged) return 1;
      return a.localeCompare(b);
    });
    const mode = all ? "all" : explicitPaths.length > 0 ? "explicit" : "interactive";
    console.log(`[upload] Mode=${mode} candidates=${sortedFiles.length}`);
    for (const f of sortedFiles) {
      const isChanged = changedSet.has(f);
      const relativePath = path.relative(opts.cwd, f);
      console.log(`[upload]   ${isChanged ? "●" : "○"} ${relativePath}`);
    }
  }
  if (files.length === 0) { console.log("[upload] No candidate files"); return; }

  for (const file of files) {
    const md = fs.readFileSync(file, "utf8");
    const { meta, body } = parseHeader(md);
    if (!meta.pageId) { console.log(`[upload] Skip (no pageId): ${file}`); continue; }
    // Skip files marked as READONLY - they can be downloaded but never uploaded
    if (meta.readonly) { console.log(`[upload] Skip (READONLY): ${path.relative(opts.cwd, file)}`); continue; }

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
    
    /**
     * Automatically commit the uploaded file to git for version tracking.
     * Why: Keeps git history in sync with Confluence updates, making it easy to
     * track what was uploaded and when.
     * How: Stage and commit only this specific file with a standardized message.
     */
    await commitFile(opts.cwd, file);
  }
}

/**
 * Present an interactive menu to let users select which files to upload.
 * Why: When no changes are detected and no explicit paths provided, give users
 * a convenient way to choose files without typing full paths.
 * How: Use enquirer's multiselect prompt with relative paths for readability.
 * Sort files so that those with git changes appear at the top for easy access.
 */
async function selectFilesInteractively(cwd: string, candidates: string[], changedFiles: Set<string>): Promise<string[]> {
  if (candidates.length === 0) return [];

  // Sort candidates to show changed files first
  const sortedCandidates = [...candidates].sort((a, b) => {
    const aChanged = changedFiles.has(a);
    const bChanged = changedFiles.has(b);
    if (aChanged && !bChanged) return -1;
    if (!aChanged && bChanged) return 1;
    return a.localeCompare(b);
  });

  // Build choices with relative paths and indicators for changed files
  // Note: enquirer multiselect needs both 'name' (display) and 'value' (return value)
  const choices = sortedCandidates.map((f) => {
    const relativePath = path.relative(cwd, f);
    const indicator = changedFiles.has(f) ? "● " : "○ ";
    return {
      name: indicator + relativePath,
      value: f,  // Return the absolute path
      message: indicator + relativePath,  // Also set message for compatibility
    };
  });

  try {
    const response = await prompt<{ files: string[] }>({
      type: "multiselect",
      name: "files",
      message: "Select files to upload (● = changed, ○ = unchanged | space to select, enter to confirm)",
      choices,
      initial: 0,
      result(names: string[]) {
        // Ensure we return values, not names
        return names;
      },
    } as any); // enquirer types are incomplete; limit and other options work at runtime
    
    // The response should contain the 'value' fields from selected choices
    const selectedFiles = response.files || [];
    
    // Safety check: ensure we have absolute paths, not display names
    return selectedFiles.map(file => {
      // If file still has indicator, strip it and resolve properly
      if (file.startsWith('● ') || file.startsWith('○ ')) {
        const cleanPath = file.substring(2); // Remove indicator
        return path.resolve(cwd, cleanPath);
      }
      return file;
    });
  } catch (err) {
    // User cancelled (Ctrl+C) or other error
    return [];
  }
}

/**
 * Recursively walk directory tree to find markdown files.
 * Why: Need to discover all markdown files in the workspace, optionally including gitignored files.
 * How: Traverse filesystem and filter by extension, respecting or ignoring .gitignore based on flag.
 */
function walkMarkdown(dir: string, includeGitignored: boolean = false): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  
  // Skip common ignored directories unless explicitly including gitignored files
  const ignoredDirs = new Set(['.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', '.cache']);
  
  for (const entry of fs.readdirSync(dir)) {
    // Skip hidden files/dirs and common ignored directories (unless includeGitignored is true)
    if (!includeGitignored && (entry.startsWith('.') || ignoredDirs.has(entry))) {
      continue;
    }
    
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      out.push(...walkMarkdown(p, includeGitignored));
    } else if (/\.mdx?$/.test(entry)) {
      out.push(p);
    }
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


