/**
 * Obsidian dialect: translate between the canonical markdown the conversion
 * core produces/consumes and Obsidian-flavored markdown.
 *
 * Canonical ⇄ Obsidian mappings:
 *  - HTML-comment header (<!-- pageId: … -->)  ⇄  YAML properties (frontmatter)
 *  - info panels (> <!-- panel:c:i -->)        ⇄  callouts (> [!type])
 *  - inline comments (<!-- comment:UUID -->…)  ⇄  %% thread %%anchor%% /ids %%
 *  - block node tags (<!-- node:ID -->)        →  removed (kept in sidecar base)
 *
 * The canonical form remains the interchange format for the storage conversion
 * and the three-way merge engine, so those are reused unchanged. This module is
 * pure (no platform imports) and fully unit-testable.
 */

import { parseHeader, emitHeader, type HeaderMeta } from "../../md-header.js";
import {
  parseFrontmatter,
  emitFrontmatter,
  type FrontmatterValue,
} from "./frontmatter.js";

/** One Confluence comment (root or reply) addressed by a stable nanoID. */
export interface ObsidianCommentRecord {
  /** Confluence inline-comment marker ref (UUID) the nanoID belongs to. */
  uuid: string;
  author: string;
  body: string;
}

/** Per-note companion file persisted as `.<file>.json`. Carries everything the
 * Obsidian markdown intentionally omits so upload can reconstruct canonical
 * form and the merge engine has a base. */
export interface ObsidianSidecar {
  pageId?: string;
  spaceId?: string;
  version?: number;
  downloadedAt?: string;
  /** Canonical markdown body (with node tags + comment markers) at last sync —
   * the three-way merge base. */
  baseMarkdown: string;
  /** Obsidian-dialect note body (frontmatter stripped) at last sync — the base
   * for the editor change-bar gutter. Text-only, so the gutter diff needs no
   * dialect re-derivation. Absent on notes synced before this was added. */
  baseObsidian?: string;
  /** nanoID → comment record. */
  comments: Record<string, ObsidianCommentRecord>;
  /** Obsidian wiki-link target → Confluence pageId (Phase 5). */
  links?: Record<string, string>;
  /** Embed filename → caption, so attachment captions round-trip. */
  images?: Record<string, string>;
  /** Embed filename → last-uploaded content hash, to skip unchanged images. */
  imageHashes?: Record<string, string>;
  /** Confluence marker refs (UUIDs) of comments resolved locally — filtered out
   * on re-download so they don't reappear. */
  resolved?: string[];
}

export interface CanonicalToObsidianOptions {
  version?: number;
  downloadedAt?: string;
  /** nanoID generator — injected for testability/determinism. */
  genId: () => string;
}

const KNOWN_PANELS = new Set([
  "info",
  "note",
  "warning",
  "tip",
  "success",
  "error",
]);

// ---------------------------------------------------------------------------
// Header ⇄ properties
// ---------------------------------------------------------------------------

function headerToProps(
  meta: HeaderMeta,
  version?: number,
  downloadedAt?: string,
): Record<string, FrontmatterValue> {
  const props: Record<string, FrontmatterValue> = {};
  if (meta.spaceId) props.spaceId = meta.spaceId;
  if (meta.pageId) props.pageId = meta.pageId;
  if (meta.title) props.title = meta.title;
  if (meta.status) props.status = meta.status;
  if (meta.readonly) props.readonly = true;
  if (version !== undefined) props.confluenceVersion = version;
  if (downloadedAt) props.confluenceDownloadedAt = downloadedAt;
  return props;
}

function propsToHeader(props: Record<string, FrontmatterValue>): {
  meta: HeaderMeta;
  version?: number;
  downloadedAt?: string;
} {
  const meta: HeaderMeta = {};
  if (props.spaceId !== undefined) meta.spaceId = String(props.spaceId);
  if (props.pageId !== undefined) meta.pageId = String(props.pageId);
  if (props.title !== undefined) meta.title = String(props.title);
  if (props.status !== undefined) meta.status = String(props.status);
  if (props.readonly === true) meta.readonly = true;
  const version =
    typeof props.confluenceVersion === "number"
      ? props.confluenceVersion
      : props.confluenceVersion !== undefined
        ? Number(props.confluenceVersion)
        : undefined;
  const downloadedAt =
    props.confluenceDownloadedAt !== undefined
      ? String(props.confluenceDownloadedAt)
      : undefined;
  return { meta, version, downloadedAt };
}

