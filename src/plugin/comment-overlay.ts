/**
 * Floating comment overlay shown when the comment icon is clicked. Shared by the
 * reading-view post-processor and the live-preview editor extension.
 */

export interface CommentThreadEntry {
  author: string;
  body: string;
}

let openOverlay: HTMLElement | null = null;

export function closeCommentOverlay(): void {
  openOverlay?.remove();
  openOverlay = null;
}

/** Collapse identical (author + body) entries so a consolidated view never
 * shows the same comment twice. Order is preserved. */
export function dedupeThreads(
  threads: CommentThreadEntry[],
): CommentThreadEntry[] {
  const seen = new Set<string>();
  const out: CommentThreadEntry[] = [];
  for (const t of threads) {
    const key = JSON.stringify([t.author, t.body]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function showCommentOverlay(
  anchorEl: HTMLElement,
  rawThreads: CommentThreadEntry[],
  onResolve?: () => void | Promise<void>,
): void {
  closeCommentOverlay();

  const threads = dedupeThreads(rawThreads);
  const doc = anchorEl.ownerDocument;
  const pop = doc.createElement("div");
  pop.addClass("cf-overlay");

  const head = pop.createDiv("cf-overlay-head");
  head.createSpan({ cls: "cf-overlay-icon", text: "💬" });
  head.createSpan({
    cls: "cf-overlay-title",
    text:
      threads.length === 1 ? "1 comment" : `${threads.length} comments`,
  });

  for (const t of threads) {
    const row = pop.createDiv("cf-overlay-row");
    row.createDiv({ cls: "cf-overlay-author", text: t.author || "Unknown" });
    row.createDiv({ cls: "cf-overlay-body", text: t.body });
  }

  if (onResolve) {
    const footer = pop.createDiv("cf-overlay-footer");
    const btn = footer.createEl("button", {
      cls: "cf-overlay-resolve",
      text: "Resolve",
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeCommentOverlay();
      void onResolve();
    });
  }

  doc.body.appendChild(pop);

  // Position under the icon, clamped to the viewport.
  const rect = anchorEl.getBoundingClientRect();
  const margin = 8;
  const top = rect.bottom + margin;
  let left = rect.left;
  const width = pop.offsetWidth;
  const vw = doc.defaultView?.innerWidth ?? width;
  if (left + width + margin > vw) left = Math.max(margin, vw - width - margin);
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;

  openOverlay = pop;

  // Dismiss on outside click or Escape.
  const onPointer = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node) && e.target !== anchorEl) {
      cleanup();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup();
  };
  const cleanup = () => {
    doc.removeEventListener("mousedown", onPointer, true);
    doc.removeEventListener("keydown", onKey, true);
    closeCommentOverlay();
  };
  // Defer so the opening click doesn't immediately close it.
  window.setTimeout(() => {
    doc.addEventListener("mousedown", onPointer, true);
    doc.addEventListener("keydown", onKey, true);
  }, 0);
}

/** Build the small comment icon button (used in the reading-view margin). */
export function createCommentIcon(
  doc: Document,
  rawThreads: CommentThreadEntry[],
  onResolve?: () => void | Promise<void>,
): HTMLElement {
  const threads = dedupeThreads(rawThreads);
  const icon = doc.createElement("span");
  icon.addClass("cf-comment-icon-btn");
  icon.setText("💬");
  icon.setAttr("aria-label", `${threads.length} comment(s)`);
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showCommentOverlay(icon, threads, onResolve);
  });
  return icon;
}
