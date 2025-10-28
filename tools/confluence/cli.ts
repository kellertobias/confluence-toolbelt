#!/usr/bin/env node
/**
 * Confluence TS CLI entrypoint
 *
 * Why: Provide commands to download pages, upload changes, and create pages
 * using HTML comment headers and inline tags for node-level updates.
 *
 * How: Subcommands dispatch to dedicated modules. Environment is read from
 * process.env for Confluence Cloud basic auth.
 */

import dotenv from "dotenv";
import { downloadAll } from "./commands/download.js";
import { uploadAll } from "./commands/upload.js";
import { createPageWizard } from "./commands/create.js";
import { createTask } from "./commands/task.js";

dotenv.config();

function printHelp() {
  // Keep concise; detailed help lives per command
  console.log(
    [
      "Confluence CLI",
      "",
      "Usage:",
      "  cli download [--force] [--verbose]   # Download all mapped/headered pages",
      "  cli upload   [--all] [--verbose]     # Upload changed pages (git-aware)",
      "  cli create     # Create a new page under a parent",
      "  cli task       # Create a Jira task (reads .env defaults)",
      "",
      "Env:",
      "  CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN",
      "  JIRA_BASE_URL, JIRA_PROJECT_KEY, JIRA_EMAIL+JIRA_API_TOKEN or JIRA_ACCESS_TOKEN",
    ].join("\n")
  );
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case "download":
      await downloadAll({ cwd: process.cwd(), args });
      break;
    case "upload":
      await uploadAll({ cwd: process.cwd(), args });
      break;
    case "create":
      await createPageWizard({ cwd: process.cwd() });
      break;
    case "task":
      await createTask({ cwd: process.cwd() });
      break;
    case "-h":
    case "--help":
    default:
      printHelp();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


