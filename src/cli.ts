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
import { nodeDeflater } from "./adapters/node/deflate.js";
import { nodeDom } from "./adapters/node/dom.js";
import { downloadAll } from "./commands/download.js";
// Lazy-load interactive commands to avoid importing optional deps during non-interactive runs
import { initEnv } from "./commands/init.js";
import { uploadAll } from "./commands/upload.js";
import { setDeflater } from "./storage-dom/deflate.js";
import { setDom } from "./storage-dom/dom.js";

dotenv.config();
// Register the node DOM + zlib adapters for the conversion code.
setDom(nodeDom);
setDeflater(nodeDeflater);

function printHelp() {
  // Keep concise; detailed help lives per command
  console.log(
    [
      "Confluence CLI",
      "",
      "Usage:",
      "  cli init                                    # Initialize git, .gitignore, and .env",
      "  cli download [--force] [--verbose]         # Download all mapped/headered pages",
      "  cli pull [--force] [--verbose]             # Alias for 'download'",
      "  cli upload [--all] [--verbose] [--debug] [file...]   # Upload pages:",
      "                                                     #   --all: upload all markdown files",
      "                                                     #   [file...]: upload specific files",
      "                                                     #   (no args): interactive menu or git changes",
      "                                                     #   --debug: log every step incl. API timing",
      "  (WIP!) cli sync [--all] [--verbose] [--no-upload] [file...]",
      "                                              #   Three-way merge: pull remote comments/edits",
      "                                              #   into local, then upload (unless --no-upload)",
      "  cli create                                  # Interactive wizard: create a new page under a parent",
      '  cli create sibling <src.md> <new.md> [--title "..."]',
      "                                              #   Create page as a sibling of <src.md> (same parent)",
      '  cli create child   <src.md> <new.md> [--title "..."]',
      "                                              #   Create page as a child of <src.md>",
      "  cli task                                    # Create a Jira task (reads .env defaults)",
      "  cli search <query> [--results n] [--preview [n]] [--show-links] [--json]",
      "                                              #   Search Confluence pages:",
      "                                              #     --results n  : max results (default 5)",
      "                                              #     --preview [n]: show n lines of excerpt (default 5)",
      "                                              #     --show-links : print full URL instead of hyperlinking",
      "                                              #     --json       : output as JSON",
      "",
      "Env:",
      "  CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN",
      "  JIRA_BASE_URL, JIRA_PROJECT_KEY, JIRA_EMAIL+JIRA_API_TOKEN or JIRA_ACCESS_TOKEN",
    ].join("\n"),
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
      {
        const { syncAll } = await import("./commands/sync.js");
        await syncAll({ cwd: process.cwd(), args });
      }
      break;
    case "create":
      {
        const { createPage } = await import("./commands/create.js");
        await createPage({ cwd: process.cwd(), args });
      }
      break;
    case "task":
      {
        const { createTask } = await import("./commands/task.js");
        await createTask({ cwd: process.cwd() });
      }
      break;
    case "search":
      {
        const { searchPages } = await import("./commands/search.js");
        await searchPages({ cwd: process.cwd(), args });
      }
      break;
    default:
      printHelp();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
