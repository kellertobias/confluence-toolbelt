/**
 * Build a pageId ⇄ note index from the vault's frontmatter (via metadataCache),
 * used to translate Confluence page links to/from Obsidian wikilinks.
 */

import type { App } from "obsidian";

export interface PageIndex {
  idToNote(pageId: string): string | null;
  noteToId(noteName: string): string | null;
}

export function buildPageIndex(app: App): PageIndex {
  const idToNote = new Map<string, string>();
  const noteToId = new Map<string, string>();

  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    const pid = fm?.pageId;
    if (pid !== undefined && pid !== null && pid !== "") {
      const id = String(pid);
      idToNote.set(id, file.basename);
      noteToId.set(file.basename, id);
    }
  }

  return {
    idToNote: (id) => idToNote.get(id) ?? null,
    noteToId: (name) => noteToId.get(name) ?? null,
  };
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
};

export function mimeForFilename(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}
