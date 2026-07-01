import { describe, expect, it } from "vitest";

import { computeLineChanges } from "../core/diff/line-changes.js";

describe("computeLineChanges", () => {
  it("reports no changes for identical text", () => {
    const r = computeLineChanges("a\nb\nc", "a\nb\nc");
    expect(r.byLine.size).toBe(0);
    expect(r.removedBefore.size).toBe(0);
    expect(r.removedAtEnd).toBe(false);
  });

  it("ignores a trailing-newline-only difference", () => {
    const r = computeLineChanges("a\nb", "a\nb\n");
    expect(r.byLine.size).toBe(0);
    expect(r.removedBefore.size).toBe(0);
    expect(r.removedAtEnd).toBe(false);
  });

  it("marks an inserted line as added", () => {
    const r = computeLineChanges("a\nc", "a\nb\nc");
    expect(r.byLine.get(1)).toBe("added");
    expect(r.byLine.size).toBe(1);
    expect(r.removedAtEnd).toBe(false);
  });

  it("marks a replaced line as changed", () => {
    const r = computeLineChanges("a\nx\nc", "a\nb\nc");
    expect(r.byLine.get(1)).toBe("changed");
    expect(r.byLine.size).toBe(1);
    expect(r.removedBefore.size).toBe(0);
  });

  it("records a deletion gap above the following line", () => {
    const r = computeLineChanges("a\nb\nc", "a\nc");
    expect(r.byLine.size).toBe(0);
    expect(r.removedBefore.has(1)).toBe(true);
    expect(r.removedAtEnd).toBe(false);
  });

  it("flags a deletion at the end of the document", () => {
    const r = computeLineChanges("a\nb\nc", "a\nb");
    expect(r.removedAtEnd).toBe(true);
    expect(r.removedBefore.size).toBe(0);
  });

  it("handles a multi-line edit with both inserts and a deletion", () => {
    // base: a b c d ; current: a B C (b,c→B,C edited and d removed)
    const r = computeLineChanges("a\nb\nc\nd", "a\nB\nC");
    expect(r.byLine.get(1)).toBe("changed");
    expect(r.byLine.get(2)).toBe("changed");
    expect(r.removedAtEnd).toBe(true);
  });

  it("everything added when base is empty", () => {
    const r = computeLineChanges("", "a\nb");
    expect(r.byLine.get(0)).toBe("added");
    expect(r.byLine.get(1)).toBe("added");
  });
});