// ---------------------------------------------------------------------------
// Panels ⇄ callouts
// ---------------------------------------------------------------------------

const PANEL_PREAMBLE_RE = /^>\s*<!--\s*panel:([^:>]+):([^>]+?)\s*-->\s*(.*)$/i;
const CALLOUT_PREAMBLE_RE = /^>\s*\[!([^\]]+)\]\s*(?:%%cf:([^%]+)%%)?\s*(.*)$/;

function panelsToCallouts(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(PANEL_PREAMBLE_RE);
    if (!m) {
      out.push(lines[i] ?? "");
      continue;
    }
    const color = (m[1] ?? "").trim().toLowerCase();
    const icon = (m[2] ?? "").trim().toLowerCase();
    const tail = m[3] ?? "";
    const lossless = KNOWN_PANELS.has(color) && icon === color;
    const calloutType = KNOWN_PANELS.has(color) ? color : "info";
    // Preserve exact color:icon when it can't be derived from the type alone.
    const meta = lossless ? "" : ` %%cf:${color}:${icon}%%`;
    out.push(`> [!${calloutType}]${meta}${tail ? ` ${tail}` : ""}`);
  }
  return out.join("\n");
}

function calloutsToPanels(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(CALLOUT_PREAMBLE_RE);
    if (!m) {
      out.push(lines[i] ?? "");
      continue;
    }
    const calloutType = (m[1] ?? "").trim().toLowerCase();
    const preserved = m[2]; // "color:icon" if present
    const tail = m[3] ?? "";
    let color: string;
    let icon: string;
    if (preserved) {
      const [c, ic] = preserved.split(":");
      color = (c ?? calloutType).trim();
      icon = (ic ?? color).trim();
    } else {
      color = KNOWN_PANELS.has(calloutType) ? calloutType : "info";
      icon = color;
    }
    out.push(`> <!-- panel:${color}:${icon} -->${tail ? ` ${tail}` : ""}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Comments ⇄ %% anchored format
// ---------------------------------------------------------------------------

const CANON_COMMENT_RE =
  /<!--\s*comment:([^\s>]+)\s*-->([\s\S]*?)<!--\s*commend-end:\1\s*-->/g;
const THREAD_TAG_RE = /^\s*<!--\s*#\s*([\s\S]*?)\s*-->/;

/** Sigil prefixing a comment's nanoID in the Obsidian thread line. We use "/"
 * (not "#") so the IDs are NOT indexed as Obsidian tags. The parser also accepts
 * the legacy "#" so notes downloaded before this change still round-trip. */
const ID_SIGIL = "/";
const ENTRY_RE = /^(.*?)\s*[#/](\S+):\s?([\s\S]*)$/;

function commentsToObsidian(
  body: string,
  comments: Record<string, ObsidianCommentRecord>,
  genId: () => string,
): string {
  return body.replace(CANON_COMMENT_RE, (_full, uuid: string, middle: string) => {
    let rest = middle;
    const entries: { author: string; body: string }[] = [];
    let tm: RegExpMatchArray | null;
    while ((tm = rest.match(THREAD_TAG_RE))) {
      const inner = (tm[1] ?? "").trim();
      const ci = inner.indexOf(": ");
      const author = ci >= 0 ? inner.slice(0, ci) : inner;
      const cbody = ci >= 0 ? inner.slice(ci + 2) : "";
      entries.push({ author, body: cbody });
      rest = rest.slice(tm[0].length);
    }
    const anchor = rest;
    const ids = entries.map((e) => {
      const id = genId();
      comments[id] = { uuid, author: e.author, body: e.body };
      return id;
    });
    if (ids.length === 0) {
      const id = genId();
      comments[id] = { uuid, author: "", body: "" };
      ids.push(id);
    }
    const leading = entries
      .map((e, i) => `${e.author} ${ID_SIGIL}${ids[i]}: ${e.body}`)
      .join(" ;; ");
    const trailer = ids.map((id) => `/${id}`).join(" ");
    return `%%= ${leading} =%%${anchor}%%= ${trailer} =%%`;
  });
}

// Matches both the current `%%= … =%%` markers and the legacy `%% … %%` ones.
const OBS_COMMENT_RE =
  /%%=?\s*([^%]*?)\s*=?%%([\s\S]*?)%%=?\s*((?:\/[^\s%/=]+\s*)+?)\s*=?%%/g;

export interface ParsedObsidianComment {
  /** The visible anchored text the comment is attached to. */
  anchor: string;
  /** nanoIDs listed in the trailer. */
  ids: string[];
  /** Individual comments/replies in the thread, in order. */
  threads: { author: string; id: string; body: string }[];
  /** The full matched `%% … %%anchor%% /ids %%` source. */
  raw: string;
}

/** Parse the Obsidian comment spans out of a markdown source string. Used by the
 * reading-view renderer to surface Confluence comment threads. */
export function parseObsidianComments(text: string): ParsedObsidianComment[] {
  const out: ParsedObsidianComment[] = [];
  for (const m of text.matchAll(OBS_COMMENT_RE)) {
    const leading = m[1] ?? "";
    const anchor = m[2] ?? "";
    const ids = (m[3] ?? "")
      .trim()
      .split(/\s+/)
      .map((s) => s.replace(/^\//, ""))
      .filter(Boolean);
    const threads = leading
      .split(" ;; ")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const mm = s.match(ENTRY_RE);
        return mm
          ? { author: (mm[1] ?? "").trim(), id: mm[2] ?? "", body: mm[3] ?? "" }
          : { author: "", id: "", body: s };
      });
    out.push({ anchor, ids, threads, raw: m[0] });
  }
  return out;
}

function commentsToCanonical(
  body: string,
  comments: Record<string, ObsidianCommentRecord>,
): string {
  return body.replace(
    OBS_COMMENT_RE,
    (_full, leading: string, anchor: string, trailerRaw: string) => {
      const ids = trailerRaw
        .trim()
        .split(/\s+/)
        .map((s) => s.replace(/^\//, ""))
        .filter(Boolean);
      let uuid = "";
      for (const id of ids) {
        if (comments[id]) {
          uuid = comments[id].uuid;
          break;
        }
      }
      if (!uuid) uuid = ids[0] ?? "";
      const entryStrs = leading
        .split(" ;; ")
        .map((s) => s.trim())
        .filter(Boolean);
      const threadTags = entryStrs
        .map((s) => {
          const m = s.match(ENTRY_RE);
          const author = m ? (m[1] ?? "").trim() : s;
          const cbody = m ? (m[3] ?? "") : "";
          return `<!-- # ${author}: ${cbody} -->`;
        })
        .join("");
      return `<!-- comment:${uuid} -->${threadTags}${anchor}<!-- commend-end:${uuid} -->`;
    },
  );
}

