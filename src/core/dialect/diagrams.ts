/**
 * Excalidraw diagram embeds ⇄ rendered Confluence attachments.
 *
 * Obsidian keeps a drawing as a note (`X.excalidraw.md`) and embeds it with
 * `![[X.excalidraw]]`. Confluence cannot render that — it needs a real image.
 * On upload each such embed is rendered to PNG and attached to the page, and
 * the embed is rewritten to name the rendered file so the existing attachment
 * machinery (`embedsToCanonicalImages` → `<ri:attachment>`) carries it the rest
 * of the way unchanged.
 *
 * That rewrite is lossy on its own: `![[X.excalidraw]]` → `![[X.png]]` would
 * come back from Confluence pointing at the PNG, and the link to the editable
 * drawing would be gone after a single round-trip. So every rewrite is recorded
 * in the sidecar as `renderedName -> originalTarget`, and download reverses it
 * before anything else reads the markdown — including the attachment fetch,
 * which therefore never writes the rendered PNG into the vault.
 *
 * A vault with no sidecar entry for a given attachment (a colleague opening a
 * page we published) simply keeps `![[X.png]]` and renders the downloaded
 * image. That is the correct outcome: they have no drawing to link to.
 *
 * Pure — no Obsidian or node imports — so the round-trip is unit-testable.
 */

/** Embed syntax: `![[target]]` or `![[target|size]]`. */
const EMBED_RE = /!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g;

/** True when an embed target names an Excalidraw drawing.
 *
 * Both spellings occur: `![[X.excalidraw]]` is what the Excalidraw plugin
 * inserts (Obsidian resolves it to `X.excalidraw.md`), while a hand-written
 * link or a `.excalidraw` file in compatibility mode carries the extension
 * literally. */
export function isExcalidrawTarget(target: string): boolean {
  return /\.excalidraw(\.md)?$/i.test(target.trim());
}

/**
 * Attachment filename for the rendered image of a drawing.
 *
 * `Vault Structure.excalidraw` → `Vault Structure.png`. The `.excalidraw`
 * suffix is dropped rather than kept (`…excalidraw.png`) so the name reads as
 * an image on the Confluence attachments list.
 */
export function renderedNameFor(target: string): string {
  const stem = target
    .trim()
    .replace(/\.md$/i, "")
    .replace(/\.excalidraw$/i, "");
  return `${stem}.png`;
}

/**
 * Attachment filename for the drawing source uploaded alongside the image.
 *
 * Kept as `.excalidraw.md` so dropping it into a vault yields a working,
 * editable drawing rather than an inert blob.
 */
export function sourceNameFor(target: string): string {
  const stem = target
    .trim()
    .replace(/\.md$/i, "")
    .replace(/\.excalidraw$/i, "");
  return `${stem}.excalidraw.md`;
}

/** Every distinct Excalidraw embed target in a note body, in source order. */
export function findExcalidrawEmbeds(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(EMBED_RE)) {
    const target = (m[1] ?? "").trim();
    if (target && isExcalidrawTarget(target)) seen.add(target);
  }
  return [...seen];
}

/**
 * Point Excalidraw embeds at their rendered images, recording the reverse
 * mapping so download can restore the original links.
 *
 * Only targets present in `rendered` are rewritten — a drawing we could not
 * render (no Excalidraw available and no previous upload) is deliberately left
 * as `![[X.excalidraw]]` so the caller can refuse the upload rather than
 * silently publish a page with a missing diagram.
 *
 * Any embed size hint (`![[X.excalidraw|400]]`) is preserved.
 *
 * @param body     - Obsidian note body
 * @param rendered - embed target → rendered attachment filename
 * @param diagrams - sidecar map, updated in place with renderedName → target
 */
export function rewriteExcalidrawEmbeds(
  body: string,
  rendered: Map<string, string>,
  diagrams: Record<string, string>,
): string {
  return body.replace(EMBED_RE, (full, rawTarget: string, size?: string) => {
    const target = rawTarget.trim();
    const name = rendered.get(target);
    if (!name) return full;
    diagrams[name] = target;
    return `![[${name}${size ?? ""}]]`;
  });
}

/**
 * Restore `![[X.png]]` embeds back to the drawings they were rendered from.
 *
 * Runs first on download, before attachment fetching and before the change
 * gutter reads the body, so nothing downstream ever sees the rendered name.
 */
export function restoreExcalidrawEmbeds(
  body: string,
  diagrams: Record<string, string> | undefined,
): string {
  if (!diagrams || Object.keys(diagrams).length === 0) return body;
  return body.replace(EMBED_RE, (full, rawTarget: string, size?: string) => {
    const original = diagrams[rawTarget.trim()];
    return original ? `![[${original}${size ?? ""}]]` : full;
  });
}

/**
 * Drop sidecar entries whose rendered image is no longer embedded in the note.
 *
 * Without this the map grows forever, and a stale entry would resurrect a
 * deleted diagram's link the next time an unrelated attachment happened to
 * reuse the filename.
 */
export function pruneDiagramMap(
  body: string,
  diagrams: Record<string, string>,
): Record<string, string> {
  const live = new Set(findExcalidrawEmbeds(body));
  const out: Record<string, string> = {};
  for (const [name, target] of Object.entries(diagrams)) {
    if (live.has(target)) out[name] = target;
  }
  return out;
}
