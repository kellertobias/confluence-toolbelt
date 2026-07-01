/**
 * Live-preview editor extension for Confluence comments:
 *  - hides the `%%= … =%%` metadata (atomic, so it can't be edited out),
 *  - highlights the anchored text in colour,
 *  - shows a comment icon in the LEFT GUTTER (margin) — not in the text — that
 *    opens the overlay (with a per-comment Resolve action) on click.
 */

import { editorInfoField, editorLivePreviewField } from "obsidian";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import {
  showCommentOverlay,
  type CommentThreadEntry,
} from "./comment-overlay.js";
import { resolveComment } from "./commands.js";
import type ConfluenceToolsPlugin from "./main.js";

const COMMENT_RE =
  /%%=?\s*([^%]*?)\s*=?%%([\s\S]*?)%%=?\s*((?:\/[^\s%/=]+\s*)+?)\s*=?%%/g;
const OPEN_MARKER_RE = /^%%=?\s*[^%]*?\s*=?%%/;
const CLOSE_MARKER_RE = /%%=?\s*(?:\/[^\s%/=]+\s*)+?\s*=?%%$/;
const ENTRY_RE = /^(.*?)\s*[#/](\S+):\s?([\s\S]*)$/;

interface LineComment {
  threads: CommentThreadEntry[];
  ids: string[];
}

function parseThreads(leading: string): CommentThreadEntry[] {
  return leading
    .split(" ;; ")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(ENTRY_RE);
      return m
        ? { author: (m[1] ?? "").trim(), body: m[3] ?? "" }
        : { author: "", body: s };
    });
}

function parseIds(trailer: string): string[] {
  return trailer
    .trim()
    .split(/\s+/)
    .map((s) => s.replace(/^\//, ""))
    .filter(Boolean);
}

interface Built {
  decorations: DecorationSet;
  atomic: DecorationSet;
  lineComments: Map<number, LineComment>;
}

function buildDecorations(view: EditorView): Built {
  const empty: Built = {
    decorations: Decoration.none,
    atomic: Decoration.none,
    lineComments: new Map(),
  };
  if (!view.state.field(editorLivePreviewField, false)) return empty;

  const deco = new RangeSetBuilder<Decoration>();
  const atom = new RangeSetBuilder<Decoration>();
  const lineComments = new Map<number, LineComment>();
  const text = view.state.doc.toString();
  const re = new RegExp(COMMENT_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const full = m[0];
    const open = full.match(OPEN_MARKER_RE);
    const close = full.match(CLOSE_MARKER_RE);
    if (!open || !close) continue;
    const ms = m.index;
    const me = ms + full.length;
    const as = ms + open[0].length;
    const ae = me - close[0].length;
    if (as > ae) continue;

    const threads = parseThreads(m[1] ?? "");
    const ids = parseIds(m[3] ?? "");
    const hide = Decoration.replace({});

    if (ms < as) {
      deco.add(ms, as, hide);
      atom.add(ms, as, hide);
    }
    if (as < ae) {
      deco.add(as, ae, Decoration.mark({ class: "cf-cm-anchor" }));
    }
    if (ae < me) {
      deco.add(ae, me, hide);
      atom.add(ae, me, hide);
    }

    const lineStart = view.state.doc.lineAt(as).from;
    const existing = lineComments.get(lineStart);
    if (existing) {
      existing.threads.push(...threads);
      existing.ids.push(...ids);
    } else {
      lineComments.set(lineStart, { threads: [...threads], ids: [...ids] });
    }
  }

  return { decorations: deco.finish(), atomic: atom.finish(), lineComments };
}

class CommentGutterMarker extends GutterMarker {
  constructor(private readonly onClick: (target: HTMLElement) => void) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cf-gutter-icon";
    el.textContent = "💬";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick(el);
    });
    return el;
  }
}

export function commentEditorExtension(plugin: ConfluenceToolsPlugin) {
  const viewPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: DecorationSet;
      lineComments: Map<number, LineComment>;
      constructor(view: EditorView) {
        const built = buildDecorations(view);
        this.decorations = built.decorations;
        this.atomic = built.atomic;
        this.lineComments = built.lineComments;
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          const built = buildDecorations(u.view);
          this.decorations = built.decorations;
          this.atomic = built.atomic;
          this.lineComments = built.lineComments;
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (p) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(p)?.atomic ?? Decoration.none,
        ),
    },
  );

  const commentGutter = gutter({
    class: "cf-comment-gutter",
    lineMarker(view, line) {
      const inst = view.plugin(viewPlugin);
      const entry = inst?.lineComments.get(line.from);
      if (!entry) return null;
      const file = view.state.field(editorInfoField, false)?.file ?? null;
      const onResolve = file
        ? () => resolveComment(plugin, file, entry.ids)
        : undefined;
      return new CommentGutterMarker((target) =>
        showCommentOverlay(target, entry.threads, onResolve),
      );
    },
  });

  return [viewPlugin, commentGutter];
}
