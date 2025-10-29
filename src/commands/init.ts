/**
 * Initialize local environment by creating a commented .env file, initializing
 * git repository, and setting up .gitignore.
 *
 * Why: Provide a quick start so users can run commands without hunting
 * required environment variable names and formats. Also ensure proper git setup
 * to prevent accidental credential commits.
 * How: Writes a `.env` in the current working directory if missing, initializes
 * git repo if needed, creates/updates .gitignore to protect sensitive files.
 */

import fs from "fs";
import path from "path";
import { simpleGit } from "simple-git";

interface Options { cwd: string }

/**
 * Render the suggested .env template with helpful comments.
 */
function renderEnvTemplate(): string {
  const lines: string[] = [
    "# Confluence API (required)",
    "# Base URL example: https://your-domain.atlassian.net/wiki",
    "CONFLUENCE_BASE_URL=",
    "CONFLUENCE_EMAIL=",
    "CONFLUENCE_API_TOKEN=",
    "",
    "# Jira API (optional, only needed for `task` command)",
    "# Base URL example: https://your-domain.atlassian.net",
    "JIRA_BASE_URL=",
    "JIRA_PROJECT_KEY=",
    "# Auth: either provide a personal access token OR basic auth (email+api token)",
    "# JIRA_ACCESS_TOKEN=",
    "# JIRA_EMAIL=",
    "# JIRA_API_TOKEN=",
    "",
    "# Optional Jira defaults",
    "# JIRA_ISSUE_TYPE=Task",
    "# JIRA_PRIORITY=Medium",
    "# Comma-separated labels", 
    "# JIRA_LABELS=docs,automation",
    "# Comma-separated component names",
    "# JIRA_COMPONENTS=Documentation",
    "",
    "# Enable macOS GUI prompts for `task` (optional)",
    "# JIRA_GUI=1",
    "",
  ];
  return lines.join("\n");
}

/**
 * Initialize git repository in the current directory.
 * Why: Ensure version control is set up for tracking document changes.
 * How: Check if .git exists; if not, run git init.
 */
async function initGitRepo(opts: Options): Promise<void> {
  const gitDir = path.resolve(opts.cwd, ".git");
  
  if (fs.existsSync(gitDir)) {
    console.log(`[init] Git repository already initialized`);
    return;
  }

  const git = simpleGit({ baseDir: opts.cwd });
  await git.init();
  console.log(`[init] Initialized git repository`);
}

/**
 * Create or update .gitignore to include .env and other sensitive files.
 * Why: Prevent accidental commit of credentials and local configuration.
 * How: Create .gitignore if missing, then ensure .env is listed.
 */
function ensureGitignore(opts: Options): void {
  const gitignorePath = path.resolve(opts.cwd, ".gitignore");
  const entriesToAdd = [".env"];
  
  if (!fs.existsSync(gitignorePath)) {
    // Create new .gitignore with recommended entries
    const content = [
      "# Environment variables (credentials)",
      ".env",
      "",
      "# Node modules",
      "node_modules/",
      "",
      "# Build output",
      "dist/",
      "",
      "# OS files",
      ".DS_Store",
      "Thumbs.db",
      "",
    ].join("\n");
    fs.writeFileSync(gitignorePath, content, "utf8");
    console.log(`[init] Created .gitignore`);
    return;
  }

  // Check existing .gitignore and add missing entries
  const existing = fs.readFileSync(gitignorePath, "utf8");
  const lines = existing.split(/\r?\n/);
  const existingEntries = new Set(
    lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
  );

  const missing = entriesToAdd.filter((e) => !existingEntries.has(e));
  
  if (missing.length > 0) {
    const updated = existing.replace(/\s*$/, "\n") + 
      "\n# Added by confluence-tools init\n" + 
      missing.join("\n") + "\n";
    fs.writeFileSync(gitignorePath, updated, "utf8");
    console.log(`[init] Added ${missing.join(", ")} to .gitignore`);
  } else {
    console.log(`[init] .gitignore already contains .env`);
  }
}

/**
 * Create or update the .env file in the given directory.
 * - If it doesn't exist, write the full template.
 * - If it exists, append any missing top-level keys to avoid clobbering
 *   user customizations.
 */
function createOrUpdateEnv(opts: Options): void {
  const envPath = path.resolve(opts.cwd, ".env");
  const template = renderEnvTemplate();

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, template, "utf8");
    console.log(`[init] Wrote .env`);
    return;
  }

  // Append missing keys while preserving existing content
  const existing = fs.readFileSync(envPath, "utf8");
  const have = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => !l.startsWith("#") && /[A-Z0-9_]+=/.test(l))
      .map((l) => l.split("=", 1)[0])
  );

  const desiredKeys = [
    "CONFLUENCE_BASE_URL",
    "CONFLUENCE_EMAIL",
    "CONFLUENCE_API_TOKEN",
    "JIRA_BASE_URL",
    "JIRA_PROJECT_KEY",
    "JIRA_ACCESS_TOKEN",
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "JIRA_ISSUE_TYPE",
    "JIRA_PRIORITY",
    "JIRA_LABELS",
    "JIRA_COMPONENTS",
    "JIRA_GUI",
  ];

  // Build an appendix containing only missing keys with comments
  const appendixLines: string[] = [];
  function maybeAdd(key: string, comment?: string) {
    if (!have.has(key)) {
      if (comment) appendixLines.push(comment);
      appendixLines.push(`${key}=`);
    }
  }

  // Minimal grouping comments to keep the file readable after append
  const missingBefore = appendixLines.length;
  maybeAdd("CONFLUENCE_BASE_URL", "\n# Added by init: Confluence base URL");
  maybeAdd("CONFLUENCE_EMAIL");
  maybeAdd("CONFLUENCE_API_TOKEN");
  maybeAdd("JIRA_BASE_URL", "\n# Added by init: Jira settings (optional)");
  maybeAdd("JIRA_PROJECT_KEY");
  maybeAdd("JIRA_ACCESS_TOKEN");
  maybeAdd("JIRA_EMAIL");
  maybeAdd("JIRA_API_TOKEN");
  maybeAdd("JIRA_ISSUE_TYPE");
  maybeAdd("JIRA_PRIORITY");
  maybeAdd("JIRA_LABELS");
  maybeAdd("JIRA_COMPONENTS");
  maybeAdd("JIRA_GUI");

  if (appendixLines.length > missingBefore) {
    const next = existing.replace(/\s*$/, "\n") + appendixLines.join("\n") + "\n";
    fs.writeFileSync(envPath, next, "utf8");
    console.log(`[init] Updated .env with missing keys`);
  } else {
    console.log(`[init] .env already contains all known keys`);
  }
}

/**
 * Main initialization function: set up git, .gitignore, and .env.
 * Why: Provide complete project initialization in one command.
 * How: Orchestrate git init, .gitignore creation, and .env setup.
 */
export async function initEnv(opts: Options): Promise<void> {
  // 1. Initialize git repository
  await initGitRepo(opts);
  
  // 2. Ensure .gitignore exists and contains .env
  ensureGitignore(opts);
  
  // 3. Create or update .env file
  createOrUpdateEnv(opts);
}


