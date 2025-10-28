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

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import { downloadAll } from "./commands/download.js";
import { uploadAll } from "./commands/upload.js";
import { createPageWizard } from "./commands/create.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  // Keep concise; detailed help lives per command
  console.log(
    [
      "Confluence CLI",
      "",
      "Usage:",
      "  cli download   # Download all mapped/headered pages",
      "  cli upload     # Upload changed pages (git-aware)",
      "  cli create     # Create a new page under a parent",
      "",
      "Env:",
      "  CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN",
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


