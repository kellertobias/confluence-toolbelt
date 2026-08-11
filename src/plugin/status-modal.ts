/**
 * Authoring UI for Confluence status lozenges.
 *
 * A status is stored in the note as `<span class="cf-lozenge cf-lozenge-…">`,
 * which reads well but is unpleasant to type by hand. This module provides the
 * dialog for picking a color and label, plus the two entry points that use it:
 * the editor command (insert at the cursor, or edit the lozenge under it) and
 * click-to-edit on a rendered lozenge in reading view.
 */

import {
  type Editor,
  type MarkdownPostProcessorContext,
  Modal,
  Notice,
  TFile,
} from "obsidian";

import {
  findStatusLozenges,
  formatStatusLozenge,
  STATUS_COLORS,
  statusLozengeAt,
  type StatusLozenge,
} from "../core/dialect/obsidian.js";
import type ConfluenceToolsPlugin from "./main.js";

interface StatusModalOptions {
  /** Prefilled values — the existing lozenge when editing. */
  color?: string;
  title?: string;
  /** Shown only when editing an existing lozenge. */
  onRemove?: () => void;
  onSubmit: (color: string, title: string) => void;
}

export class StatusModal extends Modal {
  private color: string;
  private title: string;
  private preview!: HTMLElement;
  private swatches: HTMLElement[] = [];

  constructor(
    plugin: ConfluenceToolsPlugin,
    private readonly opts: StatusModalOptions,
  ) {
    super(plugin.app);
    this.color = opts.color ?? "grey";
    this.title = opts.title ?? "";
  }

