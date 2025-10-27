/**
 * Markdown Confluence Sync configuration
 *
 * Why: We want explicit control over which files sync to which Confluence pages by ID.
 * How: Use `mode: "id"` with `filesPattern` to select files, and `filesMetadata`
 *      populated from an external JSON mapping to avoid touching MD frontmatter.
 *
 * Auth: Configure via environment variables to avoid committing secrets.
 *   - MARKDOWN_CONFLUENCE_SYNC_URL or CONFLUENCE_URL
 *   - For basic auth: CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN
 *   - Or provide OAuth/JWT by adjusting below accordingly.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-check

// Load environment variables from .env if present.
// Why: Allow local development without exporting env vars globally.

const dotenv = require("dotenv");
dotenv.config();

const fs = require("fs");
const path = require("path");

/**
 * Load file-to-Confluence ID mapping from a JSON file.
 * Structure example:
 * {
 *   "./docs/page-a.md": { "id": "123456", "title": "Optional override" },
 *   "./docs/intro.mdx": { "id": "987654" }
 * }
 */
function loadFilesMetadata(mappingPath) {
  const absolute = path.resolve(process.cwd(), mappingPath);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  const raw = fs.readFileSync(absolute, "utf8");
  /** @type {Record<string, { id: string; title?: string; shortName?: string; sync?: boolean }>} */
  const mapping = JSON.parse(raw);
  return Object.entries(mapping).map(([filePath, meta]) => ({
    path: filePath,
    id: meta.id,
    title: meta.title,
    shortName: meta.shortName,
    sync: meta.sync !== false,
  }));
}

/** @type {import('@telefonica/markdown-confluence-sync').Configuration} */
module.exports = {
  // Directory where your markdown lives
  docsDir: "./docs",

  // Use id mode so each file targets a specific Confluence page by ID
  mode: "id",

  // Match all md/mdx under docs. The library filters to md/mdx anyhow,
  // but we keep the pattern explicit for clarity.
  filesPattern: "docs/**/*.{md,mdx}",

  // Keep repo clean of generated Mermaid images and skip node_modules
  ignore: ["**/mermaid-diagrams/**", "**/node_modules/**"],

  // External mapping of file paths to page IDs
  filesMetadata: loadFilesMetadata("./confluence-pages.json"),

  // Confluence connection. Prefer env for secrets.
  confluence: {
    url: process.env.MARKDOWN_CONFLUENCE_SYNC_URL || process.env.CONFLUENCE_URL || "",

    // Choose one auth method below. By default, use basic via env vars.
    authentication: process.env.CONFLUENCE_EMAIL && process.env.CONFLUENCE_API_TOKEN
      ? {
          basic: {
            email: process.env.CONFLUENCE_EMAIL,
            apiToken: process.env.CONFLUENCE_API_TOKEN,
          },
        }
      : undefined,

    // Space identifier required by the library even in id mode.
    // Accept either numeric CONFLUENCE_SPACE_ID or legacy CONFLUENCE_SPACE_KEY.
    spaceKey: process.env.CONFLUENCE_SPACE_ID || process.env.CONFLUENCE_SPACE_KEY,
    rootPageId: process.env.CONFLUENCE_ROOT_PAGE_ID,

    // Make it easy to dry run from CLI via env
    dryRun: process.env.CONFLUENCE_DRY_RUN === "true",
  },

  // Enable argument/file/env config reads for flexibility when running in CI or locally
  config: {
    readArguments: true,
    readFile: true,
    readEnvironment: true,
  },
};


