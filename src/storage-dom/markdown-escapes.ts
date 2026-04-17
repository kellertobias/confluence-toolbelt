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
