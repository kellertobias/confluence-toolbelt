/**
 * Walk a Confluence page hierarchy and plan where its notes go on disk.
 *
 * Platform-agnostic: takes a `ConfluenceClient` slice and pure helpers, so both
 * the Node CLI (`download --tree`) and the Obsidian plugin ("Download page
 * tree") share one traversal and one layout.
 *
 * Layout: a page becomes `<Folder>/<Title>.md`; its children live in a folder
 * named after it — `<Folder>/<Title>/<Child>.md`. Pages with no children get no
 * folder. Paths are always POSIX-relative to the chosen target folder's root
 * (the vault root for the plugin, the cwd for the CLI).
 */

import type { ConfluenceClient } from "../../api.js";

export interface PageTreeNode {
  id: string;
  title: string;
  children: PageTreeNode[];
}

/** The client surface a tree walk needs. */
export type TreeClient = Pick<ConfluenceClient, "getPage" | "getChildPages">;

export interface FetchTreeOptions {
  /** How many levels of children to follow. 0 = the root page only.
   * Defaults to unlimited. */
  maxDepth?: number;
  /** Progress callback, called once per page whose children are fetched. */
  onStep?: (message: string, found: number) => void;
}

/**
 * Fetch the page tree rooted at `rootId`.
 *
 * Child pages the caller cannot read simply never come back from the API, so
 * "all children it has access to" falls out of the traversal. A page whose
 * children lookup throws is kept as a leaf rather than aborting the walk.
 */
export async function fetchPageTree(
  client: TreeClient,
  rootId: string,
  opts: FetchTreeOptions = {},
): Promise<PageTreeNode> {
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const step = opts.onStep ?? (() => {});

  const root = await client.getPage(rootId);
  const tree: PageTreeNode = {
    id: String(root.id ?? rootId),
    title: String(root.title ?? rootId),
    children: [],
  };

  // Breadth-first so progress reads top-down, with a visited set guarding
  // against a cycle in the reported hierarchy.
  const visited = new Set<string>([tree.id]);
  let level: PageTreeNode[] = [tree];
  let count = 1;

  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const next: PageTreeNode[] = [];
    for (const node of level) {
      step(`Scanning "${node.title}"…`, count);
      let children: Awaited<ReturnType<TreeClient["getChildPages"]>> = [];
      try {
        children = await client.getChildPages(node.id);
      } catch {
        continue; // unreadable subtree → treat this page as a leaf
      }
      for (const c of children) {
        if (visited.has(c.id)) {
          continue;
        }
        visited.add(c.id);
        const child: PageTreeNode = { id: c.id, title: c.title, children: [] };
        node.children.push(child);
        next.push(child);
        count++;
      }
    }
    level = next;
  }

  return tree;
}

/** Total number of pages in a tree. */
export function countPages(node: PageTreeNode): number {
  return 1 + node.children.reduce((n, c) => n + countPages(c), 0);
}

export interface PlannedPage {
  id: string;
  title: string;
  /** POSIX path of the note, relative to the vault/cwd root. */
  notePath: string;
  /** 0 for the root page. */
  depth: number;
  /** True when the path came from an already-downloaded note. */
  reusedExisting: boolean;
}

export interface LayoutOptions {
  /** Folder the root note lands in. "" = vault/cwd root. */
  folder: string;
  /** Host-specific filename sanitizer (CLI and Obsidian differ). */
  sanitize: (title: string) => string;
  /** Path of an already-downloaded note for this pageId, if any. Keeps a
   * re-downloaded tree writing to the files the user already has instead of
   * creating duplicates elsewhere. */
  existingPath?: (pageId: string) => string | null | undefined;
}

/**
 * Turn a page tree into concrete note paths, parents before children.
 *
 * Sibling pages whose titles sanitize to the same filename get a numeric
 * suffix so neither is silently dropped.
 */
export function planTreeLayout(
  root: PageTreeNode,
  opts: LayoutOptions,
): PlannedPage[] {
  const out: PlannedPage[] = [];
  const used = new Set<string>();
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

  const walk = (node: PageTreeNode, folder: string, depth: number): void => {
    const existing = opts.existingPath?.(node.id) ?? null;
    let notePath: string;
    if (existing) {
      notePath = existing;
    } else {
      const base = opts.sanitize(node.title) || node.id;
      let candidate = join(folder, `${base}.md`);
      for (let n = 2; used.has(candidate.toLowerCase()); n++) {
        candidate = join(folder, `${base} ${n}.md`);
      }
      notePath = candidate;
    }
    used.add(notePath.toLowerCase());
    out.push({
      id: node.id,
      title: node.title,
      notePath,
      depth,
      reusedExisting: Boolean(existing),
    });
    // Children go in a folder named after the parent note — including when the
    // parent kept an existing path, so the tree stays anchored to it.
    const childFolder = notePath.replace(/\.mdx?$/i, "");
    for (const child of node.children) {
      walk(child, childFolder, depth + 1);
    }
  };

  walk(root, opts.folder.replace(/\/+$/, ""), 0);
  return out;
}

/** Every folder a plan needs, parents first, so hosts whose `mkdir` is
 * non-recursive can create them in order. */
export function foldersForPlan(plan: PlannedPage[]): string[] {
  const dirs = new Set<string>();
  for (const p of plan) {
    const parts = p.notePath.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return [...dirs].filter(Boolean).sort((a, b) => a.length - b.length);
}