// ---------------------------------------------------------------------------
// Node tags
// ---------------------------------------------------------------------------

const NODE_TAG_LINE_RE = /^[ \t]*<!--\s*node:[\w:-]+\s*-->[ \t]*\r?\n?/gm;

function stripNodeTags(body: string): string {
  return body.replace(NODE_TAG_LINE_RE, "");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convert a full canonical document (header + body) into Obsidian markdown
 * plus the companion sidecar. */
export function canonicalToObsidian(
  canonical: string,
  opts: CanonicalToObsidianOptions,
): { markdown: string; sidecar: ObsidianSidecar } {
  const { meta, body } = parseHeader(canonical);
  const comments: Record<string, ObsidianCommentRecord> = {};

  let obsidianBody = body;
  obsidianBody = commentsToObsidian(obsidianBody, comments, opts.genId);
  obsidianBody = panelsToCallouts(obsidianBody);
  obsidianBody = stripNodeTags(obsidianBody);

  const props = headerToProps(meta, opts.version, opts.downloadedAt);
  const frontmatter = emitFrontmatter(props);
  // `frontmatter` already ends in a newline when non-empty, so concatenate
  // directly — no extra blank line between the `---` fence and the title.
  const markdown = `${frontmatter}${obsidianBody.replace(/^\n+/, "")}`;

  const sidecar: ObsidianSidecar = {
    pageId: meta.pageId,
    spaceId: meta.spaceId,
    version: opts.version,
    downloadedAt: opts.downloadedAt,
    baseMarkdown: body,
    comments,
  };
  return { markdown, sidecar };
}

/** Convert Obsidian markdown + sidecar back into a full canonical document.
 * Node tags are NOT reinserted here — the upload pipeline re-associates them by
 * aligning against the sidecar base. */
export function obsidianToCanonical(
  markdown: string,
  sidecar: Pick<ObsidianSidecar, "comments">,
): string {
  const { props, body } = parseFrontmatter(markdown);
  const { meta } = propsToHeader(props);

  let canonicalBody = body;
  canonicalBody = calloutsToPanels(canonicalBody);
  canonicalBody = commentsToCanonical(canonicalBody, sidecar.comments ?? {});

  return `${emitHeader(meta)}${canonicalBody.replace(/^\n+/, "")}`;
}
