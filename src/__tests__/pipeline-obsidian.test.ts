import { describe, expect, it, vi } from "vitest";

import type { ConfluenceClient } from "../api.js";
import { downloadPageToObsidian } from "../core/pipeline/obsidian-download.js";
import { uploadObsidianPage } from "../core/pipeline/obsidian-upload.js";
import { parsePageId } from "../core/pipeline/sidecar-store.js";

/** Minimal ConfluenceClient stub for pipeline tests. */
function stubClient(
  overrides: Partial<Record<keyof ConfluenceClient, any>>,
): ConfluenceClient {
  const base = {
    getPageStorage: vi.fn(),
    getPageComments: vi.fn(async () => []),
    getPageSpaceKey: vi.fn(async () => undefined),
    updatePageStorage: vi.fn(async () => {}),
  };
  return { ...base, ...overrides } as unknown as ConfluenceClient;
}

function counter() {
  let n = 0;
  return () => `c${++n}`;
}

describe("downloadPageToObsidian", () => {
  it("produces Obsidian markdown with properties + a sidecar base", async () => {
    const client = stubClient({
      getPageStorage: vi.fn(async () => ({
        title: "My Page",
        storageHtml: "<h1>Title</h1><p>Hello world</p>",
        version: 7,
        spaceId: "SP1",
      })),
    });

    const result = await downloadPageToObsidian(client, "12345", {
      genId: counter(),
      now: "2026-06-30T00:00:00.000Z",
    });

    expect(result.title).toBe("My Page");
    expect(result.version).toBe(7);
    expect(result.markdown).toMatch(/^---\n/);
    expect(result.markdown).toContain('pageId: "12345"');
    expect(result.markdown).toContain("confluenceVersion: 7");
    expect(result.markdown).toContain("# Title");
    expect(result.markdown).toContain("Hello world");
    // Sidecar carries the canonical base for future merges.
    expect(result.sidecar.pageId).toBe("12345");
    expect(result.sidecar.version).toBe(7);
    expect(result.sidecar.baseMarkdown).toContain("# Title");
  });

  it("embeds inline comment threads as %% comments", async () => {
    const client = stubClient({
      getPageStorage: vi.fn(async () => ({
        title: "Commented",
        storageHtml:
          '<p>Before <ac:inline-comment-marker ac:ref="m-1">the text</ac:inline-comment-marker> after</p>',
        version: 1,
        spaceId: "SP1",
      })),
      getPageComments: vi.fn(async () => [
        {
          id: "cmt1",
          extensions: { inlineProperties: { markerRef: "m-1" } },
          version: { by: { displayName: "Keller, Tobias" }, when: "2026-01-01" },
          body: { view: { value: "<p>Looks good</p>" } },
        },
      ]),
    });

    const result = await downloadPageToObsidian(client, "1", {
      genId: counter(),
      now: "2026-06-30T00:00:00.000Z",
    });

    expect(result.markdown).toContain("%%= Keller, Tobias /c1: Looks good =%%");
    expect(result.markdown).toContain("the text");
    expect(result.sidecar.comments.c1?.uuid).toBe("m-1");
  });

  it("decodes HTML entities (umlauts) in comment text", async () => {
    const client = stubClient({
      getPageStorage: vi.fn(async () => ({
        title: "Commented",
        storageHtml:
          '<p>Before <ac:inline-comment-marker ac:ref="m-1">the text</ac:inline-comment-marker> after</p>',
        version: 1,
        spaceId: "SP1",
      })),
      getPageComments: vi.fn(async () => [
        {
          id: "cmt1",
          extensions: { inlineProperties: { markerRef: "m-1" } },
          version: { by: { displayName: "Keller, Tobias" }, when: "2026-01-01" },
          // Confluence view HTML can entity-encode non-ASCII chars.
          body: { view: { value: "<p>Sch&ouml;ne Gr&#252;&#xDF;e</p>" } },
        },
      ]),
    });

    const result = await downloadPageToObsidian(client, "1", {
      genId: counter(),
      now: "2026-06-30T00:00:00.000Z",
    });

    expect(result.markdown).toContain("Schöne Grüße");
    expect(result.markdown).not.toContain("&ouml;");
    expect(result.markdown).not.toContain("&#252;");
  });
});

describe("uploadObsidianPage", () => {
  it("converts Obsidian markdown back to storage HTML and PUTs it", async () => {
    const update = vi.fn(
      async (
        _id: string,
        _html: string,
        _v: number,
        _t?: string,
        _s?: string,
      ) => {},
    );
    const client = stubClient({
      getPageStorage: vi.fn(async () => ({
        title: "My Page",
        storageHtml: "<p>ignored</p>",
        version: 9,
        spaceId: "SP1",
      })),
      updatePageStorage: update,
    });

    const markdown = [
      "---",
      'pageId: "555"',
      "title: My Page",
      "---",
      "",
      "# Heading",
      "",
      "Body text",
    ].join("\n");

    const result = await uploadObsidianPage(client, "555", markdown, {
      comments: {},
      baseMarkdown: "",
    });

    expect(result.status).toBe("uploaded");
    expect(result.newVersion).toBe(10);
    expect(update).toHaveBeenCalledOnce();
    const [pageId, html, version] = update.mock.calls[0]!;
    expect(pageId).toBe("555");
    expect(version).toBe(9);
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("Body text");
  });
});

describe("uploadObsidianPage — version conflict detection", () => {
  const localNote = (body: string) =>
    ["---", 'pageId: "9"', "title: P", "---", "", body].join("\n");

  it("merges cleanly when only the remote changed (remote wins)", async () => {
    const update = vi.fn(
      async (_id: string, _html: string, _v: number, _t?: string, _s?: string) => {},
    );
    const client = stubClient({
      getPageStorage: vi.fn(async () => ({
        title: "P",
        storageHtml: "<p>Hello UPDATED</p>",
        version: 2,
        spaceId: "SP",
      })),
      updatePageStorage: update,
    });

    const result = await uploadObsidianPage(client, "9", localNote("Hello world"), {
      comments: {},
      baseMarkdown: "Hello world",
      version: 1, // sidecar is behind remote (v2) → triggers merge
    });

    expect(result.status).toBe("uploaded");
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![1]).toContain("Hello UPDATED");
  });

  it("reports a conflict when both sides edited the same block", async () => {
    const update = vi.fn(
      async (_id: string, _html: string, _v: number, _t?: string, _s?: string) => {},
    );
    const client = stubClient({
      getPageStorage: vi.fn(async () => ({
        title: "P",
        storageHtml: "<p>Hello REMOTE</p>",
        version: 2,
        spaceId: "SP",
      })),
      updatePageStorage: update,
    });

    const result = await uploadObsidianPage(client, "9", localNote("Hello LOCAL"), {
      comments: {},
      baseMarkdown: "Hello world",
      version: 1,
    });

    expect(result.status).toBe("conflict");
    expect(update).not.toHaveBeenCalled();
    expect(result.canonical).toContain("Hello LOCAL");
    expect(result.canonical).toContain("Hello REMOTE");
    expect(result.canonical).toMatch(/<<<<<<<|>>>>>>>/);
  });
});

describe("parsePageId", () => {
  it("accepts a raw id", () => {
    expect(parsePageId("  4173299867 ")).toBe("4173299867");
  });
  it("extracts from a browser URL", () => {
    expect(
      parsePageId("https://x.atlassian.net/wiki/spaces/SP/pages/12345/Title"),
    ).toBe("12345");
  });
  it("returns null for junk", () => {
    expect(parsePageId("not a page")).toBeNull();
  });
});
