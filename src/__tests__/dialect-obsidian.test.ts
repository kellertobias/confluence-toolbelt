import { describe, expect, it } from "vitest";

import {
  canonicalToObsidian,
  obsidianToCanonical,
  parseObsidianComments,
  type ObsidianSidecar,
} from "../core/dialect/obsidian.js";
import {
  emitFrontmatter,
  parseFrontmatter,
} from "../core/dialect/frontmatter.js";

/** Deterministic nanoID generator for tests. */
function counter(prefix = "id") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

const DL_OPTS = (genId: () => string) => ({
  version: 42,
  downloadedAt: "2026-06-30T00:00:00.000Z",
  genId,
});

describe("frontmatter", () => {
  it("round-trips flat scalar props", () => {
    const props = {
      spaceId: "123",
      pageId: "456",
      title: "Hello: World #1",
      status: "green:In Progress",
      confluenceVersion: 42,
    };
    const out = parseFrontmatter(emitFrontmatter(props)).props;
    expect(out).toEqual(props);
  });

  it("returns body untouched when no frontmatter", () => {
    const md = "# Heading\n\nBody";
    expect(parseFrontmatter(md)).toEqual({ props: {}, body: md });
  });
});

describe("canonicalToObsidian / obsidianToCanonical", () => {
  it("maps the header to properties and back", () => {
    const canonical = [
      "<!--",
      "spaceId: 123",
      "pageId: 456",
      "title: My Page",
      "status: green:In Progress",
      "-->",
      "",
      "# Heading",
    ].join("\n");

    const { markdown, sidecar } = canonicalToObsidian(
      canonical,
      DL_OPTS(counter()),
    );
    expect(markdown).toContain("---");
    expect(markdown).toContain('pageId: "456"');
    expect(markdown).toContain("confluenceVersion: 42");
    expect(markdown).toContain("# Heading");
    expect(sidecar.pageId).toBe("456");
    expect(sidecar.version).toBe(42);

    const back = obsidianToCanonical(markdown, sidecar);
    expect(back).toContain("pageId: 456");
    expect(back).toContain("# Heading");
  });

  it("maps known panels to callouts and back losslessly", () => {
    const body = "> <!-- panel:info:info -->\n> Heads up\n> Second line";
    const out = panelRoundTrip(body);
    expect(out.obsidian).toContain("> [!info]");
    expect(out.obsidian).toContain("> Heads up");
    expect(out.canonical).toContain("> <!-- panel:info:info -->");
    expect(out.canonical).toContain("> Heads up");
  });

  it("preserves custom panel color via hidden marker", () => {
    const body = "> <!-- panel:#eebbcc:info -->\n> Custom";
    const out = panelRoundTrip(body);
    expect(out.obsidian).toContain("%%cf:#eebbcc:info%%");
    expect(out.canonical).toContain("> <!-- panel:#eebbcc:info -->");
  });

  it("converts a single-author inline comment to %% format and back", () => {
    const body =
      "Intro <!-- comment:uuid-1 --><!-- # Keller, Tobias: Looks good -->the text<!-- commend-end:uuid-1 --> outro";
    const canonical = withHeader(body);

    const { markdown, sidecar } = canonicalToObsidian(
      canonical,
      DL_OPTS(counter()),
    );
    expect(markdown).toContain(
      "%%= Keller, Tobias /id1: Looks good =%%the text%%= /id1 =%%",
    );
    expect(sidecar.comments.id1).toEqual({
      uuid: "uuid-1",
      author: "Keller, Tobias",
      body: "Looks good",
    });

    const back = obsidianToCanonical(markdown, sidecar);
    expect(back).toContain(
      "<!-- comment:uuid-1 --><!-- # Keller, Tobias: Looks good -->the text<!-- commend-end:uuid-1 -->",
    );
  });

  it("handles a multi-reply thread with ;; separator", () => {
    const body =
      "x <!-- comment:U --><!-- # Götze, Andreas: This is my comment --><!-- # Keller, Tobias: Yes this is true -->anchored<!-- commend-end:U --> y";
    const canonical = withHeader(body);

    const genId = counter();
    const { markdown, sidecar } = canonicalToObsidian(canonical, DL_OPTS(genId));
    expect(markdown).toContain(
      "%%= Götze, Andreas /id1: This is my comment ;; Keller, Tobias /id2: Yes this is true =%%anchored%%= /id1 /id2 =%%",
    );
    expect(sidecar.comments.id1?.uuid).toBe("U");
    expect(sidecar.comments.id2?.uuid).toBe("U");

    const back = obsidianToCanonical(markdown, sidecar);
    expect(back).toContain(
      "<!-- comment:U --><!-- # Götze, Andreas: This is my comment --><!-- # Keller, Tobias: Yes this is true -->anchored<!-- commend-end:U -->",
    );
  });

  it("strips node tags from the body but keeps them in the sidecar base", () => {
    const body = "<!-- node:n1 -->\n# Heading\n\n<!-- node:n2 -->\nParagraph";
    const canonical = withHeader(body);
    const { markdown, sidecar } = canonicalToObsidian(
      canonical,
      DL_OPTS(counter()),
    );
    expect(markdown).not.toContain("node:n1");
    expect(sidecar.baseMarkdown).toContain("<!-- node:n1 -->");
    expect(sidecar.baseMarkdown).toContain("<!-- node:n2 -->");
  });

  it("full canonical→obsidian→canonical is stable for panels + comments", () => {
    const body = [
      "# Title",
      "",
      "Para with <!-- comment:c1 --><!-- # A: hi -->span<!-- commend-end:c1 --> end.",
      "",
      "> <!-- panel:warning:warning -->",
      "> Careful here",
    ].join("\n");
    const canonical = withHeader(body);

    const { markdown, sidecar } = canonicalToObsidian(
      canonical,
      DL_OPTS(counter()),
    );
    const back = obsidianToCanonical(markdown, sidecar);
    // Re-run the forward direction; output must be identical (idempotent).
    const again = canonicalToObsidian(back, DL_OPTS(counter())).markdown;
    expect(again).toBe(markdown);
  });
});

describe("parseObsidianComments (reading-view parser)", () => {
  it("extracts anchor, ids, and per-author threads", () => {
    const md =
      "x %%= Götze, Andreas /abc: hi ;; Keller, Tobias /def: yes =%%the span%%= /abc /def =%% y";
    const [c] = parseObsidianComments(md);
    expect(c?.anchor).toBe("the span");
    expect(c?.ids).toEqual(["abc", "def"]);
    expect(c?.threads).toEqual([
      { author: "Götze, Andreas", id: "abc", body: "hi" },
      { author: "Keller, Tobias", id: "def", body: "yes" },
    ]);
  });

  it("still parses the legacy # sigil for older notes", () => {
    const [c] = parseObsidianComments("%% Author #xyz: hi %%span%% /xyz %%");
    expect(c?.threads[0]).toEqual({ author: "Author", id: "xyz", body: "hi" });
  });

  it("returns nothing for text without comments", () => {
    expect(parseObsidianComments("just a paragraph")).toEqual([]);
  });
});

// --- helpers ---------------------------------------------------------------

function withHeader(body: string): string {
  return ["<!--", "pageId: 456", "title: T", "-->", "", body].join("\n");
}

function panelRoundTrip(body: string): {
  obsidian: string;
  canonical: string;
} {
  const canonical = withHeader(body);
  const { markdown, sidecar } = canonicalToObsidian(canonical, DL_OPTS(counter()));
  const back = obsidianToCanonical(markdown, sidecar);
  return { obsidian: markdown, canonical: back };
}
