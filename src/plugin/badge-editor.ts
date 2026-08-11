/**
 * Live-preview renderer for status badges.
 *
 * Notes store a status as `<badge color="yellow">MVP</badge>`. Obsidian will not
 * render that itself — note HTML is sanitized with DOMPurify allowing only the
 * standard tag set plus `iframe`, so a `<badge>` element is dropped and just its
 * text survives. So the plugin draws it: this extension replaces the badge's
 * source range with a lozenge widget, and steps aside (revealing the markup) as
 * soon as the cursor is inside it, which is how Obsidian treats every other
 * inline construct.
 */

import { editorLivePreviewField } from "obsidian";
import { Prec, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { STATUS_ANY_RE } from "../core/dialect/obsidian.js";

class BadgeWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly label: string,
  ) {
    super();
  }

  eq(other: BadgeWidget): boolean {
    return other.color === this.color && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("badge");
    el.setAttribute("color", this.color);
    el.textContent = this.label;
    return el;
  }

  /** Let clicks through to the editor so the caret lands in the markup. */
  ignoreEvent(): boolean {
    return false;
  }
}

function unescapeTitle(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function buildDecorations(view: EditorView): DecorationSet {
  if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const text = view.state.doc.toString();
  const selection = view.state.selection;
  const re = new RegExp(STATUS_ANY_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    // Reveal the source while the caret is inside or touching the badge.
    const touched = selection.ranges.some((r) => r.to >= from && r.from <= to);
    if (touched) continue;
    const color = (m[1] ?? m[3] ?? m[5] ?? m[7] ?? "grey").toLowerCase();
    const label = unescapeTitle(m[2] ?? m[4] ?? m[6] ?? m[8] ?? "");
    builder.add(
      from,
      to,
      Decoration.replace({ widget: new BadgeWidget(color, label) }),
    );
  }
  return builder.finish();
}

/**
 * Registered at the highest precedence.
 *
 * Obsidian renders inline HTML in Live Preview with a replacing decoration of
 * its own. Since `<badge>` is not on its sanitizer's allowlist, that decoration
 * draws the tag's bare text — and at equal precedence it is resolved after this
 * one, so the badge appeared for a frame and was then overwritten by plain
 * text. Highest precedence settles the range in our favour.
 */
export function badgeEditorExtension() {
  return Prec.highest(
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(view);
        }

        update(update: ViewUpdate): void {
          // Rebuild on any update, not just doc/selection/viewport changes:
          // Obsidian re-renders inline HTML on transactions that set none of
          // those flags, and a stale decoration set loses the range.
          this.decorations = buildDecorations(update.view);
        }
      },
      { decorations: (v) => v.decorations },
    ),
  );
}
