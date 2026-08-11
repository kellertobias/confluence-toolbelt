import { describe, expect, it } from "vitest";

import {
  canonicalToObsidian,
  findStatusLozenges,
  formatStatusLozenge,
  obsidianToCanonical,
  parseObsidianComments,
  STATUS_COLORS,
  statusLozengeAt,
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

describe("status lozenges", () => {
  it("renders a status macro as a visible inline badge", () => {
    const { obsidian } = panelRoundTrip("Ship <!-- status:yellow:MVP --> soon");
    expect(obsidian).toContain('<span class="badge-yellow">MVP</span>');
    expect(obsidian).not.toContain("<!-- status:");
  });

  it("round-trips back to the canonical status comment", () => {
    const { canonical } = panelRoundTrip(
      "Ship <!-- status:yellow:MVP --> then <!-- status:green:FULL -->",
    );
    expect(canonical).toContain("<!-- status:yellow:MVP -->");
    expect(canonical).toContain("<!-- status:green:FULL -->");
    expect(canonical).not.toContain("badge-");
  });

  it("converts statuses inside callouts and headings too", () => {
    const { obsidian, canonical } = panelRoundTrip(
      [
        "## Paths <!-- status:yellow:MVP -->",
        "",
        "> <!-- panel:info:info --> see <!-- status:red:WRITES -->",
      ].join("\n"),
    );
    expect(obsidian).toContain(
      '## Paths <span class="badge-yellow">MVP</span>',
    );
    expect(obsidian).toContain('<span class="badge-red">WRITES</span>');
    expect(canonical).toContain("<!-- status:yellow:MVP -->");
    expect(canonical).toContain("<!-- status:red:WRITES -->");
  });

  it("leaves an unrecognized color as a comment rather than losing it", () => {
    const { obsidian, canonical } = panelRoundTrip("x <!-- status:#ff0000:Hot -->");
    expect(obsidian).toContain("<!-- status:#ff0000:Hot -->");
    expect(canonical).toContain("<!-- status:#ff0000:Hot -->");
  });
});

describe("status authoring helpers", () => {
  it("formats a lozenge that the dialect can read back", () => {
    const html = formatStatusLozenge("Yellow", "  MVP  ");
    expect(html).toBe('<span class="badge-yellow">MVP</span>');
    expect(findStatusLozenges(html)).toEqual([
      { color: "yellow", title: "MVP", start: 0, end: html.length },
    ]);
  });

  it("falls back to grey for a color it cannot render", () => {
    expect(formatStatusLozenge("#ff0000", "Hot")).toBe(
      '<span class="badge-grey">Hot</span>',
    );
  });

  it("escapes markup in the title and restores it when reading", () => {
    const html = formatStatusLozenge("red", "a <b> & c");
    expect(html).not.toContain("<b>");
    expect(findStatusLozenges(html)[0]?.title).toBe("a <b> & c");
  });

  it("every offered color survives a full round-trip", () => {
    for (const color of STATUS_COLORS) {
      const { canonical } = panelRoundTrip(`x ${formatStatusLozenge(color, "L")}`);
      expect(canonical).toContain(`<!-- status:${color}:L -->`);
    }
  });

  it("finds lozenges in source order", () => {
    const line = `a ${formatStatusLozenge("red", "R")} b ${formatStatusLozenge("green", "G")}`;
    expect(findStatusLozenges(line).map((s) => s.title)).toEqual(["R", "G"]);
  });

  it("locates the lozenge under the cursor, edges included", () => {
    const chip = formatStatusLozenge("yellow", "MVP");
    const line = `Ship ${chip} soon`;
    const start = line.indexOf(chip);
    expect(statusLozengeAt(line, start)?.title).toBe("MVP");
    expect(statusLozengeAt(line, start + 5)?.title).toBe("MVP");
    expect(statusLozengeAt(line, start + chip.length)?.title).toBe("MVP");
    expect(statusLozengeAt(line, 0)).toBeNull();
    expect(statusLozengeAt(line, line.length)).toBeNull();
  });

  it("reports offsets that splice the lozenge out cleanly", () => {
    const line = `Ship ${formatStatusLozenge("yellow", "MVP")} soon`;
    const hit = statusLozengeAt(line, line.indexOf("<span"))!;
    expect(line.slice(0, hit.start) + line.slice(hit.end)).toBe("Ship  soon");
  });
});

describe("widget placeholders", () => {
  it("turns the TOC widget into a visible block", () => {
    const { obsidian } = panelRoundTrip("Intro\n\n<!-- widget:TOC -->\n\nBody");
    expect(obsidian).toContain(
      '<div class="cf-widget" data-widget="TOC">Table of contents</div>',
    );
    expect(obsidian).not.toContain("<!-- widget:");
  });

  it("round-trips back to the canonical widget comment", () => {
    const { canonical } = panelRoundTrip("<!-- widget:TOC -->");
    expect(canonical).toContain("<!-- widget:TOC -->");
    expect(canonical).not.toContain("cf-widget");
  });

  it("labels an unknown widget with its own name", () => {
    const { obsidian, canonical } = panelRoundTrip("<!-- widget:CHART -->");
    expect(obsidian).toContain(
      '<div class="cf-widget" data-widget="CHART">CHART</div>',
    );
    expect(canonical).toContain("<!-- widget:CHART -->");
  });

  it("leaves a widget comment that shares a line with prose alone", () => {
    const { obsidian } = panelRoundTrip("see <!-- widget:TOC --> here");
    expect(obsidian).toContain("<!-- widget:TOC -->");
    expect(obsidian).not.toContain("cf-widget");
  });
});

describe("badge forms the parser tolerates", () => {
  const cases: [string, string][] = [
    ["the form we write", '<span class="badge-yellow">MVP</span>'],
    ["badge element", '<badge color="yellow">MVP</badge>'],
    ["hyphenated tag", "<badge-yellow>MVP</badge-yellow>"],
    ["colon tag", "<badge:yellow>MVP</badge>"],
    ["legacy span", '<span class="cf-lozenge cf-lozenge-yellow">MVP</span>'],
  ];

  for (const [label, form] of cases) {
    it(`reads ${label} back to a status macro`, () => {
      expect(findStatusLozenges(form)[0]).toMatchObject({
        color: "yellow",
        title: "MVP",
      });
      const { canonical } = panelRoundTrip(`Ship ${form} soon`);
      expect(canonical).toContain("<!-- status:yellow:MVP -->");
    });
  }

  it("normalizes every form to the badge we write on the next download", () => {
    const { obsidian } = panelRoundTrip("a <!-- status:red:X --> b");
    expect(obsidian).toContain('<span class="badge-red">X</span>');
  });

  it("keeps two badges on one line separate", () => {
    const line =
      'a <span class="badge-red">R</span> b <span class="badge-green">G</span>';
    expect(findStatusLozenges(line).map((s) => `${s.color}:${s.title}`)).toEqual([
      "red:R",
      "green:G",
    ]);
  });
});

describe("panel titles", () => {
  it("promotes a fully bold first line to the callout title", () => {
    const { obsidian } = panelRoundTrip(
      ["> <!-- panel:info:info -->", "> **Examples**", ">", "> Body text."].join("\n"),
    );
    expect(obsidian).toContain("> [!info] Examples");
    expect(obsidian).toContain("> Body text.");
    expect(obsidian).not.toContain("**Examples**");
  });

  it("does not double the bold markers of an already-bold title", () => {
    // `> [!info] **Examples**` used to become `****Examples****`, which
    // markdown reads as a stray asterisk around italic-bold.
    const canonical = obsidianToCanonical(
      ["---", 'pageId: "1"', "---", "", "> [!info] **Examples**", "> Body."].join("\n"),
      { comments: {} },
    );
    expect(canonical).toContain("> **Examples**");
    expect(canonical).not.toContain("****");
  });

  it("keeps the title in its own paragraph", () => {
    const canonical = obsidianToCanonical(
      ["---", 'pageId: "1"', "---", "", "> [!info] Examples", "> Body."].join("\n"),
      { comments: {} },
    );
    // A blank quote line, so Confluence gets <p>title</p><p>body</p> rather
    // than one run-on paragraph.
    expect(canonical).toContain("> **Examples**\n>\n> Body.");
  });

  it("does not add a second blank line when the body already starts with one", () => {
    const canonical = obsidianToCanonical(
      ["---", 'pageId: "1"', "---", "", "> [!info] Examples", ">", "> Body."].join("\n"),
      { comments: {} },
    );
    expect(canonical).not.toContain(">\n>\n>\n");
  });

  it("writes the title back as a bold first line", () => {
    const { canonical } = panelRoundTrip(
      ["> <!-- panel:info:info -->", "> **Examples**", ">", "> Body text."].join("\n"),
    );
    expect(canonical).toContain(
      ["> <!-- panel:info:info -->", "> **Examples**"].join("\n"),
    );
  });

  it("heals a title an older upload mangled into italic-bold", () => {
    // `****Title****` reached Confluence as italic-bold between literal
    // asterisks, and comes back looking like this.
    const { obsidian } = panelRoundTrip(
      ["> <!-- panel:info:info -->", "> \\****Examples***\\*", ">", "> Body."].join("\n"),
    );
    expect(obsidian).toContain("> [!info] Examples");
    expect(obsidian).not.toContain("*");
  });

  it("does not promote a single-asterisk aside", () => {
    const { obsidian } = panelRoundTrip(
      ["> <!-- panel:info:info -->", "> *just an aside*"].join("\n"),
    );
    expect(obsidian).toContain("> [!info]\n> *just an aside*");
  });

  it("leaves a bold run inside a sentence alone", () => {
    const { obsidian } = panelRoundTrip(
      ["> <!-- panel:info:info -->", "> **Note** this is **important**."].join("\n"),
    );
    expect(obsidian).toContain("> [!info]\n> **Note** this is **important**.");
  });

  it("leaves a first line that is only partly bold alone", () => {
    const { obsidian } = panelRoundTrip(
      ["> <!-- panel:note:note -->", "> **Scope** of this document"].join("\n"),
    );
    expect(obsidian).toContain("> [!note]\n> **Scope** of this document");
  });

  it("keeps a preserved color alongside the title", () => {
    const { obsidian, canonical } = panelRoundTrip(
      ["> <!-- panel:#eae6ff:panel -->", "> **Heads up**", ">", "> Body."].join("\n"),
    );
    expect(obsidian).toContain("> [!info] %%cf:#eae6ff:panel%% Heads up");
    expect(canonical).toContain("> <!-- panel:#eae6ff:panel -->");
    expect(canonical).toContain("> **Heads up**");
  });

  it("does not invent a title for a panel that has none", () => {
    const { obsidian } = panelRoundTrip(
      ["> <!-- panel:info:info -->", "> Just body text."].join("\n"),
    );
    expect(obsidian).toContain("> [!info]\n> Just body text.");
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
