/**
 * Obsidian dialect: translate between the canonical markdown the conversion
 * core produces/consumes and Obsidian-flavored markdown.
 *
 * Canonical ⇄ Obsidian mappings:
 *  - HTML-comment header (<!-- pageId: … -->)  ⇄  YAML properties (frontmatter)
 *  - info panels (> <!-- panel:c:i -->)        ⇄  callouts (> [!type])
 *  - expand sections (<!-- expand:T -->…)      ⇄  foldable callouts (> [!expand]-)
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
  /** Embed filename → Obsidian display hint (`"100%"`, `"400"`), so
   * `![[Diagram.png|100%]]` survives the round-trip. Confluence has no
   * equivalent, and the hint is not part of the attachment name. */
  embedSizes?: Record<string, string>;
  /** Embed filename → last-uploaded content hash, to skip unchanged images. */
  imageHashes?: Record<string, string>;
  /** Rendered-diagram attachment filename → the vault embed target it came
   * from (`"Architecture.png" → "Architecture.excalidraw"`). Confluence only
   * ever sees the PNG; this is what lets download restore the link to the
   * editable drawing instead of leaving the note pointing at the render. */
  diagrams?: Record<string, string>;
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

/**
 * Confluence panel type → Obsidian callout type.
 *
 * Matched on colour rather than on name, because the two vocabularies use
 * several of the same words for different colours. Confluence's `note` is the
 * yellow "take care" box, which is Obsidian's `warning`; Confluence's `warning`
 * is red, which is Obsidian's `danger`. Mapping by name — which is what this
 * used to do — turned every yellow panel orange and every red one yellow.
 *
 * Confluence's plain `panel` (no colour, no icon) becomes `note`, Obsidian's
 * neutral remark callout, which also gives the plain panel somewhere to live:
 * it used to arrive as a blue info box carrying a preservation marker.
 */
const PANEL_TO_CALLOUT: Record<string, string> = {
  info: "info", // blue
  note: "warning", // yellow
  success: "tip", // green
  tip: "tip", // green
  error: "danger", // red
  warning: "danger", // red — the legacy macro, not ADF's yellow "warning"
  panel: "note", // plain
};

/**
 * Obsidian callout type → Confluence panel type, including the aliases
 * Obsidian accepts for each of its own types.
 *
 * Not every entry round-trips: both `tip` and `success` come back from
 * Confluence as `tip`, and both `error` and `warning` as `danger`. The pairs
 * that cannot be inverted are preserved verbatim in the `%%cf:…%%` marker
 * instead, so a page keeps the exact panel type it had.
 *
 * Of each pair, the round-tripping member is the one the upload can actually
 * write: `success` and `error` are ADF-only panel types with no macro behind
 * them, so a green panel is stored as `tip` and a red one as `warning`. Point
 * the primary callout types at those, and a green or red callout settles to a
 * clean `> [!tip]` / `> [!danger]` after its first upload instead of carrying
 * a `%%cf:…%%` marker for the rest of the page's life. The ADF names still
 * arrive from Confluence on a page nobody has re-uploaded yet, and the marker
 * carries them until then.
 */
const CALLOUT_TO_PANEL: Record<string, string> = {
  info: "info",
  todo: "info",
  warning: "note",
  caution: "note",
  attention: "note",
  question: "note", // yellow in Obsidian
  help: "note",
  faq: "note",
  tip: "tip",
  hint: "success",
  important: "success",
  success: "success",
  check: "success",
  done: "success",
  danger: "warning",
  error: "error",
  failure: "error",
  fail: "error",
  missing: "error",
  bug: "error",
  note: "panel",
};

/** Neutral fallback for a callout type we have no mapping for — a plain grey
 * box reads better than asserting a colour the author didn't ask for. */
const DEFAULT_PANEL = "panel";
const DEFAULT_CALLOUT = "note";

/** Whether a Confluence panel type survives the trip through Obsidian and
 * back. When it doesn't, the exact type is carried in the `%%cf:…%%` marker. */
