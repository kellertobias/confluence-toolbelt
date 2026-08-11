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
  /** Canonical markdown body (with node tags + comment markers) at last sync.
   * Legacy merge base; still used to re-derive the editor's change-bar base. */
  baseMarkdown: string;
  /** The remote as the merge reads it at last sync — the three-way merge base.
   * Recorded in block form so an unchanged remote compares exactly; see
   * `remoteMergeBase`. */
  baseBlocks?: { nodeId?: string; text: string }[];
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

/**
 * Text wrapped in emphasis markers and nothing else.
 *
 * At least two markers a side, so a single-asterisk `*aside*` is not mistaken
 * for a title. Backslashes are tolerated inside the run because an earlier
 * version doubled the markers on upload (`****Title****`); Confluence stored
 * that as italic-bold between literal asterisks, and it comes back as
 * `\****Title***\*`. Accepting that shape heals those panels on re-download.
 */
const WRAPPED_RE = /^(?:\\?\*){2,}(.+?)(?:\\?\*){2,}$/;

function unwrapBold(text: string): string | null {
  const inner = text.trim().match(WRAPPED_RE)?.[1];
  // Emphasis inside a sentence (`**a** and **b**`) is not a title.
  if (!inner || /[*\\]/.test(inner)) return null;
  return inner.trim() || null;
}

/**
 * A panel body line that is nothing but bold text, e.g. `> **Examples**`.
 *
 * Confluence has no separate title field on a panel — authors write the title
 * as a fully bold first line. Obsidian callouts *do* have a title slot, so
 * promoting that line reads the same in both places. A trailing hard break
 * (two spaces) still counts: the line is the title either way.
 */
function boldTitleOf(line: string | undefined): string | null {
  return unwrapBold((line ?? "").replace(/^>\s?/, ""));
}

/** Drop emphasis markers a title already carries, so writing it back as a bold
 * line cannot double them up. */
