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
// Lazy-load interactive commands to avoid importing optional deps during non-interactive runs
import { initEnv } from "./commands/init.js";

dotenv.config();

function printHelp() {
  // Keep concise; detailed help lives per command
  console.log(
    [
      "Confluence CLI",
      "",
      "Usage:",
      "  cli init                              # Create or update .env with helpful comments",
      "  cli download [--force] [--verbose]   # Download all mapped/headered pages",
      "  cli pull [--force] [--verbose]       # Alias for 'download'",
      "  cli upload   [--all] [--verbose]     # Upload changed pages (git-aware)",
      "  cli sync                              # Placeholder: download then upload with diff preview (TBD)",
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
    case "init":
      await initEnv({ cwd: process.cwd() });
      break;
    case "download":
      await downloadAll({ cwd: process.cwd(), args });
      break;
    case "pull":
      await downloadAll({ cwd: process.cwd(), args });
      break;
    case "upload":
      await uploadAll({ cwd: process.cwd(), args });
      break;
    case "sync":
      console.log(
        [
          "[sync] Not yet implemented.",
          "Planned: download current page state, show git diff, then upload.",
          "For now, run 'download' then review diffs and run 'upload'.",
        ].join("\n")
      );
      break;
    case "create":
      {
        const { createPageWizard } = await import("./commands/create.js");
        await createPageWizard({ cwd: process.cwd() });
      }
      break;
    case "task":
      {
        const { createTask } = await import("./commands/task.js");
        await createTask({ cwd: process.cwd() });
      }
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


