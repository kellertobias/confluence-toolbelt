/**
 * Git helpers built on top of simple-git.
 *
 * Why: We need a lightweight way to detect changed files and generate diffs
 * without shelling out manually. Using typed helpers makes future changes safer.
 *
 * How: We rely on `simple-git`'s named export `simpleGit` which returns a
 * `SimpleGit` instance. We also use `StatusResult` to maintain strictly typed
 * access to fields like `renamed` and avoid implicit any.
 */

import { simpleGit, SimpleGit, StatusResult } from "simple-git";

/**
 * List Markdown files changed in the working tree under the `docs/` folder.
 *
 * Notes:
 * - Uses `git.status()` which includes arrays for modified, created, and renamed.
 * - Restricts to paths that look like Markdown (`.md`/`.mdx`) and live in `docs/`.
 */
export async function listChangedMarkdownFiles(cwd: string): Promise<string[]> {
  const git: SimpleGit = simpleGit({ baseDir: cwd });
  const status: StatusResult = await git.status();
  const candidates = new Set<string>();
  for (const f of [
    ...status.modified,
    ...status.created,
    ...status.renamed.map((r) => r.to),
  ]) {
    if (f && /\.mdx?$/.test(f) && f.startsWith("docs/")) candidates.add(f);
  }
  return Array.from(candidates);
}

/**
 * Get the diff for a single file path relative to the repo root.
 * Returns an empty string when the file has no diff or when git throws
 * (e.g., the file is untracked or outside the repo).
 */
export async function getDiffForFile(cwd: string, filePath: string): Promise<string> {
  const git: SimpleGit = simpleGit({ baseDir: cwd });
  try {
    return await git.diff(["--", filePath]);
  } catch {
    return "";
  }
}


