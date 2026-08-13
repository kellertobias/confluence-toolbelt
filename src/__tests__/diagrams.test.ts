import { describe, expect, it } from "vitest";

import {
  findExcalidrawEmbeds,
  isExcalidrawTarget,
  pruneDiagramMap,
  renderedNameFor,
  restoreExcalidrawEmbeds,
  rewriteExcalidrawEmbeds,
  sourceNameFor,
} from "../core/dialect/diagrams.js";

describe("excalidraw target detection", () => {
  it("recognises both embed spellings", () => {
    expect(isExcalidrawTarget("Vault Structure.excalidraw")).toBe(true);
    expect(isExcalidrawTarget("Vault Structure.excalidraw.md")).toBe(true);
  });

  it("leaves ordinary embeds alone", () => {
    expect(isExcalidrawTarget("screenshot.png")).toBe(false);
    expect(isExcalidrawTarget("Some Note")).toBe(false);
    // Substring, not a suffix — must not match.
    expect(isExcalidrawTarget("excalidraw-notes.md")).toBe(false);
  });
});

describe("attachment naming", () => {
  it("drops the .excalidraw suffix so the render reads as an image", () => {
    expect(renderedNameFor("Vault Structure.excalidraw")).toBe(
      "Vault Structure.png",
    );
    expect(renderedNameFor("Vault Structure.excalidraw.md")).toBe(
      "Vault Structure.png",
    );
  });

  it("keeps the source importable into another vault", () => {
    expect(sourceNameFor("Vault Structure.excalidraw")).toBe(
      "Vault Structure.excalidraw.md",
    );
    expect(sourceNameFor("Vault Structure.excalidraw.md")).toBe(
      "Vault Structure.excalidraw.md",
    );
  });
});

describe("finding embeds", () => {
  it("collects distinct excalidraw targets and ignores other embeds", () => {
    const md = [
      "# Page",
      "![[Architecture.excalidraw]]",
      "![[photo.png]]",
      "![[Architecture.excalidraw]]",
      "![[Flow.excalidraw|400]]",
      "[[Not An Embed.excalidraw]]",
    ].join("\n");
    expect(findExcalidrawEmbeds(md)).toEqual([
      "Architecture.excalidraw",
      "Flow.excalidraw",
    ]);
  });
});

describe("round-trip", () => {
  it("upload rewrite followed by download restore is the identity", () => {
    const original = [
      "# Design",
      "",
      "![[Architecture.excalidraw]]",
      "",
      "Some prose, and an ordinary image: ![[diagram.png]]",
      "",
      "![[Flow.excalidraw|400]]",
    ].join("\n");

    const diagrams: Record<string, string> = {};
    const rendered = new Map([
      ["Architecture.excalidraw", "Architecture.png"],
      ["Flow.excalidraw", "Flow.png"],
    ]);

    const uploaded = rewriteExcalidrawEmbeds(original, rendered, diagrams);

    // What Confluence sees: plain image attachments.
    expect(uploaded).toContain("![[Architecture.png]]");
    expect(uploaded).toContain("![[Flow.png|400]]"); // size hint preserved
    expect(uploaded).not.toContain(".excalidraw");
    // The unrelated image is untouched.
    expect(uploaded).toContain("![[diagram.png]]");

    expect(diagrams).toEqual({
      "Architecture.png": "Architecture.excalidraw",
      "Flow.png": "Flow.excalidraw",
    });

    expect(restoreExcalidrawEmbeds(uploaded, diagrams)).toBe(original);
  });

  it("survives repeated cycles without drifting", () => {
    const original = "![[Architecture.excalidraw]]";
    const diagrams: Record<string, string> = {};
    const rendered = new Map([
      ["Architecture.excalidraw", "Architecture.png"],
    ]);

    let doc = original;
    for (let i = 0; i < 5; i++) {
      doc = restoreExcalidrawEmbeds(
        rewriteExcalidrawEmbeds(doc, rendered, diagrams),
        diagrams,
      );
    }
    expect(doc).toBe(original);
  });

  it("does not rewrite a drawing that could not be rendered", () => {
    const md = "![[Architecture.excalidraw]]\n![[Flow.excalidraw]]";
    const diagrams: Record<string, string> = {};
    // Only one of the two rendered.
    const rendered = new Map([["Flow.excalidraw", "Flow.png"]]);

    const out = rewriteExcalidrawEmbeds(md, rendered, diagrams);
    expect(out).toContain("![[Architecture.excalidraw]]");
    expect(out).toContain("![[Flow.png]]");
    expect(diagrams).toEqual({ "Flow.png": "Flow.excalidraw" });
  });
});

describe("restore in a vault that never uploaded the page", () => {
  it("leaves the rendered image in place when there is no mapping", () => {
    // A colleague downloading our published page: no sidecar entry, so the
    // note must keep pointing at the PNG it can actually render.
    const md = "![[Architecture.png]]";
    expect(restoreExcalidrawEmbeds(md, undefined)).toBe(md);
    expect(restoreExcalidrawEmbeds(md, {})).toBe(md);
    expect(restoreExcalidrawEmbeds(md, { "Other.png": "Other.excalidraw" })).toBe(
      md,
    );
  });
});

describe("pruning", () => {
  it("drops entries whose drawing is no longer embedded", () => {
    const md = "![[Kept.excalidraw]]";
    const pruned = pruneDiagramMap(md, {
      "Kept.png": "Kept.excalidraw",
      "Removed.png": "Removed.excalidraw",
    });
    expect(pruned).toEqual({ "Kept.png": "Kept.excalidraw" });
  });
});
