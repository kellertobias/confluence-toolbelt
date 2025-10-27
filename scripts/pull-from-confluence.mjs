#!/usr/bin/env node
/**
 * Pull pages from Confluence and write/update local Markdown files.
 *
 * Why: The upstream @telefonica/markdown-confluence-sync is one-way (local -> Confluence).
 * This utility provides a basic pull to fetch the latest online content before local edits.
 *
 * How: For each entry in `confluence-pages.json` mapping (path -> { id, title? }),
 * - fetch Confluence storage format (vnd.atlanto storage) via REST API
 * - convert HTML to Markdown using Turndown (+ GFM plugin)
 * - write Markdown to the mapped file path, preserving frontmatter when present:
 *   - ensure `title` and `sync_to_confluence: true` remain
 *   - do NOT overwrite non-frontmatter content blindly if conversion fails
 *
 * Caveats:
 * - Inline comment anchors in Confluence may not map back to Markdown; comments are not pulled.
 * - Complex Confluence macros may degrade during HTML->MD conversion.
 * - This is best-effort; review diffs after pulling.
 */

import fs from "fs";
import path from "path";
import url from "url";
import dotenv from "dotenv";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

dotenv.config();

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const mappingFile = path.resolve(repoRoot, "confluence-pages.json");

/**
 * Minimal logger for consistent output.
 */
function log(level, message, extra) {
  const base = `[pull:${level}] ${message}`;
  if (extra) {
    // eslint-disable-next-line no-console
    console.log(base, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(base);
  }
}

/**
 * Read JSON mapping of local file paths to Confluence ids.
 */
function readMapping() {
  if (!fs.existsSync(mappingFile)) {
    throw new Error(`Mapping file not found at ${mappingFile}`);
  }
  const raw = fs.readFileSync(mappingFile, "utf8");
  const mapping = JSON.parse(raw);
  return Object.entries(mapping).map(([filePath, meta]) => ({
    filePath: path.resolve(repoRoot, filePath),
    id: meta.id,
    title: meta.title,
  }));
}

/**
 * Build fetch options based on env credentials.
 * Supports Basic (CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN) or OAuth2/JWT via CONFLUENCE_ACCESS_TOKEN.
 */
function buildAuthHeaders() {
  const headers = { "Accept": "application/json" };
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  const bearer = process.env.CONFLUENCE_ACCESS_TOKEN;
  if (email && token) {
    const basic = Buffer.from(`${email}:${token}`).toString("base64");
    headers["Authorization"] = `Basic ${basic}`;
  } else if (bearer) {
    headers["Authorization"] = `Bearer ${bearer}`;
  }
  return headers;
}

/**
 * Fetch Confluence page content in storage format (HTML-like) with title.
 */
async function fetchPageStorage(confluenceBaseUrl, pageId) {
  const url = new URL(`/wiki/api/v2/pages/${pageId}?body-format=storage`, confluenceBaseUrl);
  const res = await fetch(url, { headers: buildAuthHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch page ${pageId}: ${res.status} ${res.statusText}\n${text}`);
  }
  const data = await res.json();
  // v2 returns body.storage.value under data.body.storage.value
  const storageValue = data?.body?.storage?.value ?? "";
  const title = data?.title ?? "";
  return { title, storageValue };
}

/**
 * Convert Confluence storage HTML to Markdown.
 */
function convertStorageHtmlToMarkdown(storageHtml) {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.use(gfm);
  return turndown.turndown(storageHtml || "");
}

/**
 * Extract frontmatter if present; return { frontmatter, content } with frontmatter including delimiters.
 */
function splitFrontmatter(text) {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      const fm = text.slice(0, end + 5);
      const body = text.slice(end + 5);
      return { frontmatter: fm, content: body };
    }
  }
  return { frontmatter: null, content: text };
}

/**
 * Ensure frontmatter contains `title` and `sync_to_confluence: true`.
 */
function buildFrontmatter(existing, titleFromRemote, fileTitleOverride) {
  const title = fileTitleOverride || titleFromRemote || "";
  const lines = existing ? existing.split("\n").filter(Boolean) : ["---", "title: " + JSON.stringify(title), "sync_to_confluence: true", "---"]; 
  if (!existing) return lines.join("\n") + "\n";

  // Keep existing; update/insert fields
  const out = [];
  let inBlock = false;
  let sawTitle = false;
  let sawSync = false;
  for (const line of lines) {
    if (line === "---" && !inBlock) { inBlock = true; out.push(line); continue; }
    if (line === "---" && inBlock) { inBlock = false; continue; }
    if (inBlock) {
      if (line.trim().startsWith("title:")) { out.push("title: " + JSON.stringify(title)); sawTitle = true; continue; }
      if (line.trim().startsWith("sync_to_confluence:")) { out.push("sync_to_confluence: true"); sawSync = true; continue; }
      out.push(line);
    }
  }
  if (!sawTitle) out.splice(1, 0, "title: " + JSON.stringify(title));
  if (!sawSync) out.splice(2, 0, "sync_to_confluence: true");
  return out.join("\n") + "\n---\n";
}

async function main() {
  const baseUrl = process.env.MARKDOWN_CONFLUENCE_SYNC_URL || process.env.CONFLUENCE_URL;
  if (!baseUrl) {
    throw new Error("CONFLUENCE_URL or MARKDOWN_CONFLUENCE_SYNC_URL must be set in env");
  }

  const mappings = readMapping();
  log("info", `Found ${mappings.length} mapped file(s)`);

  for (const { filePath, id, title } of mappings) {
    if (!id) { log("warn", `Skipping ${filePath} because it has no id`); continue; }
    try {
      log("info", `Fetching page ${id} for ${filePath}`);
      const { title: remoteTitle, storageValue } = await fetchPageStorage(baseUrl, id);
      const markdown = convertStorageHtmlToMarkdown(storageValue);

      let existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
      const { frontmatter, content } = splitFrontmatter(existing);
      const fm = buildFrontmatter(frontmatter, remoteTitle, title);
      const next = fm + "\n" + markdown.trim() + "\n";

      // Avoid no-op writes
      if (existing === next) {
        log("info", `No changes for ${filePath}`);
      } else {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, next, "utf8");
        log("info", `Updated ${filePath}`);
      }
    } catch (e) {
      log("error", `Failed to pull for ${filePath}: ${e.message}`);
    }
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


