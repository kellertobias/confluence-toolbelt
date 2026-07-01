/**
 * Embed unresolved inline comment threads into a canonical markdown body and
 * strip comment markers whose threads are all resolved.
 *
 * Pure (no platform deps) and shared by the CLI download command and the plugin
 * download pipeline so both produce identical canonical markdown.
 */

import { decodeHtmlEntities } from "../../storage-dom/html-utils.js";

interface ConfluenceComment {
  id: string;
  ancestors?: { id: string }[];
  version?: { by?: { displayName?: string }; when?: string };
  author?: { displayName?: string };
  history?: { createdBy?: { displayName?: string }; createdDate?: string };
  body?: { view?: { value?: string }; storage?: { value?: string } };
  extensions?: { inlineProperties?: { markerRef?: string } };
}

export function embedCommentThreads(
  body: string,
  comments: ConfluenceComment[],
): string {
  const commentThreads: Record<
    string,
    { author: string; text: string; date: number }[]
  > = {};
  const idToMarkerRef: Record<string, string> = {};

  // First pass: identify root inline comments
  for (const c of comments) {
    if (c.extensions?.inlineProperties?.markerRef) {
      idToMarkerRef[c.id] = c.extensions.inlineProperties.markerRef;
      commentThreads[c.extensions.inlineProperties.markerRef] = [];
    }
  }

  // Second pass: extract text and group by thread
  for (const c of comments) {
    const rootId =
      c.ancestors && c.ancestors.length > 0 ? c.ancestors[0]!.id : c.id;
    const markerRef = idToMarkerRef[rootId];
    if (markerRef) {
      const author =
        c.version?.by?.displayName ||
        c.author?.displayName ||
        c.history?.createdBy?.displayName ||
        "Unknown";
      const date = new Date(
        c.version?.when || c.history?.createdDate || 0,
      ).getTime();
      const text = decodeHtmlEntities(
        (c.body?.view?.value || c.body?.storage?.value || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " "),
      )
        .replace(/-->/g, "--&gt;")
        .trim();
      if (text) {
        if (!commentThreads[markerRef]) commentThreads[markerRef] = [];
        commentThreads[markerRef]!.push({ author, text, date });
      }
    }
  }

  let out = body;

  // Inject thread content for markers that have unresolved comments
  for (const [ref, thread] of Object.entries(commentThreads)) {
    if (thread.length > 0) {
      thread.sort((a, b) => a.date - b.date);
      const threadTags = thread
        .map((msg) => `<!-- # ${msg.author}: ${msg.text} -->`)
        .join("");
      const tag = `<!-- comment:${ref} -->`;
      out = out.split(tag).join(`${tag}${threadTags}`);
    }
  }

  // Collect marker refs that have active (unresolved) comments
  const activeRefs = new Set<string>();
  for (const [ref, thread] of Object.entries(commentThreads)) {
    if (thread.length > 0) activeRefs.add(ref);
  }

  // Strip comment/commend-end markers whose ref has no active comments
  out = out.replace(
    /<!-- comm(?:ent|end-end):([^\s>]+) -->/g,
    (match, ref: string) => (activeRefs.has(ref) ? match : ""),
  );

  return out;
}