  onOpen(): void {
    this.modalEl.addClass("cf-modal");
    this.titleEl.setText(
      this.opts.onRemove ? "Edit status" : "Insert status",
    );

    const field = this.contentEl.createDiv("cf-field");
    field.createDiv({ cls: "cf-field-label", text: "Text" });
    const input = field.createEl("input", {
      type: "text",
      placeholder: "MVP",
      cls: "cf-input",
      value: this.title,
    });

    const colorField = this.contentEl.createDiv("cf-field");
    colorField.createDiv({ cls: "cf-field-label", text: "Color" });
    const row = colorField.createDiv("cf-swatches");
    for (const c of STATUS_COLORS) {
      const sw = row.createDiv(`cf-swatch cf-lozenge-${c}`);
      sw.setAttribute("aria-label", c);
      sw.dataset.color = c;
      sw.addEventListener("click", () => {
        this.color = c;
        this.sync();
        input.focus();
      });
      this.swatches.push(sw);
    }

    const previewField = this.contentEl.createDiv("cf-field");
    previewField.createDiv({ cls: "cf-field-label", text: "Preview" });
    this.preview = previewField.createDiv("cf-preview");

    const actions = this.contentEl.createDiv("cf-modal-actions");
    if (this.opts.onRemove) {
      const remove = actions.createEl("button", {
        cls: "mod-warning",
        text: "Remove",
      });
      remove.addEventListener("click", () => {
        this.close();
        this.opts.onRemove?.();
      });
    }
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save" });
    const submit = () => {
      const title = input.value.trim();
      if (!title) {
        new Notice("Enter the status text.");
        input.focus();
        return;
      }
      this.close();
      this.opts.onSubmit(this.color, title);
    };
    save.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    input.addEventListener("input", () => {
      this.title = input.value;
      this.sync();
    });

    this.sync();
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  /** Repaint the selected swatch and the live preview. */
  private sync(): void {
    for (const sw of this.swatches) {
      sw.toggleClass("is-active", sw.dataset.color === this.color);
    }
    this.preview.empty();
    // Build the same element the note stores, so the preview is exact. Created
    // directly (not via markdown), so the sanitizer never sees it.
    const chip = this.preview.ownerDocument.createElement("badge");
    chip.setAttribute("color", this.color);
    chip.textContent = this.title.trim() || "STATUS";
    this.preview.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Command: edit the status lozenge under the cursor, or insert a new one.
 *
 * With text selected and no lozenge under the cursor, the selection becomes the
 * new status's label and is replaced by it.
 */
export function insertOrEditStatus(
  plugin: ConfluenceToolsPlugin,
  editor: Editor,
): void {
  const line = editor.getCursor().line;
  const lineText = editor.getLine(line);
  const existing = statusLozengeAt(lineText, editor.getCursor().ch);

  if (existing) {
    openForExisting(plugin, editor, line, existing);
    return;
  }

  const selection = editor.getSelection();
  new StatusModal(plugin, {
    title: selection.trim(),
    onSubmit: (color, title) => {
      const html = formatStatusLozenge(color, title);
      if (selection) editor.replaceSelection(html);
      else editor.replaceRange(html, editor.getCursor());
      editor.focus();
    },
  }).open();
}

function openForExisting(
  plugin: ConfluenceToolsPlugin,
  editor: Editor,
  line: number,
  existing: StatusLozenge,
): void {
  const from = { line, ch: existing.start };
  const to = { line, ch: existing.end };
  new StatusModal(plugin, {
    color: existing.color,
    title: existing.title,
    onRemove: () => {
      editor.replaceRange("", from, to);
      editor.focus();
    },
    onSubmit: (color, title) => {
      editor.replaceRange(formatStatusLozenge(color, title), from, to);
      editor.focus();
    },
  }).open();
}

/**
 * Reading view: draw the badges and make them clickable, so a status can be
 * edited without switching to source mode.
 *
 * Rendered badges appear in source order, so the nth badge element in this
 * section maps to the nth badge in the section's source lines. The file is
 * re-read on click rather than trusting the snapshot the post-processor saw, and
 * the edit is abandoned if the source no longer matches.
 */
export function registerStatusLozengeEditing(
  plugin: ConfluenceToolsPlugin,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): void {
  let els = Array.from(
    el.querySelectorAll<HTMLElement>(
      'span[class^="badge-"], badge, span.cf-lozenge',
    ),
  );

  // Safety net for a note still using a `<badge>` element: Obsidian's sanitizer
  // drops non-standard tags and keeps only their text, so rebuild the badge
  // from the note source when nothing survived.
  if (!els.length) {
    els = rebuildBadgesFromSource(el, ctx);
  }
  if (!els.length) return;

  els.forEach((node, index) => {
    node.addClass("cf-lozenge-editable");
    node.setAttribute("aria-label", "Edit status");
    node.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void editRenderedLozenge(plugin, el, ctx, index);
    });
  });
}

/**
 * Wrap each badge's label text in a real badge element, for the case where the
 * markup was stripped before this post-processor ran. Matches the section's
 * source badges against the rendered text in order.
 */
function rebuildBadgesFromSource(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
): HTMLElement[] {
  const info = ctx.getSectionInfo(el);
  if (!info) return [];
  const source = info.text
    .split("\n")
    .slice(info.lineStart, info.lineEnd + 1)
    .join("\n");
  const badges = findStatusLozenges(source);
  if (!badges.length) return [];

  const doc = el.ownerDocument;
  const out: HTMLElement[] = [];
  for (const badge of badges) {
    if (!badge.title) continue;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let wrapped = false;
    while (!wrapped && (node = walker.nextNode())) {
      // Skip text we already turned into a badge on an earlier pass.
      if ((node.parentElement as HTMLElement | null)?.closest("badge")) continue;
      const idx = (node.textContent ?? "").indexOf(badge.title);
      if (idx < 0) continue;
      const range = doc.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + badge.title.length);
      const chip = doc.createElement("badge");
      chip.setAttribute("color", badge.color);
      try {
        range.surroundContents(chip);
        out.push(chip);
        wrapped = true;
      } catch {
        // The label straddles element boundaries — leave it as plain text.
        break;
      }
    }
  }
  return out;
}

async function editRenderedLozenge(
  plugin: ConfluenceToolsPlugin,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  index: number,
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) return;
  const info = ctx.getSectionInfo(el);
  if (!info) return;

  const apply = async (replacement: string) => {
    let stale = false;
    // `process` is a read-modify-write under the vault's own lock, so this
    // can't race an in-flight editor save of the same note.
    await plugin.app.vault.process(file, (content) => {
      const lines = content.split("\n");
      const section = lines.slice(info.lineStart, info.lineEnd + 1).join("\n");
      const found = findStatusLozenges(section)[index];
      if (!found) {
        stale = true;
        return content;
      }
      const updated =
        section.slice(0, found.start) + replacement + section.slice(found.end);
      lines.splice(
        info.lineStart,
        info.lineEnd - info.lineStart + 1,
        ...updated.split("\n"),
      );
      return lines.join("\n");
    });
    if (stale) {
      new Notice("The note changed — reopen it and try again.");
    }
  };

  const section = info.text
    .split("\n")
    .slice(info.lineStart, info.lineEnd + 1)
    .join("\n");
  const current = findStatusLozenges(section)[index];
  if (!current) return;

  new StatusModal(plugin, {
    color: current.color,
    title: current.title,
    onRemove: () => void apply(""),
    onSubmit: (color, title) =>
      void apply(formatStatusLozenge(color, title)),
  }).open();
}
