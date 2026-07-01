/**
 * Search command: full-text search across Confluence pages.
 *
 * Outputs a formatted list of matching pages with their pageid: reference,
 * the clickable browser URL, and an optional content excerpt.
 */

import { fromEnv } from "../adapters/node/confluence.js";
import { decodeHtmlEntities } from "../storage-dom/html-utils.js";

interface Options {
  cwd: string;
  args?: string[];
}

// ---------------------------------------------------------------------------
// ANSI helpers (only applied when stdout is a TTY)
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY ?? false;

const ansi = {
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[39m` : s),
  reset: (s: string) => (isTTY ? `\x1b[0m${s}\x1b[0m` : s),
  /** OSC 8 hyperlink — supported by iTerm2, VS Code, GNOME Terminal, etc. */
  link: (text: string, url: string) =>
    isTTY ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text,
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  query: string;
  json: boolean;
  showLinks: boolean;
  previewLines: number;
  limit: number;
}

function parseArgs(args: string[]): ParsedArgs {
  const json = args.includes("--json");
  const showLinks = args.includes("--show-links");
  let previewLines = 0;
  let limit = 5;

  const previewIdx = args.indexOf("--preview");
  if (previewIdx !== -1) {
    const next = args[previewIdx + 1];
    previewLines = next && /^\d+$/.test(next) ? parseInt(next, 10) : 5;
  }

  const resultsIdx = args.indexOf("--results");
  if (resultsIdx !== -1) {
    const next = args[resultsIdx + 1];
    if (next && /^\d+$/.test(next)) {
      limit = parseInt(next, 10);
    }
  }

  // Everything that is not a flag or a flag's value is part of the query.
  const flagsWithValue = new Set<string>();
  if (
    previewIdx !== -1 &&
    args[previewIdx + 1] &&
    /^\d+$/.test(args[previewIdx + 1] ?? "")
  ) {
    flagsWithValue.add(args[previewIdx + 1] as string);
  }
  if (
    resultsIdx !== -1 &&
    args[resultsIdx + 1] &&
    /^\d+$/.test(args[resultsIdx + 1] ?? "")
  ) {
    flagsWithValue.add(args[resultsIdx + 1] as string);
  }

  const queryWords = args.filter(
    (a) => !a.startsWith("--") && !flagsWithValue.has(a),
  );
  const query = queryWords.join(" ").trim();

  return { query, json, showLinks, previewLines, limit };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags and decode basic entities from a Confluence excerpt. */
function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Return up to `n` non-blank lines from a block of text. */
function firstLines(text: string, n: number): string[] {
  if (n <= 0) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTui(
  results: Array<{
    id: string;
    title: string;
    spaceKey: string;
    webUiPath: string;
    excerpt: string;
  }>,
  query: string,
  previewLines: number,
  baseUrl: string,
  showLinks: boolean,
): void {
  const count = results.length;
  console.log("");
  console.log(
    ansi.bold(`Search: "${query}"`) +
      ansi.dim(` · ${count} result${count === 1 ? "" : "s"}`),
  );

  if (count === 0) {
    console.log("");
    console.log(ansi.dim("  No pages found."));
    console.log("");
    return;
  }

  console.log("");

  for (const [i, r] of results.entries()) {
    const pageLink = `page:${r.spaceKey}:${r.id}`;
    const fullUrl = `${baseUrl}${r.webUiPath}`;
    const num = ansi.dim(`${i + 1}.`);

    // Title line
    const space = ansi.dim(`[${r.spaceKey}]`);
    console.log(`  ${num} ${ansi.bold(r.title)}  ${space}`);

    if (showLinks) {
      // --show-links: plain reference + explicit URL on the next line
      console.log(`     ${ansi.cyan(pageLink)}  ${ansi.dim("→")}  ${fullUrl}`);
    } else {
      // Default: page:SPACE:ID is an OSC 8 hyperlink (clickable in modern terminals)
      console.log(`     ${ansi.link(ansi.cyan(pageLink), fullUrl)}`);
    }

    // Optional excerpt
    if (previewLines > 0 && r.excerpt) {
      const lines = firstLines(stripHtml(r.excerpt), previewLines);
      if (lines.length > 0) {
        console.log("");
        for (const line of lines) {
          console.log(`     ${ansi.dim(line)}`);
        }
      }
    }

    console.log("");
  }
}

function renderJson(
  results: Array<{
    id: string;
    title: string;
    spaceKey: string;
    webUiPath: string;
    excerpt: string;
  }>,
  query: string,
  previewLines: number,
  baseUrl: string,
): void {
  const output = results.map((r) => {
    const obj: Record<string, unknown> = {
      id: r.id,
      title: r.title,
      spaceKey: r.spaceKey,
      link: `page:${r.spaceKey}:${r.id}`,
      url: `${baseUrl}${r.webUiPath}`,
    };
    if (previewLines > 0) {
      obj.excerpt = firstLines(stripHtml(r.excerpt), previewLines).join("\n");
    }
    return obj;
  });
  console.log(JSON.stringify({ query, results: output }, null, 2));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function searchPages(opts: Options): Promise<void> {
  const { query, json, showLinks, previewLines, limit } = parseArgs(
    opts.args ?? [],
  );

  if (!query) {
    console.error(
      "Usage: cli search <query> [--json] [--preview [n]] [--results n]",
    );
    process.exit(1);
  }

  const client = fromEnv();
  const results = await client.searchPages(query, limit);

  if (json) {
    renderJson(results, query, previewLines, client.baseUrl);
  } else {
    renderTui(results, query, previewLines, client.baseUrl, showLinks);
  }
}
