/**
 * Create command: prompt for parent and title, create page, write empty MD.
 */

import path from "path";
import fs from "fs";
import { prompt } from "enquirer";
import { fromEnv } from "../api.js";
import { emitHeader } from "../md-header.js";

interface Options { cwd: string }

export async function createPageWizard(opts: Options): Promise<void> {
  const client = fromEnv();
  const answers: any = await prompt([
    { name: "parentUrl", type: "input", message: "Parent page URL (leave empty for none):" },
    { name: "spaceId", type: "input", message: "Space ID:" },
    { name: "title", type: "input", message: "Title for new page:" },
  ]);

  const parentId = extractPageIdFromUrl(answers.parentUrl || "");
  const { id } = await client.createPage(answers.spaceId, answers.title, parentId);

  const fileSafe = answers.title.replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-").toLowerCase();
  const rel = path.join("docs", `${fileSafe}.md`);
  const abs = path.resolve(opts.cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const header = emitHeader({ spaceId: String(answers.spaceId), pageId: id });
  const content = header; // only the header as requested
  fs.writeFileSync(abs, content, "utf8");
  console.log(`[create] Created page ${id} and file ${rel}`);
}

function extractPageIdFromUrl(url: string): string | undefined {
  // Cloud: https://your.atlassian.net/wiki/spaces/SPACE/pages/123456/Title
  const m = url.match(/\/pages\/(\d+)/);
  return m ? m[1] : undefined;
}


