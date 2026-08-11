import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Mocked Confluence: a 3-page tree (Root → Child A → Deep, Root → Child B). */
const TITLES: Record<string, string> = {
  "1": "Root Page",
  "2": "Child A",
  "3": "Child B",
  "4": "Deep",
};
const CHILDREN: Record<string, string[]> = { "1": ["2", "3"], "2": ["4"] };
const bodies: Record<string, string> = {};

const client = {
  getPage: async (id: string) => ({ id, title: TITLES[id] ?? id }),
  getChildPages: async (id: string) =>
    (CHILDREN[id] ?? []).map((c) => ({ id: c, title: TITLES[c] as string })),
  getPageStorage: async (id: string) => ({
    title: TITLES[id] as string,
    storageHtml: bodies[id] ?? `<p>Body of ${TITLES[id]}</p>`,
    version: 1,
    spaceId: "SPACE",
  }),
  getPageAtlasDoc: async () => undefined,
  getPageV1Content: async () => ({ version: { when: "2026-01-02T03:04:05Z" } }),
  getPageComments: async () => [],
  getPageSpaceKey: async () => undefined,
};

vi.mock("../adapters/node/confluence.js", () => ({
  fromEnv: () => client,
}));

const { downloadTree } = await import("../commands/download-tree.js");

let dir: string;

beforeAll(() => {
  process.env.NO_AUTO_COMMIT = "1";
});
afterAll(() => {
  delete process.env.NO_AUTO_COMMIT;
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-tree-"));
  for (const k of Object.keys(bodies)) delete bodies[k];
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(dir, rel));

describe("downloadTree", () => {
  it("writes the page and its descendants, mirroring the hierarchy", async () => {
    await downloadTree({ cwd: dir, args: ["1"] });

    expect(exists("Root-Page.md")).toBe(true);
    expect(exists("Root-Page/Child-A.md")).toBe(true);
    expect(exists("Root-Page/Child-A/Deep.md")).toBe(true);
    expect(exists("Root-Page/Child-B.md")).toBe(true);
    expect(read("Root-Page/Child-A.md")).toContain("pageId: 2");
    expect(read("Root-Page/Child-A.md")).toContain("Body of Child A");
  });

  it("accepts a browser URL and a target folder", async () => {
    await downloadTree({
      cwd: dir,
      args: [
        "https://example.atlassian.net/wiki/spaces/SP/pages/1/Root+Page",
        "wiki",
        "--depth",
        "1",
      ],
    });

    expect(exists("wiki/Root-Page.md")).toBe(true);
    expect(exists("wiki/Root-Page/Child-A.md")).toBe(true);
    expect(exists("wiki/Root-Page/Child-A/Deep.md")).toBe(false); // depth 1
  });

  it("refreshes an untouched note when the remote changes", async () => {
    await downloadTree({ cwd: dir, args: ["1"] });
    bodies["2"] = "<p>Updated remotely</p>";

    await downloadTree({ cwd: dir, args: ["1"] });

    expect(read("Root-Page/Child-A.md")).toContain("Updated remotely");
  });

  it("keeps a locally-edited note and reports it as skipped", async () => {
    await downloadTree({ cwd: dir, args: ["1"] });
    const edited = path.join(dir, "Root-Page/Child-A.md");
    fs.writeFileSync(edited, `${read("Root-Page/Child-A.md")}\nMy own notes\n`);
    bodies["2"] = "<p>Updated remotely</p>";

    await downloadTree({ cwd: dir, args: ["1"] });

    expect(fs.readFileSync(edited, "utf8")).toContain("My own notes");
    expect(fs.readFileSync(edited, "utf8")).not.toContain("Updated remotely");
    // Siblings without local edits are still refreshed.
    expect(exists("Root-Page/Child-B.md")).toBe(true);
  });

  it("overwrites local changes when --force is given", async () => {
    await downloadTree({ cwd: dir, args: ["1"] });
    const edited = path.join(dir, "Root-Page/Child-A.md");
    fs.writeFileSync(edited, `${read("Root-Page/Child-A.md")}\nMy own notes\n`);
    bodies["2"] = "<p>Updated remotely</p>";

    await downloadTree({ cwd: dir, args: ["1", "--force"] });

    expect(fs.readFileSync(edited, "utf8")).toContain("Updated remotely");
    expect(fs.readFileSync(edited, "utf8")).not.toContain("My own notes");
  });

  it("does not touch a pre-existing file it has no baseline for", async () => {
    fs.writeFileSync(path.join(dir, "Root-Page.md"), "hand written\n", "utf8");

    await downloadTree({ cwd: dir, args: ["1"] });

    expect(read("Root-Page.md")).toBe("hand written\n");
  });

  it("refreshes an already-downloaded page in place instead of duplicating it", async () => {
    // Child A already lives somewhere else in the tree, from an earlier download.
    fs.mkdirSync(path.join(dir, "archive"), { recursive: true });
    await downloadTree({ cwd: dir, args: ["2", "archive"] });
    expect(exists("archive/Child-A.md")).toBe(true);

    await downloadTree({ cwd: dir, args: ["1"] });

    expect(exists("Root-Page/Child-A.md")).toBe(false);
    expect(exists("archive/Child-A.md")).toBe(true);
    // …and its children are anchored to where the note actually is.
    expect(exists("archive/Child-A/Deep.md")).toBe(true);
  });
});
