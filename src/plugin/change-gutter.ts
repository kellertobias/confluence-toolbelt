/**
 * Editor change-bar gutter: a thin colored bar marking lines that differ from
 * the last-synced version of the note.
 *
 *   green  = added line       (cf-change-added)
 *   blue   = changed line     (cf-change-changed)
 *   red    = a deletion gap   (cf-change-removed-above / -below wedge)
 *
 * The base is the note body at last sync, stored verbatim in the sidecar
 * (`baseObsidian`). Diffing text-against-text means no dialect re-derivation and
 * no false positives. Notes synced before that field existed (or never synced)
 * have no base and show no bars until the next download/upload.
 */

import { editorInfoField } from "obsidian";
import { StateEffect } from "@codemirror/state";
import {
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import { parseFrontmatter } from "../core/dialect/frontmatter.js";
import {
  canonicalImagesToEmbeds,
  canonicalLinksToWiki,
} from "../core/dialect/links.js";
import { restoreExcalidrawEmbeds } from "../core/dialect/diagrams.js";
import { canonicalToObsidian } from "../core/dialect/obsidian.js";
import { computeLineChanges } from "../core/diff/line-changes.js";
import { readSidecar } from "../core/pipeline/sidecar-store.js";
import type ConfluenceToolsPlugin from "./main.js";
import { buildPageIndex } from "./vault-index.js";

/** Fired (async) once a note's base has loaded, to drive a gutter recompute. */
const refresh = StateEffect.define<void>();

interface MarkerInfo {
  kind?: "added" | "changed";
  removedAbove?: boolean;
  removedBelow?: boolean;
}

function activeFilePath(view: EditorView): string | null {
  return view.state.field(editorInfoField, false)?.file?.path ?? null;
}

// Confluence inline-comment markers: `%%= meta =%%anchor%%= /ids =%%`. The meta
// and trailing ids are volatile (regenerated on conversion), so we strip the
// markers back to their anchored text before diffing — keeping any newlines —
// so a comment never reads as a local change.
const COMMENT_MASK_RE =
  /%%=?\s*[^%]*?\s*=?%%([\s\S]*?)%%=?\s*(?:\/[^\s%/=]+\s*)+?\s*=?%%/g;

function maskComments(text: string): string {
  return text.replace(COMMENT_MASK_RE, (_full, anchor: string) => anchor);
}

/** Re-derive the Obsidian-dialect base from the canonical `baseMarkdown` for
 * notes synced before `baseObsidian` was recorded. Mirrors the download
 * conversion (callouts, links, embeds); comment IDs are regenerated so lines
 * carrying inline comments may read as "changed" until the next clean sync. */
function deriveObsidianBase(
  plugin: ConfluenceToolsPlugin,
  sidecar: {
    baseMarkdown: string;
    version?: number;
    downloadedAt?: string;
    images?: Record<string, string>;
    embedSizes?: Record<string, string>;
    diagrams?: Record<string, string>;
  },
): string {
  let counter = 0;
  const { markdown } = canonicalToObsidian(sidecar.baseMarkdown, {
    genId: () => `b${counter++}`,
    version: sidecar.version,
    downloadedAt: sidecar.downloadedAt,
  });
  const index = buildPageIndex(plugin.app);
  let md = canonicalLinksToWiki(markdown, (id) => index.idToNote(id));
  // Size hints too: the base is canonical (hintless), so without restoring them
  // every `![[Diagram.png|100%]]` line would read as changed.
  md = canonicalImagesToEmbeds(md, sidecar.images ?? {}, sidecar.embedSizes);
  // The base is derived from canonical markdown, which names rendered PNGs.
  // Without restoring the drawing links every diagram line would read as
  // changed against the note on disk, and the gutter would cry wolf.
  md = restoreExcalidrawEmbeds(md, sidecar.diagrams);
  return parseFrontmatter(md).body;
}

/** The last-synced note body, or null if the note has no sidecar base yet. */
async function loadBase(
  plugin: ConfluenceToolsPlugin,
  path: string,
): Promise<string | null> {
  try {
    const ctx = plugin.buildContext();
    const sidecar = await readSidecar(ctx.fs, ctx.path, path);
    if (!sidecar) return null;
    if (sidecar.baseObsidian != null) return sidecar.baseObsidian;
    // Fallback for notes synced before baseObsidian existed.
    if (sidecar.baseMarkdown) return deriveObsidianBase(plugin, sidecar);
    return null;
  } catch {
    return null;
  }
}

/** Map 0-based body-line changes onto 1-based CodeMirror line numbers, offset by
 * the note's frontmatter. */
function buildMarkers(
  view: EditorView,
  base: string | null,
): Map<number, MarkerInfo> {
  const markers = new Map<number, MarkerInfo>();
  if (base === null) return markers;

  const full = view.state.doc.toString();
  const { body } = parseFrontmatter(full);
  // Body is an exact suffix of the document; its first line's CM number is the
  // frontmatter offset.
  const bodyStart = full.length - body.length;
  const offset = view.state.doc.lineAt(bodyStart).number;
  const lastLine = view.state.doc.lines;

  const changes = computeLineChanges(maskComments(base), maskComments(body));

  const at = (cmLine: number): MarkerInfo => {
    let m = markers.get(cmLine);
    if (!m) markers.set(cmLine, (m = {}));
    return m;
  };

  for (const [idx, kind] of changes.byLine) at(offset + idx).kind = kind;
  for (const idx of changes.removedBefore) at(offset + idx).removedAbove = true;
  if (changes.removedAtEnd) at(lastLine).removedBelow = true;

  return markers;
}

class ChangeMarker extends GutterMarker {
  constructor(private readonly info: MarkerInfo) {
    super();
  }
  eq(other: ChangeMarker): boolean {
    return (
      this.info.kind === other.info.kind &&
      this.info.removedAbove === other.info.removedAbove &&
      this.info.removedBelow === other.info.removedBelow
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cf-change-bar";
    if (this.info.kind) el.classList.add(`cf-change-${this.info.kind}`);
    if (this.info.removedAbove) el.classList.add("cf-change-removed-above");
    if (this.info.removedBelow) el.classList.add("cf-change-removed-below");
    return el;
  }
}

export function changeGutterExtension(plugin: ConfluenceToolsPlugin) {
  const tracker = ViewPlugin.fromClass(
    class {
      markers = new Map<number, MarkerInfo>();
      private base: string | null = null;
      private basePath: string | null = null;
      private loadToken = 0;
      private readonly unsubscribe: () => void;

      constructor(private readonly view: EditorView) {
        this.unsubscribe = plugin.onGutterInvalidate(() => this.reload());
        this.beginLoad(activeFilePath(view));
      }

      destroy(): void {
        this.unsubscribe();
      }

      update(u: ViewUpdate): void {
        const path = activeFilePath(u.view);
        if (path !== this.basePath) {
          this.beginLoad(path);
          return;
        }
        const refreshed = u.transactions.some((t) =>
          t.effects.some((e) => e.is(refresh)),
        );
        if (u.docChanged || refreshed) this.recompute();
      }

      /** Re-read the base for the current note (after a sync rewrote it). */
      private reload(): void {
        this.basePath = null;
        this.beginLoad(activeFilePath(this.view));
      }

      private beginLoad(path: string | null): void {
        this.basePath = path;
        this.base = null;
        this.markers = new Map();
        const token = ++this.loadToken;
        if (!path) return;
        void loadBase(plugin, path).then((base) => {
          if (token !== this.loadToken) return; // superseded by a newer load
          this.base = base;
          // Trigger an update cycle so the gutter re-reads markers.
          this.view.dispatch({ effects: refresh.of() });
        });
      }

      private recompute(): void {
        this.markers = buildMarkers(this.view, this.base);
      }
    },
  );

  const changeGutter = gutter({
    class: "cf-change-gutter",
    lineMarker(view, line) {
      const inst = view.plugin(tracker);
      if (!inst) return null;
      const lineNo = view.state.doc.lineAt(line.from).number;
      const info = inst.markers.get(lineNo);
      return info ? new ChangeMarker(info) : null;
    },
    lineMarkerChange(update) {
      return (
        update.docChanged ||
        update.transactions.some((t) => t.effects.some((e) => e.is(refresh)))
      );
    },
  });

  return [tracker, changeGutter];
}