function panelRoundTrips(color: string): boolean {
  const callout = PANEL_TO_CALLOUT[color];
  return callout !== undefined && CALLOUT_TO_PANEL[callout] === color;
}

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
// The optional `[-+]` is Obsidian's fold marker. It carries no Confluence
// meaning, but it has to be consumed here: folding a panel in Obsidian would
// otherwise push a literal "-" into the panel's title on the next upload.
const CALLOUT_PREAMBLE_RE =
  /^>\s*\[!([^\]]+)\][-+]?\s*(?:%%cf:([^%]+)%%)?\s*(.*)$/;

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
    const lossless = panelRoundTrips(color) && icon === color;
    const calloutType = PANEL_TO_CALLOUT[color] ?? DEFAULT_CALLOUT;
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
    // Expands are their own construct, not a panel colour. They are already
    // gone by the time this runs; the guard keeps a hand-written one from
    // silently becoming an info panel.
    if (calloutType === EXPAND_CALLOUT_TYPE) {
      out.push(lines[i] ?? "");
      continue;
    }
    const preserved = m[2]; // "color:icon" if present
    const title = (m[3] ?? "").trim();
    let color: string;
    let icon: string;
    if (preserved) {
      const [c, ic] = preserved.split(":");
      color = (c ?? calloutType).trim();
      icon = (ic ?? color).trim();
    } else {
      color = CALLOUT_TO_PANEL[calloutType] ?? DEFAULT_PANEL;
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
// Expand sections ⇄ foldable callouts
// ---------------------------------------------------------------------------

/**
 * Confluence's expand macro reaches canonical markdown as a pair of delimiters
 * (`<!-- expand:Title -->` … `<!-- /expand -->`) wrapping arbitrary blocks.
 * Obsidian renders an HTML comment as nothing at all, so a page full of expands
 * arrives as a wall of prose whose collapsible structure has vanished, and the
 * user cannot fold what they cannot see.
 *
 * Obsidian's one native collapsible is the foldable callout, so that is what an
 * expand becomes: `> [!expand]- Title`, where `-` means "starts collapsed" —
 * which is how Confluence renders it too. The body is quoted one level rather
 * than flattened, so tables, code fences, panels and nested expands inside an
 * expand keep working as themselves.
 *
 * `expand` is not one of Obsidian's built-in callout types. Obsidian falls back
 * to the default note styling for unknown types and still folds them, and the
 * plugin's stylesheet gives it a Confluence-like look. A dedicated type is worth
 * that: it round-trips unambiguously, where reusing `[!note]` would make an
 * expand indistinguishable from a panel.
 */
const EXPAND_CALLOUT_TYPE = "expand";

const EXPAND_OPEN_RE = /^\s*<!--\s*expand(?::\s*([\s\S]*?))?\s*-->\s*$/i;
const EXPAND_CLOSE_RE = /^\s*<!--\s*\/expand\s*-->\s*$/i;
/** `> [!expand]- Title` — the fold marker is optional and either sign is
 * accepted, so a user who expands the section by hand is not fighting the
 * next download. */
const EXPAND_CALLOUT_RE = new RegExp(
  `^>\\s*\\[!${EXPAND_CALLOUT_TYPE}\\][-+]?\\s*(.*)$`,
  "i",
);

/**
 * Index of the `<!-- /expand -->` closing the delimiter at `start`, or -1 when
 * the document never closes it.
 *
 * Depth-counted, so a nested expand's close does not end the outer one. An
 * unterminated opener is left alone rather than swallowing the rest of the
 * document — the same call the upload path makes.
 */
function matchingExpandEnd(lines: string[], start: number): number {
  let depth = 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (EXPAND_CLOSE_RE.test(line)) {
      depth--;
      if (depth === 0) return i;
    } else if (EXPAND_OPEN_RE.test(line)) {
      depth++;
    }
  }
  return -1;
}

/** Quote one line into a callout body. A blank line has to become a bare `>`
 * or the callout ends there and the rest of the body spills out below it. */
function quoteIntoCallout(line: string): string {
  return line.trim() === "" ? ">" : `> ${line}`;
}

function expandsToCallouts(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(EXPAND_OPEN_RE);
    const end = m ? matchingExpandEnd(lines, i) : -1;
    if (!m || end === -1) {
      out.push(lines[i] ?? "");
      continue;
    }
    const title = (m[1] ?? "").trim();
    // Recurse first, then quote: an inner expand is already a callout by the
    // time it is quoted, which is exactly how Obsidian nests them.
    const inner = expandsToCallouts(lines.slice(i + 1, end).join("\n"));
    out.push(
      `> [!${EXPAND_CALLOUT_TYPE}]-${title ? ` ${title}` : ""}`,
      ...inner.split("\n").map(quoteIntoCallout),
    );
    i = end;
  }
  return out.join("\n");
}

function calloutsToExpands(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(EXPAND_CALLOUT_RE);
    if (!m) {
      out.push(lines[i] ?? "");
      continue;
    }
    // Everything quoted below the preamble is the section's body; the first
    // unquoted line ends it.
    const inner: string[] = [];
    let j = i + 1;
    while (j < lines.length && /^\s*>/.test(lines[j] ?? "")) {
      inner.push((lines[j] ?? "").replace(/^\s*>[ \t]?/, ""));
      j++;
    }
    const title = (m[1] ?? "").trim();
    out.push(
      title ? `<!-- expand:${title} -->` : "<!-- expand -->",
      ...calloutsToExpands(inner.join("\n")).split("\n"),
      "<!-- /expand -->",
    );
    i = j - 1;
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
  // After the panels: quoting an expand's body turns a panel inside it into a
  // nested callout, which is what Obsidian expects — but only if it is already
  // a callout, since `panelsToCallouts` only recognises an unquoted preamble.
  obsidianBody = expandsToCallouts(obsidianBody);
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
  // Mirror image of the download order: unwrap the expands first so a panel
  // nested inside one is back at quote depth 1 when `calloutsToPanels` runs.
  canonicalBody = calloutsToExpands(canonicalBody);
  canonicalBody = calloutsToPanels(canonicalBody);
  canonicalBody = statusesToCanonical(canonicalBody);
  canonicalBody = widgetsToCanonical(canonicalBody);
  canonicalBody = commentsToCanonical(canonicalBody, sidecar.comments ?? {});

  return `${emitHeader(meta)}${canonicalBody.replace(/^\n+/, "")}`;
}
