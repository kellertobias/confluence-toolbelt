/**
 * Initialize local environment by creating a commented .env file.
 *
 * Why: Provide a quick start so users can run commands without hunting
 * required environment variable names and formats.
 * How: Writes a `.env` in the current working directory if missing and
 * appends any missing keys with helpful inline comments if present.
 */

import fs from "fs";
import path from "path";

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
 * Create or update the .env file in the given directory.
 * - If it doesn't exist, write the full template.
 * - If it exists, append any missing top-level keys to avoid clobbering
 *   user customizations.
 */
export async function initEnv(opts: Options): Promise<void> {
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


