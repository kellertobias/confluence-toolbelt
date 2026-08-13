/**
 * Mermaid source → PNG, using a bundled mermaid rather than Obsidian's.
 *
 * Obsidian exposes its own copy through `loadMermaid()`, and the opposite
 * choice from the Excalidraw adapter is deliberate. There, delegating to the
 * installed plugin is what guarantees the render matches what the user sees.
 * Here it would be the reverse: configuring the shared instance is a global
 * side effect. This renderer has to turn `htmlLabels` off (see below) and pin a
 * theme, and doing that through `mermaid.initialize()` on Obsidian's instance
 * would change how every diagram renders in the user's own notes. A bundled
 * copy is ours to configure, and pins the version we tested against.
 *
 * The cost is real — it is by far the largest thing in the plugin bundle.
 *
 * Two settings are load-bearing:
 *
 *  - `htmlLabels: false`. Mermaid's default puts node labels in a
 *    `<foreignObject>`. An SVG drawn to a canvas through `Image` renders in
 *    secure static mode, where foreignObject content is dropped — every label
 *    would come out blank, and the diagram would look plausible enough to
 *    publish. With this off, labels are real `<text>` elements.
 *  - `theme: "default"`. Confluence pages are light. A diagram inheriting a
 *    dark theme arrives as pale strokes on a dark rectangle in a white page.
 */

import mermaid from "mermaid";

import type { MermaidRenderer } from "../../core/ports.js";

/** Rendered at 2x and displayed at 1x, so the image stays sharp on a HiDPI
 * screen. Matches the Excalidraw renderer. */
const BACKGROUND = "#ffffff";

let configured = false;

function configure(): typeof mermaid {
  if (!configured) {
    mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "strict",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      class: { htmlLabels: false },
    });
    configured = true;
  }
  return mermaid;
}

/** A DOM able to rasterize: mermaid needs to measure text, and the PNG comes
 * out of a canvas. Both are absent when the plugin's core runs headless. */
function canRasterize(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof Image !== "undefined" &&
    typeof document.createElement === "function" &&
    typeof document.createElement("canvas").getContext === "function"
  );
}

/**
 * Intrinsic pixel size of a rendered mermaid SVG.
 *
 * Mermaid sizes its output with a `viewBox` plus a `max-width` style rather
 * than width/height attributes. An `Image` given that SVG has no intrinsic
 * size to work from and rasterizes to a default box, cropping the diagram, so
 * the dimensions are read off the viewBox and stamped on explicitly.
 */
function sizeOf(svg: string): { width: number; height: number } | null {
  const box = svg.match(
    /viewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i,
  );
  if (box) {
    const width = Number(box[1]);
    const height = Number(box[2]);
    if (width > 0 && height > 0) return { width, height };
  }
  const w = Number(svg.match(/\bwidth=["']([\d.]+)(?:px)?["']/i)?.[1]);
  const h = Number(svg.match(/\bheight=["']([\d.]+)(?:px)?["']/i)?.[1]);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** Stamp explicit pixel dimensions on the root `<svg>`, replacing the
 * `max-width` style mermaid emits (which would otherwise cap the render at the
 * diagram's CSS width regardless of scale). */
function withExplicitSize(
  svg: string,
  size: { width: number; height: number },
): string {
  return svg.replace(/<svg\b[^>]*>/i, (tag) =>
    tag
      .replace(/\s(?:width|height)=["'][^"']*["']/gi, "")
      .replace(/\sstyle=["'][^"']*["']/gi, "")
      .replace(/^<svg/i, `<svg width="${size.width}" height="${size.height}"`),
  );
}

function svgToPng(
  svg: string,
  size: { width: number; height: number },
  scale: number,
): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // A data URI rather than an object URL: nothing to revoke, and the SVG is
    // self-contained by construction, so the canvas is never tainted.
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(size.width * scale));
        canvas.height = Math.max(1, Math.round(size.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        // Confluence renders the page on white. Without this the PNG keeps a
        // transparent background, which reads as a grey box in dark mode.
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) {
            resolve(null);
            return;
          }
          blob
            .arrayBuffer()
            .then((buf) => resolve(new Uint8Array(buf)))
            .catch(() => resolve(null));
        }, "image/png");
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Each render needs a DOM id unique within the document; mermaid uses it to
 * namespace the styles it injects, and a repeat would let one diagram restyle
 * another. */
let seq = 0;

export function createMermaidRenderer(): MermaidRenderer {
  return {
    available: canRasterize,

    async renderPng(source: string, scale: number): Promise<Uint8Array | null> {
      if (!canRasterize()) return null;
      try {
        const { svg } = await configure().render(
          `cf-mermaid-${Date.now()}-${seq++}`,
          source,
        );
        const size = sizeOf(svg);
        if (!size) return null;
        return await svgToPng(withExplicitSize(svg, size), size, scale);
      } catch (e) {
        // Invalid syntax is the common case here, and it is the user's own
        // diagram — the upload falls back to the mermaid.ink URL rather than
        // failing, so this is a diagnostic, not an error path.
        // eslint-disable-next-line no-console
        console.error("[confluence-tools] mermaid render failed:", e);
        return null;
      }
    },
  };
}
