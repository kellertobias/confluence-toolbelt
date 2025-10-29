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
 * List Markdown files changed in the working tree.
 *
 * Notes:
 * - Uses `git.status()` which includes arrays for modified, created, and renamed.
 * - Returns all Markdown files (`.md`/`.mdx`) that have changes in the working tree.
 * - Paths returned are relative to the repository root.
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
    if (f && /\.mdx?$/.test(f)) candidates.add(f);
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

/**
 * Commit a single file to git with a simple update message.
 * 
 * Why: Automatically track Confluence uploads in version control to maintain
 * sync between local markdown and remote pages.
 * 
 * How: Stage the specific file and create a commit with format "update <filepath>".
 * The filepath in the message is relative to the repo root for clarity.
 * Skips files that are ignored by gitignore with a friendly notice.
 * Respects NO_AUTO_COMMIT environment variable to allow disabling auto-commits.
 * 
 * @param cwd - Repository root directory
 * @param filePath - Absolute path to the file to commit
 */
export async function commitFile(cwd: string, filePath: string): Promise<void> {
  // Check if auto-commits are disabled via environment variable
  if (process.env.NO_AUTO_COMMIT) {
    console.log(`[git] Skipped commit (NO_AUTO_COMMIT is set): ${filePath}`);
    return;
  }
  
  const git: SimpleGit = simpleGit({ baseDir: cwd });
  const path = await import("path");
  
  // Get relative path from repo root for the commit message
  const relativePath = path.relative(cwd, filePath);
  
  try {
    // Check if file is ignored by gitignore before attempting to commit
    const ignored = await git.checkIgnore(relativePath);
    if (ignored && ignored.length > 0) {
      console.log(`[git] Skipped commit (file ignored by .gitignore): ${relativePath}`);
      return;
    }
    
    // Stage the specific file
    await git.add(relativePath);
    
    // Check if there are actually changes to commit
    const status = await git.status();
    const hasChanges = status.staged.length > 0;
    
    if (!hasChanges) {
      // File has no changes, no need to commit
      return;
    }
    
    // Commit with the standardized message
    await git.commit(`update ${relativePath}`);
  } catch (err) {
    // Log but don't throw - upload succeeded, commit failure is non-critical
    console.warn(`[git] Failed to commit ${relativePath}:`, err instanceof Error ? err.message : err);
  }
}


