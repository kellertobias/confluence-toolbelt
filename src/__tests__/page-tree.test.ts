import { describe, expect, it, vi } from "vitest";

import type { ConfluenceClient } from "../api.js";
import {
  countPages,
  fetchPageTree,
  foldersForPlan,
  planTreeLayout,
  type PageTreeNode,
} from "../core/pipeline/page-tree.js";

/** Client stub backed by a plain {parentId: children} map. */
function stubTreeClient(
  titles: Record<string, string>,
  children: Record<string, string[]>,
  overrides: Partial<Record<"getChildPages", any>> = {},
): ConfluenceClient {
  return {
    getPage: vi.fn(async (id: string) => ({ id, title: titles[id] ?? id })),
    getChildPages: vi.fn(async (id: string) =>
      (children[id] ?? []).map((c) => ({ id: c, title: titles[c] ?? c })),
    ),
    ...overrides,
  } as unknown as ConfluenceClient;
}

const TITLES = {
  "1": "Root Page",
  "2": "Child A",
  "3": "Child B",
  "4": "Grandchild",
};
const CHILDREN = { "1": ["2", "3"], "2": ["4"] };

describe("fetchPageTree", () => {
  it("walks the whole hierarchy", async () => {
    const tree = await fetchPageTree(stubTreeClient(TITLES, CHILDREN), "1");

    expect(tree.title).toBe("Root Page");
    expect(countPages(tree)).toBe(4);
    expect(tree.children.map((c) => c.title)).toEqual(["Child A", "Child B"]);
    expect(tree.children[0]?.children[0]?.title).toBe("Grandchild");
  });

  it("stops at maxDepth", async () => {
    const tree = await fetchPageTree(stubTreeClient(TITLES, CHILDREN), "1", {
      maxDepth: 1,
    });

    expect(countPages(tree)).toBe(3);
    expect(tree.children[0]?.children).toEqual([]);
  });

  it("maxDepth 0 fetches the root page only", async () => {
    const client = stubTreeClient(TITLES, CHILDREN);
    const tree = await fetchPageTree(client, "1", { maxDepth: 0 });

    expect(countPages(tree)).toBe(1);
    expect(client.getChildPages).not.toHaveBeenCalled();
  });

  it("keeps a page whose children cannot be read as a leaf", async () => {
    const client = stubTreeClient(TITLES, CHILDREN, {
      getChildPages: vi.fn(async (id: string) => {
        if (id === "2") throw new Error("403");
        return (CHILDREN[id as keyof typeof CHILDREN] ?? []).map((c) => ({
          id: c,
          title: TITLES[c as keyof typeof TITLES],
        }));
      }),
    });

    const tree = await fetchPageTree(client, "1");
    expect(countPages(tree)).toBe(3); // grandchild under the unreadable page
    expect(tree.children[0]?.children).toEqual([]);
  });

  it("does not loop on a page that reports itself as its own child", async () => {
    const client = stubTreeClient(
      { "1": "Root", "2": "Child" },
      { "1": ["2"], "2": ["1", "2"] },
    );

    const tree = await fetchPageTree(client, "1", { maxDepth: 5 });
    expect(countPages(tree)).toBe(2);
  });
});

const sanitize = (t: string) => t.replace(/[\\/:*?"<>|]/g, "-").trim();

function tree(node: {
  id: string;
  title: string;
  children?: any[];
}): PageTreeNode {
  return {
    id: node.id,
    title: node.title,
    children: (node.children ?? []).map(tree),
  };
}

describe("planTreeLayout", () => {
  it("nests children in a folder named after their parent note", () => {
    const plan = planTreeLayout(
      tree({
        id: "1",
        title: "Root Page",
        children: [
          { id: "2", title: "Child A", children: [{ id: "4", title: "Deep" }] },
          { id: "3", title: "Child B" },
        ],
      }),
      { folder: "Notes/Confluence", sanitize },
    );

    expect(plan.map((p) => p.notePath)).toEqual([
      "Notes/Confluence/Root Page.md",
      "Notes/Confluence/Root Page/Child A.md",
      "Notes/Confluence/Root Page/Child A/Deep.md",
      "Notes/Confluence/Root Page/Child B.md",
    ]);
    expect(plan.map((p) => p.depth)).toEqual([0, 1, 2, 1]);
  });

  it("writes to the vault root when no folder is given", () => {
    const plan = planTreeLayout(
      tree({ id: "1", title: "Root", children: [{ id: "2", title: "Kid" }] }),
      { folder: "", sanitize },
    );

    expect(plan.map((p) => p.notePath)).toEqual(["Root.md", "Root/Kid.md"]);
  });

  it("suffixes siblings whose titles collide after sanitizing", () => {
    const plan = planTreeLayout(
      tree({
        id: "1",
        title: "Root",
        children: [
          { id: "2", title: "A/B" },
          { id: "3", title: "A:B" },
        ],
      }),
      { folder: "", sanitize },
    );

    expect(plan.map((p) => p.notePath)).toEqual([
      "Root.md",
      "Root/A-B.md",
      "Root/A-B 2.md",
    ]);
  });

  it("reuses an existing note and anchors its children to it", () => {
    const existing = new Map([["2", "Archive/Old Name.md"]]);
    const plan = planTreeLayout(
      tree({
        id: "1",
        title: "Root",
        children: [
          { id: "2", title: "Child", children: [{ id: "3", title: "Sub" }] },
        ],
      }),
      { folder: "", sanitize, existingPath: (id) => existing.get(id) ?? null },
    );

    expect(plan.map((p) => p.notePath)).toEqual([
      "Root.md",
      "Archive/Old Name.md",
      "Archive/Old Name/Sub.md",
    ]);
    expect(plan[1]?.reusedExisting).toBe(true);
    expect(plan[0]?.reusedExisting).toBe(false);
  });

  it("falls back to the pageId when a title sanitizes to nothing", () => {
    const plan = planTreeLayout(tree({ id: "42", title: "   " }), {
      folder: "",
      sanitize,
    });
    expect(plan[0]?.notePath).toBe("42.md");
  });
});

describe("foldersForPlan", () => {
  it("lists every ancestor folder, parents before children", () => {
    const plan = planTreeLayout(
      tree({
        id: "1",
        title: "Root",
        children: [{ id: "2", title: "Kid", children: [{ id: "3", title: "G" }] }],
      }),
      { folder: "Base", sanitize },
    );

    expect(foldersForPlan(plan)).toEqual(["Base", "Base/Root", "Base/Root/Kid"]);
  });
});
