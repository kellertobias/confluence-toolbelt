/**
 * Vault link/image translation between canonical markdown and Obsidian.
 *
 *  - Confluence page links  [text](pageid:ID)  ⇄  Obsidian  [[Note|text]]
 *  - Confluence attachments ![cap](#file)       ⇄  Obsidian  ![[file]]
 *
 * Pure: the vault-specific resolution (pageId ↔ note) is injected so these
 * functions stay testable and node-free. A resolver returning null leaves the
 * link untouched (e.g. a Confluence page that isn't in this vault, or a vault
 * note that isn't a Confluence page).
 */

/** [text](pageid:[SPACE:]ID) → [[Note|text]] when the pageId maps to a vault note. */
export function canonicalLinksToWiki(
  body: string,
  resolvePageId: (pageId: string) => string | null,
): string {
  return body.replace(
    /\[([^\]]+)\]\(pageid:(?:[^:)]+:)?(\d+)\)/g,
    (full, text: string, id: string) => {
      const note = resolvePageId(id);
      if (!note) return full;
      return text.trim() === note ? `[[${note}]]` : `[[${note}|${text}]]`;
    },
  );
}

/** [[Note|text]] / [[Note]] → [text](pageid:ID) when the note is a Confluence page. */
export function wikiLinksToCanonical(
  body: string,
  resolveNote: (noteName: string) => string | null,
): string {
  // Negative lookbehind avoids matching image embeds (![[ … ]]).
  return body.replace(
    /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (full, note: string, text: string | undefined) => {
      const id = resolveNote(note.trim());
      if (!id) return full;
      return `[${(text ?? note).trim()}](pageid:${id})`;
    },
  );
}

/**
 * Split an Obsidian embed target into filename and display hint.
 *
 * `![[Diagram.png|100%]]` names the attachment `Diagram.png` and asks Obsidian
 * to display it at 100% width. The hint is presentation, not identity: carrying
 * it into the attachment reference yields `<ri:attachment ri:filename=
 * "Diagram.png|100%">`, which matches nothing on the page, and Confluence
 * renders the embed as "Preview unavailable".
 */
function splitEmbedTarget(target: string): { name: string; size?: string } {
  const bar = target.indexOf("|");
  if (bar === -1) return { name: target.trim() };
  return {
    name: target.slice(0, bar).trim(),
    size: target.slice(bar + 1).trim() || undefined,
  };
}

/** ![caption](#file) → ![[file]] (caption and size hint restored from the
 * sidecar, so both round-trip). */
export function canonicalImagesToEmbeds(
  body: string,
  images?: Record<string, string>,
  embedSizes?: Record<string, string>,
): string {
  return body.replace(
    /!\[([^\]]*)\]\(#([^)]+)\)/g,
    (_full, caption: string, file: string) => {
      const name = file.trim();
      if (images && caption) images[name] = caption;
      const size = embedSizes?.[name];
      return `![[${name}${size ? `|${size}` : ""}]]`;
    },
  );
}

/** ![[file]] → ![caption](#file) (caption restored from `images` when known).
 *
 * Any display hint is stripped from the filename and recorded in `embedSizes`
 * so download can put it back — Confluence has no equivalent, and it is not
 * part of the attachment's name. */
export function embedsToCanonicalImages(
  body: string,
  images?: Record<string, string>,
  embedSizes?: Record<string, string>,
): string {
  return body.replace(/!\[\[([^\]]+)\]\]/g, (_full, file: string) => {
    const { name, size } = splitEmbedTarget(file);
    const caption = images?.[name] ?? "";
    if (embedSizes) {
      if (size) embedSizes[name] = size;
      else delete embedSizes[name];
    }
    return `![${caption}](#${name})`;
  });
}
