/**
 * Optional integration with the ObsidiSync plugin (id `ios-git-sync`).
 *
 * After a download we ask ObsidiSync to sync, and for any of our just-written
 * files that conflict we call `resolveFile(path)` — which pushes the local file
 * as the resolution, i.e. overwrites the server version with our download.
 *
 * Couples to ObsidiSync internals deliberately (same author); every access is
 * guarded so it degrades to a no-op if the plugin is absent or its API changes.
 */

import type ConfluenceToolsPlugin from "./main.js";

const OBSIDISYNC_ID = "ios-git-sync";

interface ObsidiSyncApi {
  performSync(): Promise<Array<{ path?: string } | string>>;
  resolveFile(path: string): Promise<void>;
}

function getObsidiSync(plugin: ConfluenceToolsPlugin): ObsidiSyncApi | null {
  const plugins = (plugin.app as unknown as { plugins?: any }).plugins;
  if (!plugins?.enabledPlugins?.has?.(OBSIDISYNC_ID)) return null;
  const inst = plugins.plugins?.[OBSIDISYNC_ID];
  if (
    !inst ||
    typeof inst.performSync !== "function" ||
    typeof inst.resolveFile !== "function"
  ) {
    return null;
  }
  return inst as ObsidiSyncApi;
}

export function isObsidiSyncAvailable(plugin: ConfluenceToolsPlugin): boolean {
  return getObsidiSync(plugin) !== null;
}

/** Run an ObsidiSync sync and force the given just-downloaded files to win on
 * the server if they conflict. No-op when disabled or ObsidiSync is absent. */
export async function syncAfterDownload(
  plugin: ConfluenceToolsPlugin,
  paths: string[],
): Promise<void> {
  if (!plugin.settings.autoSyncAfterDownload) return;
  const sync = getObsidiSync(plugin);
  if (!sync) return;
  try {
    const conflicts = await sync.performSync();
    const conflictPaths = new Set(
      (Array.isArray(conflicts) ? conflicts : [])
        .map((c) => (typeof c === "string" ? c : c?.path))
        .filter((p): p is string => Boolean(p)),
    );
    for (const path of paths) {
      if (conflictPaths.has(path)) {
        await sync.resolveFile(path); // local (our download) overwrites server
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[confluence-tools] ObsidiSync auto-sync failed:", e);
  }
}
