/**
 * The download path must only warn about overwriting when the note actually
 * holds edits that aren't in Confluence. A page that merely moved on remotely
 * should refresh silently.
 */

import { describe, expect, it } from "vitest";

import { hasLocalChanges } from "../core/pipeline/local-changes.js";

const BODY = "# Page\n\nSome text.\n";
const note = (body: string, downloadedAt?: string) =>
  [
    "---",
    'pageId: "123"',
    "title: Page",
    ...(downloadedAt ? [`confluenceDownloadedAt: ${downloadedAt}`] : []),
    "---",
    "",
  ].join("\n") + body;

describe("hasLocalChanges", () => {
  it("is false when the note matches the synced base", () => {
    expect(hasLocalChanges({ content: note(BODY), base: BODY })).toBe(false);
  });

  it("ignores line-ending and trailing-newline noise", () => {
    expect(
      hasLocalChanges({
        content: note(BODY.replace(/\n/g, "\r\n") + "\n\n"),
        base: BODY,
      }),
    ).toBe(false);
  });

  it("is true when the body was edited", () => {
    expect(
      hasLocalChanges({ content: note(BODY + "\nMy own note.\n"), base: BODY }),
    ).toBe(true);
  });

  it("ignores frontmatter churn — only the body counts", () => {
    const withVersion =
      ["---", 'pageId: "123"', "confluenceVersion: 99", "---", ""].join("\n") +
      BODY;
    expect(hasLocalChanges({ content: withVersion, base: BODY })).toBe(false);
  });

  it("is false when there is no note to overwrite", () => {
    expect(hasLocalChanges({ content: null })).toBe(false);
  });

  describe("without a recorded base", () => {
    const AT = "2026-08-11T12:00:00.000Z";

    it("uses the caller's fallback when one is given", () => {
      expect(hasLocalChanges({ content: note(BODY), fallback: false })).toBe(
        false,
      );
      expect(hasLocalChanges({ content: note(BODY), fallback: true })).toBe(
        true,
      );
    });

    it("treats the download's own write as untouched", () => {
      expect(
        hasLocalChanges({
          content: note(BODY, AT),
          mtime: Date.parse(AT) + 2_000,
        }),
      ).toBe(false);
    });

    it("treats a later write as a local edit", () => {
      expect(
        hasLocalChanges({
          content: note(BODY, AT),
          mtime: Date.parse(AT) + 3_600_000,
        }),
      ).toBe(true);
    });

    it("assumes changes when there is no baseline at all", () => {
      expect(hasLocalChanges({ content: note(BODY), mtime: 123 })).toBe(true);
    });
  });
});