function stripBold(title: string): string {
  return unwrapBold(title) ?? title;
}

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
    let title = stripBold(m[3]?.trim() ?? "");
    const lossless = KNOWN_PANELS.has(color) && icon === color;
    const calloutType = KNOWN_PANELS.has(color) ? color : "info";
    // Preserve exact color:icon when it can't be derived from the type alone.
    const meta = lossless ? "" : ` %%cf:${color}:${icon}%%`;
    if (!title) {
      const promoted = boldTitleOf(lines[i + 1]);
      if (promoted) {
        title = promoted;
        i++; // consumed as the callout's title
        // Drop a now-leading blank quote line so the body starts right away.
        if ((lines[i + 1] ?? "").trim() === ">") i++;
      }
    }
    out.push(`> [!${calloutType}]${meta}${title ? ` ${title}` : ""}`);
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
    const title = (m[3] ?? "").trim();
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
    out.push(`> <!-- panel:${color}:${icon} -->`);
    // Confluence panels carry their title as a bold first line — and it has to
    // be its own paragraph, so follow it with a blank quote line unless the
    // body already starts with one. Without that the title and the first body
    // line merge into a single run-on paragraph in Confluence.
    if (title) {
      out.push(`> **${stripBold(title)}**`);
      if ((lines[i + 1] ?? "").replace(/^>\s*/, "").trim() !== "") {
        out.push(">");
      }
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Status lozenges ⇄ inline spans
// ---------------------------------------------------------------------------

/**
 * Canonical markdown carries Confluence status macros as `<!-- status:c:T -->`,
 * which Obsidian renders as nothing at all — a note full of them reads as if
 * the labels were simply missing. Obsidian does render inline HTML, so in the
 * Obsidian dialect a status becomes an inline element the plugin's stylesheet
 * draws as an Atlassian lozenge.
 *
 * The stored form is `<span class="badge-yellow">MVP</span>`.
 *
 * `<badge color="…">` reads better and is accepted on input, but it cannot be
 * the stored form: Obsidian sanitizes note HTML with DOMPurify allowing only
 * the standard tags plus `iframe`, in reading view *and* in Live Preview's
 * inline-HTML widget. A `<badge>` element is therefore dropped in both, and it
 * only appears where the plugin manages to out-rank Obsidian's own decoration —
 * which it does at the top level but not inside callouts. `span` is on the
 * allowlist, so it renders natively everywhere with no plugin involvement.
 *
 * Only simple word colors round-trip through a badge — that is every color
 * Confluence's status macro offers. Anything else stays an HTML comment so no
 * information is lost.
 */
const STATUS_COMMENT_RE = /<!--\s*status:([^:>]+):([^>]*?)\s*-->/gi;

/**
 * Every badge spelling we accept, in one scan so results stay in source order.
 *
 * Beyond the form we write, this reads back the `<badge …>` element forms (both
 * ones we briefly stored and ones typed by hand) and the
 * `<span class="cf-lozenge …">` shape earlier versions used, so no note loses
 * its statuses on upload just because it predates the current spelling.
 */
export const STATUS_ANY_RE = new RegExp(
  [
    // <badge color="yellow">MVP</badge> — the form we write
    '<badge\\s+color=["\']([a-z]+)["\']\\s*>([\\s\\S]*?)<\\/badge\\s*>',
    // <badge-yellow>MVP</badge-yellow> and <badge:yellow>MVP</badge>
    "<badge[:-]([a-z]+)\\s*>([\\s\\S]*?)<\\/badge(?:[:-][a-z]+)?\\s*>",
    // <span class="badge-yellow">MVP</span>
    '<span class="badge-([a-z]+)">([\\s\\S]*?)<\\/span>',
    // legacy: <span class="cf-lozenge cf-lozenge-yellow">MVP</span>
    '<span class="cf-lozenge cf-lozenge-([a-z]+)">([\\s\\S]*?)<\\/span>',
  ].join("|"),
  "gi",
);

/** The colors Confluence's status macro offers, in its own palette order. */
export const STATUS_COLORS = [
  "grey",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
] as const;

export type StatusColor = (typeof STATUS_COLORS)[number];

/** A status lozenge located in an Obsidian note body. */
export interface StatusLozenge {
  color: string;
  title: string;
  /** Character offsets of the whole badge element in the source. */
  start: number;
  end: number;
}

/** Render a status as the Obsidian-dialect inline badge. */
export function formatStatusLozenge(color: string, title: string): string {
  const c = color.trim().toLowerCase();
  const safe = /^[a-z]+$/.test(c) ? c : "grey";
  return `<span class="badge-${safe}">${escapeStatusTitle(title.trim())}</span>`;
}

/** Every status lozenge in `text`, in source order, whichever form it uses. */
export function findStatusLozenges(text: string): StatusLozenge[] {
  const out: StatusLozenge[] = [];
  for (const m of text.matchAll(STATUS_ANY_RE)) {
    // One alternative matched; take whichever color/title pair is defined.
    const color = m[1] ?? m[3] ?? m[5] ?? m[7] ?? "grey";
    const title = m[2] ?? m[4] ?? m[6] ?? m[8] ?? "";
    out.push({
      color: color.toLowerCase(),
      title: unescapeStatusTitle(title),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

/**
 * The lozenge the cursor sits in or touches, if any.
 *
 * Both edges count as a hit so the command still targets a lozenge when the
 * caret has been placed just before or just after it — which is where clicking
 * a rendered lozenge in Live Preview tends to leave it.
 */
export function statusLozengeAt(
  text: string,
  offset: number,
): StatusLozenge | null {
  return (
    findStatusLozenges(text).find(
      (s) => offset >= s.start && offset <= s.end,
    ) ?? null
  );
}

function escapeStatusTitle(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeStatusTitle(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function statusesToObsidian(body: string): string {
  return body.replace(STATUS_COMMENT_RE, (full, colorRaw, titleRaw) => {
    const color = String(colorRaw ?? "").trim().toLowerCase();
    const title = String(titleRaw ?? "").trim();
    if (!/^[a-z]+$/.test(color)) return full;
    return formatStatusLozenge(color, title);
  });
}

function statusesToCanonical(body: string): string {
  // Splice from the back so the offsets of the earlier matches stay valid.
  let out = body;
  for (const s of findStatusLozenges(body).reverse()) {
    out =
      out.slice(0, s.start) +
      `<!-- status:${s.color}:${s.title} -->` +
      out.slice(s.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Widgets ⇄ placeholder blocks
// ---------------------------------------------------------------------------

/**
 * Canonical markdown parks Confluence widgets (today: the TOC macro) in
 * `<!-- widget:NAME -->`, which Obsidian renders as nothing — the page just
 * loses its table of contents. In the Obsidian dialect a widget becomes a
 * block-level placeholder the plugin fills in with live content (see
 * `toc-render.ts`); the text inside is only the fallback shown when the plugin
 * isn't there, so it is never read back.
 */
const WIDGET_COMMENT_RE = /^([ \t]*)<!--\s*widget:([A-Za-z0-9_-]+)\s*-->[ \t]*$/gim;
const WIDGET_BLOCK_RE =
  /^([ \t]*)<div class="cf-widget" data-widget="([A-Za-z0-9_-]+)">[^<]*<\/div>[ \t]*$/gim;

const WIDGET_LABELS: Record<string, string> = {
  toc: "Table of contents",
};

function widgetsToObsidian(body: string): string {
  return body.replace(WIDGET_COMMENT_RE, (_full, indent: string, name: string) => {
    const label = WIDGET_LABELS[name.toLowerCase()] ?? name;
    return `${indent}<div class="cf-widget" data-widget="${name}">${label}</div>`;
  });
}

function widgetsToCanonical(body: string): string {
  return body.replace(
    WIDGET_BLOCK_RE,
    (_full, indent: string, name: string) => `${indent}<!-- widget:${name} -->`,
  );
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
  obsidianBody = statusesToObsidian(obsidianBody);
  obsidianBody = widgetsToObsidian(obsidianBody);
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
  canonicalBody = statusesToCanonical(canonicalBody);
  canonicalBody = widgetsToCanonical(canonicalBody);
  canonicalBody = commentsToCanonical(canonicalBody, sidecar.comments ?? {});

  return `${emitHeader(meta)}${canonicalBody.replace(/^\n+/, "")}`;
}
