/**
 * Git helpers using simple-git to detect changed files and diffs.
 */

import simpleGit from "simple-git";

export async function listChangedMarkdownFiles(cwd: string): Promise<string[]> {
  const git = simpleGit({ baseDir: cwd });
  const status = await git.status();
  const candidates = new Set<string>();
  for (const f of [...status.modified, ...status.created, ...status.renamed.map(r => r.to)]) {
    if (f && /\.mdx?$/.test(f) && f.startsWith("docs/")) candidates.add(f);
  }
  return Array.from(candidates);
}

export async function getDiffForFile(cwd: string, filePath: string): Promise<string> {
  const git = simpleGit({ baseDir: cwd });
  try {
    return await git.diff(["--", filePath]);
  } catch {
    return "";
  }
}


