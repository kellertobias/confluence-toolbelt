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
    expect(obsidian).toContain("> [!warning]\n> **Scope** of this document");
  });

  it("keeps a preserved color alongside the title", () => {
    const { obsidian, canonical } = panelRoundTrip(
      ["> <!-- panel:#eae6ff:panel -->", "> **Heads up**", ">", "> Body."].join("\n"),
    );
    // An unmapped colour falls back to the neutral callout, and the exact
    // colour rides along in the marker.
    expect(obsidian).toContain("> [!note] %%cf:#eae6ff:panel%% Heads up");
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

describe("panel colour mapping", () => {
  const down = (panel: string): string =>
    panelRoundTrip([`> <!-- panel:${panel}:${panel} -->`, "> Body."].join("\n"))
      .obsidian;
  const up = (callout: string): string =>
    obsidianToCanonical(
      ["---", 'pageId: "1"', "---", "", `> [!${callout}] T`, "> Body."].join("\n"),
      { comments: {} },
    );

  it("maps Confluence panels onto the callout of the same colour", () => {
    expect(down("info")).toContain("> [!info]"); // blue
    expect(down("note")).toContain("> [!warning]"); // yellow
    expect(down("success")).toContain("> [!tip]"); // green
    expect(down("error")).toContain("> [!danger]"); // red
    expect(down("warning")).toContain("> [!danger]"); // red (legacy macro)
    expect(down("panel")).toContain("> [!note]"); // plain
  });

  it("maps callouts back onto the panel of the same colour", () => {
    expect(up("info")).toContain("panel:info:info");
    expect(up("warning")).toContain("panel:note:note");
    // Green and red go to the panel types the upload can actually store:
    // `success`/`error` are ADF-only and have no macro behind them.
    expect(up("tip")).toContain("panel:tip:tip");
    expect(up("danger")).toContain("panel:warning:warning");
    expect(up("note")).toContain("panel:panel:panel");
  });

  it("accepts Obsidian's aliases for each type", () => {
    for (const t of ["caution", "attention", "question", "help", "faq"])
      expect(up(t)).toContain("panel:note:note");
    for (const t of ["hint", "important", "success", "check", "done"])
      expect(up(t)).toContain("panel:success:success");
    for (const t of ["error", "failure", "fail", "missing", "bug"])
      expect(up(t)).toContain("panel:error:error");
  });

  it("round-trips the types that map one-to-one without a marker", () => {
    for (const p of ["info", "note", "tip", "warning", "panel"]) {
      const { obsidian, canonical } = panelRoundTrip(
        [`> <!-- panel:${p}:${p} -->`, "> Body."].join("\n"),
      );
      expect(obsidian).not.toContain("%%cf:");
      expect(canonical).toContain(`> <!-- panel:${p}:${p} -->`);
    }
  });

  it("preserves the types that collide, rather than changing their colour", () => {
    // Both `tip` and `success` come down as [!tip], and both `warning` and
    // `error` as [!danger] — so one of each pair carries a marker to stay
    // itself. It is the ADF-only name that carries it: a page that has been
    // uploaded once holds `tip`/`warning`, and those stay marker-free.
    for (const p of ["success", "error"]) {
      const { obsidian, canonical } = panelRoundTrip(
        [`> <!-- panel:${p}:${p} -->`, "> Body."].join("\n"),
      );
      expect(obsidian).toContain(`%%cf:${p}:${p}%%`);
      expect(canonical).toContain(`> <!-- panel:${p}:${p} -->`);
    }
  });

  it("falls back to a neutral panel for an unknown callout type", () => {
    expect(up("quote")).toContain("panel:panel:panel");
  });
});

describe("expand sections", () => {
  it("becomes a collapsed callout carrying the title", () => {
    const { obsidian } = panelRoundTrip(
      ["<!-- expand:How we measured this -->", "", "Hidden prose.", "", "<!-- /expand -->"].join(
        "\n",
      ),
    );
    // `-` is Obsidian's "starts collapsed" marker, which is how Confluence
    // renders an expand too.
    expect(obsidian).toContain("> [!expand]- How we measured this");
    expect(obsidian).toContain("> Hidden prose.");
    expect(obsidian).not.toContain("<!-- expand");
  });

  it("round-trips back to the canonical delimiters unchanged", () => {
    const body = [
      "<!-- expand:Details -->",
      "",
      "Hidden prose.",
      "",
      "<!-- /expand -->",
    ].join("\n");
    expect(panelRoundTrip(body).canonical).toContain(body);
  });

  it("supports a title-less expand", () => {
    const { obsidian, canonical } = panelRoundTrip(
      ["<!-- expand -->", "", "Body.", "", "<!-- /expand -->"].join("\n"),
    );
    expect(obsidian).toContain("> [!expand]-\n");
    expect(canonical).toContain("<!-- expand -->");
    expect(canonical).not.toContain("<!-- expand: -->");
  });

  it("keeps a table inside the section intact", () => {
    const { obsidian, canonical } = panelRoundTrip(
      [
        "<!-- expand:Numbers -->",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "<!-- /expand -->",
      ].join("\n"),
    );
    // Quoted one level, so Obsidian still renders it as a table — not
    // flattened into the preamble.
    expect(obsidian).toContain("> | a | b |");
    expect(canonical).toContain("| a | b |");
    expect(canonical).not.toContain("> | a | b |");
  });

  it("nests an expand inside an expand", () => {
    const { obsidian, canonical } = panelRoundTrip(
      [
        "<!-- expand:Outer -->",
        "",
        "<!-- expand:Inner -->",
        "",
        "Deep.",
        "",
        "<!-- /expand -->",
        "",
        "<!-- /expand -->",
      ].join("\n"),
    );
    expect(obsidian).toContain("> [!expand]- Outer");
    expect(obsidian).toContain("> > [!expand]- Inner");
    expect(obsidian).toContain("> > Deep.");
    expect(canonical).toContain("<!-- expand:Inner -->");
    // The inner close must not have ended the outer section.
    expect(canonical.match(/<!-- \/expand -->/g)).toHaveLength(2);
  });

  it("turns a panel inside an expand into a nested callout", () => {
    const { obsidian, canonical } = panelRoundTrip(
      [
        "<!-- expand:Notes -->",
        "",
        "> <!-- panel:info:info -->",
        "> Careful.",
        "",
        "<!-- /expand -->",
      ].join("\n"),
    );
    expect(obsidian).toContain("> > [!info]");
    expect(obsidian).toContain("> > Careful.");
    expect(canonical).toContain("> <!-- panel:info:info -->");
  });

  it("leaves an unterminated delimiter alone", () => {
    // Matching the upload path, which falls through to ordinary paragraph
    // handling rather than swallowing the rest of the document.
    const { obsidian } = panelRoundTrip(
      ["<!-- expand:Oops -->", "", "Loose prose."].join("\n"),
    );
    expect(obsidian).toContain("<!-- expand:Oops -->");
    expect(obsidian).not.toContain("[!expand]");
  });

  it("accepts a section the user expanded by hand", () => {
    const canonical = obsidianToCanonical(
      ["---", 'pageId: "1"', "---", "", "> [!expand]+ Details", "> Body."].join("\n"),
      { comments: {} },
    );
    expect(canonical).toContain("<!-- expand:Details -->");
    expect(canonical).toContain("Body.");
  });

  it("does not mistake an expand callout for a panel", () => {
    const canonical = obsidianToCanonical(
      ["---", 'pageId: "1"', "---", "", "> [!expand]- Details", "> Body."].join("\n"),
      { comments: {} },
    );
    expect(canonical).not.toContain("panel:");
  });

  it("keeps a folded panel's title free of the fold marker", () => {
    // `> [!info]- Examples` used to upload as a panel titled "- Examples".
    const canonical = obsidianToCanonical(
      ["---", 'pageId: "1"', "---", "", "> [!info]- Examples", "> Body."].join("\n"),
      { comments: {} },
    );
    expect(canonical).toContain("> **Examples**");
    expect(canonical).not.toContain("**- Examples**");
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
