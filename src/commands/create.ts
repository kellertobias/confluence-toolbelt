/**
 * Create command: create a new Confluence page and a matching local markdown file.
 *
 * Supported modes:
 *   - Interactive wizard (no extra args): prompts for parent URL, space, title.
 *   - `create sibling <source.md> <new.md>`: new page becomes a sibling of the
 *     page referenced by <source.md> (same parent).
 *   - `create child <source.md> <new.md>`: new page becomes a child of the
 *     page referenced by <source.md>.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type ConfluenceClient, fromEnv } from '../api.js';
import { commitFile } from '../git.js';
import { emitHeader, parseHeader } from '../md-header.js';

interface Options {
  cwd: string;
  args?: string[];
}

export async function createPage(opts: Options): Promise<void> {
  const { args = [] } = opts;
  const sub = args[0];

  if (sub === 'sibling' || sub === 'child') {
    await createRelativePage(opts, sub);
    return;
  }

  // Fallback to the legacy interactive wizard when no subcommand is provided
  await createPageWizard({ cwd: opts.cwd });
}

/**
 * Create a new page positioned relative to an existing local markdown file.
 *
 * Why: Makes page creation scriptable from the CLI without prompts, driven by
 * the metadata already stored in the source markdown's header.
 * How: Read the source file's pageId, ask Confluence for that page (to get
 * parentId and spaceId), then POST a new page using the appropriate parent
 * based on the requested relation.
 */
async function createRelativePage(
  opts: Options,
  relation: 'sibling' | 'child',
): Promise<void> {
  const { args = [] } = opts;
  const positional = args.slice(1).filter((a) => !a.startsWith('--'));
  const flags = parseFlags(args.slice(1));

  const sourceRel = positional[0];
  const newRel = positional[1];
  if (!sourceRel || !newRel) {
    throw new Error(
      `Usage: cli create ${relation} <source.md> <new.md> [--title "Page Title"]`,
    );
  }
  const sourceAbs = path.isAbsolute(sourceRel)
    ? sourceRel
    : path.resolve(opts.cwd, sourceRel);
  const newAbs = path.isAbsolute(newRel)
    ? newRel
    : path.resolve(opts.cwd, newRel);

  if (!fs.existsSync(sourceAbs)) {
    throw new Error(`Source file not found: ${sourceRel}`);
  }
  if (fs.existsSync(newAbs)) {
    throw new Error(`Target file already exists: ${newRel}`);
  }

  const sourceMd = fs.readFileSync(sourceAbs, 'utf8');
  const { meta: sourceMeta } = parseHeader(sourceMd);
  if (!sourceMeta.pageId) {
    throw new Error(
      `Source file has no pageId in its header: ${sourceRel}. Download the page first.`,
    );
  }

  const client = fromEnv();
  const sourcePage = await client.getPage(sourceMeta.pageId);

  const spaceId = sourceMeta.spaceId || sourcePage.spaceId;
  if (!spaceId) {
    throw new Error(
      `Could not determine spaceId for source page ${sourceMeta.pageId}`,
    );
  }

  let parentId: string | undefined;
  if (relation === 'child') {
    parentId = sourcePage.id;
  } else {
    parentId = sourcePage.parentId;
    if (!parentId) {
      throw new Error(
        `Source page ${sourcePage.id} has no parent; cannot create a sibling at space root.`,
      );
    }
  }

  const title = flags.title ?? deriveTitleFromFilename(newAbs);

  const { id } = await client.createPage(String(spaceId), title, parentId);

  writeNewMarkdownFile({
    absPath: newAbs,
    cwd: opts.cwd,
    spaceId: String(spaceId),
    pageId: id,
    title,
  });

  console.log(
    `[create] Created ${relation} page "${title}" (id=${id}) under parent ${parentId} and wrote ${path.relative(opts.cwd, newAbs)}`,
  );

  try {
    await commitFile(opts.cwd, newAbs);
  } catch {
    // commit is best-effort; don't fail the command if git isn't configured
  }
}

function writeNewMarkdownFile(args: {
  absPath: string;
  cwd: string;
  spaceId: string;
  pageId: string;
  title: string;
}): void {
  fs.mkdirSync(path.dirname(args.absPath), { recursive: true });
  const header = emitHeader({
    spaceId: args.spaceId,
    pageId: args.pageId,
    title: args.title,
  });
  fs.writeFileSync(args.absPath, header, 'utf8');
}

/**
 * Turn a filename like `my-new-page.md` into a reasonable default title
 * `My New Page`. Users can override with --title for full control.
 */
function deriveTitleFromFilename(absPath: string): string {
  const base = path.basename(absPath).replace(/\.mdx?$/i, '');
  const words = base.replace(/[-_]+/g, ' ').trim().split(/\s+/);
  return words
    .map((w) => {
      if (!w) {
        return '';
      }
      const first = w[0];
      return first ? first.toUpperCase() + w.slice(1) : '';
    })
    .join(' ');
}

function parseFlags(args: string[]): { title?: string } {
  const out: { title?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) {
      continue;
    }
    if (a === '--title') {
      out.title = args[i + 1];
      i++;
    } else if (a.startsWith('--title=')) {
      out.title = a.slice('--title='.length);
    }
  }
  return out;
}

/**
 * Legacy interactive create wizard: prompts for parent URL, space, and title,
 * then creates a page and writes a skeleton markdown file under `docs/`.
 */
export async function createPageWizard(opts: {
  cwd: string;
}): Promise<void> {
  const { prompt } = await import('enquirer');
  const client: ConfluenceClient = fromEnv();
  const answers: any = await prompt([
    {
      name: 'parentUrl',
      type: 'input',
      message: 'Parent page URL (leave empty for none):',
    },
    { name: 'spaceId', type: 'input', message: 'Space ID:' },
    { name: 'title', type: 'input', message: 'Title for new page:' },
  ]);

  const parentId = extractPageIdFromUrl(answers.parentUrl || '');
  const { id } = await client.createPage(
    answers.spaceId,
    answers.title,
    parentId,
  );

  const fileSafe = answers.title
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
  const rel = path.join('docs', `${fileSafe}.md`);
  const abs = path.resolve(opts.cwd, rel);
  writeNewMarkdownFile({
    absPath: abs,
    cwd: opts.cwd,
    spaceId: String(answers.spaceId),
    pageId: id,
    title: answers.title,
  });
  console.log(`[create] Created page ${id} and file ${rel}`);
}

function extractPageIdFromUrl(url: string): string | undefined {
  // Cloud: https://your.atlassian.net/wiki/spaces/SPACE/pages/123456/Title
  const m = url.match(/\/pages\/(\d+)/);
  return m?.[1];
}
