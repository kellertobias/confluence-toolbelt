import { describe, expect, it } from "vitest";

import {
  canonicalImagesToEmbeds,
  canonicalLinksToWiki,
  embedsToCanonicalImages,
  mdNoteLinksToCanonical,
  wikiLinksToCanonical,
} from "../core/dialect/links.js";

describe("page link translation", () => {
  const idToNote: Record<string, string> = { "123": "Other Page" };
  const noteToId: Record<string, string> = { "Other Page": "123" };

  it("canonical pageid link → wikilink and back", () => {
    const canon = "See [the other page](pageid:123) for details.";
    const wiki = canonicalLinksToWiki(canon, (id) => idToNote[id] ?? null);
    expect(wiki).toBe("See [[Other Page|the other page]] for details.");

    const back = wikiLinksToCanonical(wiki, (n) => noteToId[n] ?? null);
    expect(back).toBe("See [the other page](pageid:123) for details.");
  });

  it("collapses [[Note|Note]] to [[Note]] when text equals the note name", () => {
    const canon = "[Other Page](pageid:123)";
    expect(canonicalLinksToWiki(canon, (id) => idToNote[id] ?? null)).toBe(
      "[[Other Page]]",
    );
  });

  it("handles space-prefixed pageid links", () => {
    const canon = "[x](pageid:SPACE:123)";
    expect(canonicalLinksToWiki(canon, (id) => idToNote[id] ?? null)).toBe(
      "[[Other Page|x]]",
    );
  });

  it("leaves links untouched when the target is not in the vault / not a page", () => {
    expect(
      canonicalLinksToWiki("[x](pageid:999)", () => null),
    ).toBe("[x](pageid:999)");
    expect(wikiLinksToCanonical("[[Local Note]]", () => null)).toBe(
      "[[Local Note]]",
    );
  });
});

describe("image embed translation", () => {
  it("canonical attachment ref → embed and back, preserving caption", () => {
    const images: Record<string, string> = {};
    const canon = "![A diagram](#diagram.png)";
    const embed = canonicalImagesToEmbeds(canon, images);
    expect(embed).toBe("![[diagram.png]]");
    expect(images["diagram.png"]).toBe("A diagram");

    const back = embedsToCanonicalImages(embed, images);
    expect(back).toBe("![A diagram](#diagram.png)");
  });

  it("keeps a display hint out of the attachment name", () => {
    // `![[X.png|100%]]` naming attachment "X.png|100%" matches nothing on the
    // page — Confluence renders it as "Preview unavailable".
    const sizes: Record<string, string> = {};
    expect(embedsToCanonicalImages("![[diagram.png|100%]]", {}, sizes)).toBe(
      "![](#diagram.png)",
    );
    expect(sizes["diagram.png"]).toBe("100%");
  });

  it("restores the display hint on the way back", () => {
    const sizes: Record<string, string> = {};
    const embed = "![[diagram.png|400]]";
    const canon = embedsToCanonicalImages(embed, {}, sizes);
    expect(canonicalImagesToEmbeds(canon, {}, sizes)).toBe(embed);
  });

  it("drops a hint that is no longer in the note", () => {
    const sizes: Record<string, string> = { "diagram.png": "100%" };
    embedsToCanonicalImages("![[diagram.png]]", {}, sizes);
    expect(sizes["diagram.png"]).toBeUndefined();
  });

  it("carries caption and hint together", () => {
    const images: Record<string, string> = { "diagram.png": "A diagram" };
    const sizes: Record<string, string> = {};
    expect(embedsToCanonicalImages("![[diagram.png|50%]]", images, sizes)).toBe(
      "![A diagram](#diagram.png)",
    );
    expect(
      canonicalImagesToEmbeds("![A diagram](#diagram.png)", images, sizes),
    ).toBe("![[diagram.png|50%]]");
  });

  it("does not treat image embeds as page wikilinks", () => {
    expect(wikiLinksToCanonical("![[pic.png]]", () => "999")).toBe(
      "![[pic.png]]",
    );
  });
});

describe("markdown links to vault notes", () => {
  const resolve = (n: string) => (n === "Design Rules" ? "999" : null);

  it("translates a .md link into a page link", () => {
    expect(mdNoteLinksToCanonical("see [the rules](Design Rules.md)", resolve)).toBe(
      "see [the rules](pageid:999)",
    );
  });

  it("decodes a percent-escaped filename", () => {
    // What Obsidian writes for a title with spaces — it used to publish as a
    // relative path to a file Confluence does not have.
    expect(
      mdNoteLinksToCanonical("[x](Design%20Rules.md)", resolve),
    ).toBe("[x](pageid:999)");
  });

  it("resolves a note inside a folder by its basename", () => {
    expect(
      mdNoteLinksToCanonical("[x](Corporate/Projects/Design Rules.md)", resolve),
    ).toBe("[x](pageid:999)");
  });

  it("leaves a note that is not a Confluence page alone", () => {
    const md = "[x](Some Local Note.md)";
    expect(mdNoteLinksToCanonical(md, resolve)).toBe(md);
  });

  it("leaves external links, fragments and images alone", () => {
    for (const md of [
      "[x](https://example.com/Design Rules.md)",
      "[x](#sources)",
      "[x](pageid:123)",
      "![x](Design Rules.md)",
      "[x](diagram.png)",
    ]) {
      expect(mdNoteLinksToCanonical(md, resolve)).toBe(md);
    }
  });
});
