/**
 * The three-way merge base must be recorded the way the merge reads the remote.
 *
 * Regression: the base was stored as the canonical markdown we had *sent*, but
 * the merge compares against blocks derived from the storage Confluence *hands
 * back*. Those two forms differ — re-parsing markdown re-splits any block
 * holding a blank line and normalizes whitespace — so once Confluence bumped
 * the version for any reason (its own re-save, an attachment upload), a merge
 * ran, saw nearly every block as remotely changed, and conflicted on anything
 * the user had also edited.
 */

import { describe, expect, it } from "vitest";

import {
  remoteMergeBase,
  sameAsBase,
  threeWayMerge,
} from "../core/pipeline/three-way.js";
import { assembleCanonicalBody } from "../core/pipeline/storage-to-canonical.js";

/** Storage exercising the shapes that survive the round-trip badly: a panel
 * with an internal blank line, a list, and a code block. */
const STORAGE = [
  "<h1>Title</h1>",
  "<p>Intro paragraph.</p>",
  '<ac:structured-macro ac:name="info"><ac:rich-text-body>',
  "<p><strong>Example</strong></p>",
  "<p>could return:</p>",
  '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter>',
  "<ac:plain-text-body><![CDATA[{\n  \"a\": 1\n}]]></ac:plain-text-body>",
  "</ac:structured-macro>",
  "</ac:rich-text-body></ac:structured-macro>",
  "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
  "<p>Closing paragraph.</p>",
].join("");

describe("remoteMergeBase", () => {
  it("is stable: the same storage yields the same base", () => {
    expect(sameAsBase(remoteMergeBase(STORAGE), remoteMergeBase(STORAGE))).toBe(
      true,
    );
  });

  it("notices a real remote edit", () => {
    const changed = STORAGE.replace("Closing paragraph.", "Rewritten by Bob.");
    expect(sameAsBase(remoteMergeBase(STORAGE), remoteMergeBase(changed))).toBe(
      false,
    );
  });

});

describe("threeWayMerge with a block base", () => {
  const localWithEdit = () => {
    const body = assembleCanonicalBody(STORAGE, []);
    return body.replace("Intro paragraph.", "Intro paragraph, edited locally.");
  };

  it("keeps a local edit and reports no conflict when the remote is unchanged", () => {
    const merged = threeWayMerge({
      baseBlocks: remoteMergeBase(STORAGE),
      baseBody: null,
      localBody: localWithEdit(),
      remoteStorageHtml: STORAGE,
      remoteComments: [],
    });
    expect(merged.hasConflicts).toBe(false);
    expect(merged.body).toContain("Intro paragraph, edited locally.");
  });

  it("still merges when the remote genuinely moved elsewhere", () => {
    const remote = STORAGE.replace(
      "Closing paragraph.",
      "Closing paragraph, edited remotely.",
    );
    const merged = threeWayMerge({
      baseBlocks: remoteMergeBase(STORAGE),
      baseBody: null,
      localBody: localWithEdit(),
      remoteStorageHtml: remote,
      remoteComments: [],
    });
    expect(merged.hasConflicts).toBe(false);
    expect(merged.body).toContain("Intro paragraph, edited locally.");
    expect(merged.body).toContain("Closing paragraph, edited remotely.");
  });

  it("falls back to the markdown base when no block base was recorded", () => {
    const merged = threeWayMerge({
      baseBody: assembleCanonicalBody(STORAGE, []),
      localBody: localWithEdit(),
      remoteStorageHtml: STORAGE,
      remoteComments: [],
    });
    expect(merged.body).toContain("Intro paragraph, edited locally.");
  });
});
