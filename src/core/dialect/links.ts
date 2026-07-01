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

/** ![caption](#file) → ![[file]] (caption stashed in `images` for round-trip). */
export function canonicalImagesToEmbeds(
  body: string,
  images?: Record<string, string>,
): string {
  return body.replace(
    /!\[([^\]]*)\]\(#([^)]+)\)/g,
    (_full, caption: string, file: string) => {
      const name = file.trim();
      if (images && caption) images[name] = caption;
      return `![[${name}]]`;
    },
  );
}

/** ![[file]] → ![caption](#file) (caption restored from `images` when known). */
export function embedsToCanonicalImages(
  body: string,
  images?: Record<string, string>,
): string {
  return body.replace(/!\[\[([^\]]+)\]\]/g, (_full, file: string) => {
    const name = file.trim();
    const caption = images?.[name] ?? "";
    return `![${caption}](#${name})`;
  });
}
