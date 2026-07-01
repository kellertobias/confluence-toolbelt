import { describe, expect, it } from "vitest";

import {
  canonicalImagesToEmbeds,
  canonicalLinksToWiki,
  embedsToCanonicalImages,
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

  it("does not treat image embeds as page wikilinks", () => {
    expect(wikiLinksToCanonical("![[pic.png]]", () => "999")).toBe(
      "![[pic.png]]",
    );
  });
});
