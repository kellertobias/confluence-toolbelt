/**
 * Excalidraw drawing → PNG, via the Excalidraw plugin's own automation API.
 *
 * We deliberately do not bundle Excalidraw itself: it is a large dependency,
 * and a drawing rendered by a different version than the one that authored it
 * is exactly the kind of subtle mismatch nobody notices until a diagram looks
 * wrong on a published page. Delegating to the installed plugin means what
 * Confluence receives is what the user sees in their vault.
 *
 * `ExcalidrawAutomate.createPNG` merges the elements currently held in the
 * automation instance with those of the template file it is given, so the
 * instance must be reset first — otherwise leftovers from a previous call bleed
 * into the next diagram.
 *
 * The theme comes from the plugin's own setting rather than from the vault's
 * appearance, and is shared with the mermaid renderer so both kinds of diagram
 * on a page match. Following Obsidian's theme instead would mean a drawing's
 * palette depended on which machine published it.
 */

import type { App } from "obsidian";

import type { DiagramRenderer, DiagramTheme } from "../../core/ports.js";

const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

/** The slice of ExcalidrawAutomate we rely on. Structural, so a version that
 * adds parameters stays compatible. */
interface ExcalidrawAutomateLike {
  reset(): void;
  getExportSettings?(withBackground: boolean, withTheme: boolean): unknown;
  getEmbeddedFilesLoader?(inLocalGraph?: boolean): unknown;
  createPNG(
    templatePath?: string,
    scale?: number,
    exportSettings?: unknown,
    loader?: unknown,
    theme?: string,
    padding?: number,
  ): Promise<Blob | null>;
}

/**
 * The live automation instance, or null when Excalidraw isn't usable.
 *
 * Resolved on every call rather than cached: the user can enable or disable the
 * plugin between uploads, and a stale handle from a disabled plugin throws deep
 * inside the render instead of failing the availability check.
 */
function getAutomate(app: App): ExcalidrawAutomateLike | null {
  // `plugins` is Obsidian internal API — not in the public typings.
  const plugins = (app as unknown as { plugins?: Record<string, unknown> })
    .plugins as
    | {
        enabledPlugins?: Set<string>;
        plugins?: Record<string, { ea?: unknown } | undefined>;
      }
    | undefined;

  if (!plugins?.enabledPlugins?.has(EXCALIDRAW_PLUGIN_ID)) return null;

  const fromPlugin = plugins.plugins?.[EXCALIDRAW_PLUGIN_ID]?.ea;
  const fromWindow = (globalThis as { ExcalidrawAutomate?: unknown })
    .ExcalidrawAutomate;
  const ea = (fromPlugin ?? fromWindow) as ExcalidrawAutomateLike | undefined;

  return ea && typeof ea.createPNG === "function" ? ea : null;
}

/**
 * @param theme - read per render, not captured, so a settings change applies
 *                without reloading the plugin.
 */
export function createExcalidrawRenderer(
  app: App,
  theme: () => DiagramTheme,
): DiagramRenderer {
  return {
    available: () => getAutomate(app) !== null,

    async renderPng(path: string, scale: number): Promise<Uint8Array | null> {
      const ea = getAutomate(app);
      if (!ea) return null;
      try {
        ea.reset();
        const exportSettings = ea.getExportSettings?.(true, false);
        // `false` — load embedded files from this file only, not the whole
        // graph. A drawing that embeds another note should still render, but we
        // do not want a diagram upload walking the vault.
        const loader = ea.getEmbeddedFilesLoader?.(false);
        const blob = await ea.createPNG(
          path,
          scale,
          exportSettings,
          loader,
          theme(),
          10,
        );
        if (!blob) return null;
        return new Uint8Array(await blob.arrayBuffer());
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[confluence-tools] Excalidraw render failed for "${path}":`,
          e,
        );
        return null;
      }
    },
  };
}
