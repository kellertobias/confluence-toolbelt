/**
 * Markdown escape normalization helpers.
 *
 * Turndown tends to over-escape characters on round-trips (underscores,
 * asterisks, numeric list markers). These helpers clean up the common cases
 * without disturbing content inside code spans or fenced blocks.
 */

/**
 * Remove backslash escapes before underscores outside of code blocks and code
 * spans, and normalize other common over-escapes produced by Turndown.
 *
 * We keep any escapes inside fenced/indented code or inline code (`...`).
 */
export function unescapeMarkdownUnderscores(md: string): string {
  // Step 1: remove single escaped underscores.
  let out = md.replace(/\\_/g, "_");
  // Step 2: collapse any remaining multiple backslashes before '_' to a single
  // backslash. This ensures sequences like \\_ become \_
  out = out.replace(/\\{2,}_/g, "\\_");
  // Step 3: for asterisks, collapse multiple backslashes before '*' to a
  // single backslash (avoid multiplying on round-trips).
  out = out.replace(/\\{2,}\*/g, "\\*");
  /**
   * Step 4: unescape numbered enumerations with periods.
   *
   * Why: Turndown may escape dots after numbers (e.g., `1\.`) to prevent
   * unintended list interpretation. We unescape these in two contexts:
   * - At start of line for numbered lists: `1\. Item` → `1. Item`
   * - After header markers: `# 1\. Header` → `# 1. Header`
   */
  out = out.replace(/^(\s*\d+)\\\./gm, "$1.");
  out = out.replace(/^(#{1,6}\s+\d+)\\\./gm, "$1.");
  // Step 5: inside code regions (inline `code` and fenced ``` blocks), remove
  // escapes before '*'.
  out = unescapeAsterisksInsideCode(out);
  /**
   * Step 6: Unescape sequences of three or more dashes that Turndown escapes
   * (e.g. `\---` or `\----`) to prevent confusion with setext headings.
   *
   * Why: On download, plain dash sequences in paragraphs are preserved as-is
   * in Confluence, and Turndown's safety escape is cosmetic noise.
   */
  out = out.replace(/\\(-{3,})/g, "$1");
  /**
   * Step 7: collapse any remaining backslash run before punctuation down to
   * one, the general form of steps 2 and 3.
   *
   * Heals pages already damaged by escapes having been copied into storage and
   * re-escaped on every download: fixing the upload side stops the run growing,
   * but only this shortens one that already has.
   */
  out = collapseEscapeRuns(out);
  return out;
}

/**
 * Remove escapes for asterisks inside markdown code regions.
 *
 * Why: In code (inline or fenced), '*' is literal and does not need escaping;
 * keeping backslashes creates noisy round-trips where they accumulate.
 */
function unescapeAsterisksInsideCode(markdown: string): string {
  let processed = markdown;
  // Fenced code blocks ```lang?\n...\n```
  processed = processed.replace(/```[^\n]*\n[\s\S]*?```/g, (block) => {
    const m = block.match(/^(```[^\n]*\n)([\s\S]*?)(\n```)?$/);
    if (!m) {
      return block.replace(/\\\*/g, "*");
    }
    const prefix = m[1] || "";
    const body = m[2] || "";
    const suffix = m[3] || "";
    return prefix + body.replace(/\\\*/g, "*") + suffix;
  });
  // Inline code `...`
  processed = processed.replace(/`[^`]*`/g, (span) =>
    span.replace(/\\\*/g, "*"),
  );
  return processed;
}

/**
 * Drop the backslashes markdown uses to escape punctuation, on the way *into*
 * Confluence storage.
 *
 * Storage HTML is not markdown, so an escape has no meaning there — but it used
 * to be copied in verbatim. Turndown then escaped the backslash itself on the
 * next download, so every round-trip doubled it: `\[3\]` became `\\\[3\\\]`,
 * then `\\\\\\\[3\\\\\\\]`, until the text was unreadable and the link it
 * belonged to no longer parsed.
 *
 * Only punctuation markdown actually escapes is unescaped, so a backslash in
 * prose (`C:\Users`, a LaTeX macro) is left alone. Callers must run this after
 * code spans are stashed and before fenced blocks are emitted — an escape
 * inside code is content, not syntax.
 */
export function unescapeMarkdownPunctuation(md: string): string {
  return md.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1");
}

/**
 * Collapse runs of backslashes before punctuation down to one, on the way out
 * of Confluence storage.
 *
 * Repairs pages already damaged by the doubling above: without this they would
 * keep whatever depth of escaping they had accumulated, since the fix on the
 * upload side only stops it getting worse.
 */
export function collapseEscapeRuns(md: string): string {
  return md.replace(/\\{2,}([`*_{}[\]()#+\-.!>~|])/g, "\\$1");
}
