/**
 * Detect unsupported Confluence features in storage HTML.
 *
 * Why: Some Confluence layout and macro features cannot be properly represented
 * in markdown. We warn users that uploading will lose these features.
 *
 * How: Scan storage HTML for known unsupported patterns and return a list of
 * feature names that would be lost on upload.
 */

import { findExpandMacros, isInternalExpandTitle } from "./expand-macro.js";

interface FeatureCheck {
  label: string;
  test: (html: string) => boolean;
}

function hasStructuredMacro(html: string, names: string[]): boolean {
  const pattern = new RegExp(
    `<ac:structured-macro\\b[^>]*\\bac:name=["'](?:${names.join("|")})["']`,
    "i",
  );
  return pattern.test(html);
}

const CHECKS: FeatureCheck[] = [
  {
    label: "multi-column layout",
    test: (html) => hasStructuredMacro(html, ["section", "column"]),
  },
  {
    label: "page layout",
    test: (html) => /<ac:layout\b/i.test(html),
  },
  {
    /**
     * Expands round-trip through the `<!-- expand:Title -->` delimiters as long
     * as they sit at the top level of the page (or only inside other expands).
     * One nested in a table cell or a panel body does not: those renderers
     * flatten their content, so the collapse is lost. Only that case is
     * reported. Expands the tool writes itself (mermaid source, deflist /
     * requirement / list-table / footnote configuration) are never user content
     * and are always excluded.
     */
    label: "expand/collapse sections",
    test: (html) =>
      findExpandMacros(html).some(
        (macro) =>
          !isInternalExpandTitle(macro.title) &&
          macro.ancestors.some((ancestor) => ancestor !== "expand"),
      ),
  },
  {
    label: "excerpt macros",
    test: (html) => hasStructuredMacro(html, ["excerpt", "excerpt-include"]),
  },
  {
    label: "page include",
    test: (html) => hasStructuredMacro(html, ["include"]),
  },
  {
    label: "page tree/children display",
    test: (html) =>
      hasStructuredMacro(html, ["children", "pagetree", "pagetreesearch"]),
  },
  {
    label: "roadmap/timeline",
    test: (html) => hasStructuredMacro(html, ["roadmap", "timeline"]),
  },
  {
    label: "embedded iframe/widget/HTML",
    test: (html) => hasStructuredMacro(html, ["iframe", "widget", "html"]),
  },
  {
    label: "merged table cells",
    test: (html) => {
      // Remove list-table blocks so their intentional merges don't trigger the warning.
      const withoutListTables = html.replace(
        /<table\b[^>]*\bdata-list-table\s*=\s*["']true["'][^>]*>[\s\S]*?<\/table>/gi,
        "",
      );
      return /<t[hd]\b[^>]*\b(?:colspan|rowspan)=["']?[2-9]/i.test(
        withoutListTables,
      );
    },
  },
  {
    label: "charts/diagrams",
    test: (html) =>
      hasStructuredMacro(html, ["chart", "drawio", "gliffy", "lucidchart"]),
  },
  {
    label: "attachments list",
    test: (html) => hasStructuredMacro(html, ["attachments", "viewfile"]),
  },
  {
    label: "dynamic content display",
    test: (html) =>
      hasStructuredMacro(html, ["contentbylabel", "recentlyupdated"]),
  },
];

/**
 * @param storageHtml - The Confluence storage HTML to analyze
 * @returns Array of unsupported feature names found in the document
 */
export function detectUnsupportedFeatures(storageHtml: string): string[] {
  const html = storageHtml || "";
  return CHECKS.filter((check) => check.test(html)).map((check) => check.label);
}
