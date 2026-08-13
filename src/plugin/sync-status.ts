/**
 * Sync-status helpers for the side panel: detect whether the active note is a
 * Confluence note, read its local version, and (lazily) check the remote
 * version so the panel can show "up to date / update available / …".
 */

import { TFile } from "obsidian";

import { parseFrontmatter } from "../core/dialect/frontmatter.js";
import { hasLocalChanges } from "../core/pipeline/local-changes.js";
import { readSidecar } from "../core/pipeline/sidecar-store.js";
import type ConfluenceToolsPlugin from "./main.js";

export interface ActiveNoteInfo {
  file: TFile;
  pageId: string;
  title: string;
  localVersion?: number;
  downloadedAt?: string;
  /** Heuristic: file modified meaningfully after the recorded download time. */
  modifiedLocally: boolean;
}

export type SyncState =
  | "checking"
  | "synced"
  | "update-available"
  | "local-changes"
  | "diverged"
  | "offline";

/** Inspect the active note. Returns null when it isn't a Confluence note. */
export function getActiveNoteInfo(
  plugin: ConfluenceToolsPlugin,
): ActiveNoteInfo | null {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) return null;
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const pid = fm?.pageId;
  if (pid === undefined || pid === null || pid === "") return null;

  const lv = fm?.confluenceVersion;
  const localVersion =
    typeof lv === "number" ? lv : lv != null ? Number(lv) : undefined;
  const downloadedAt =
    fm?.confluenceDownloadedAt != null
      ? String(fm.confluenceDownloadedAt)
      : undefined;
  // 10s tolerance so the download write itself doesn't read as a local edit.
  const modifiedLocally = downloadedAt
    ? file.stat.mtime - Date.parse(downloadedAt) > 10_000
    : false;

  return {
    file,
    pageId: String(pid),
    title: fm?.title != null ? String(fm.title) : file.basename,
    localVersion,
    downloadedAt,
    modifiedLocally,
  };
}

/**
 * Definitive local-change check for a note path. Reads the note and its
 * sidecar, then defers to the shared `hasLocalChanges` rule.
 *
 * This is what callers should use before offering to overwrite a note — a
 * remote-only update is not a reason to warn the user about losing work.
 */
export async function hasLocalChangesAt(
  plugin: ConfluenceToolsPlugin,
  notePath: string,
  fallback?: boolean,
): Promise<boolean> {
  try {
    const file = plugin.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return false; // nothing there to overwrite
    const ctx = plugin.buildContext();
    const sidecar = await readSidecar(ctx.fs, ctx.path, notePath);
    return hasLocalChanges({
      content: await plugin.app.vault.read(file),
      base: sidecar?.baseObsidian,
      mtime: file.stat.mtime,
      fallback,
    });
  } catch {
    return true; // can't tell → ask rather than clobber
  }
}

/** Same check for the active note the side panel is describing. */
export async function checkLocalChanges(
  plugin: ConfluenceToolsPlugin,
  info: ActiveNoteInfo,
): Promise<boolean> {
  return hasLocalChangesAt(plugin, info.file.path, info.modifiedLocally);
}

export function computeState(
  info: ActiveNoteInfo,
  remoteVersion: number | null,
): SyncState {
  if (remoteVersion === null) return "offline";
  const behind =
    info.localVersion !== undefined && remoteVersion > info.localVersion;
  if (behind && info.modifiedLocally) return "diverged";
  if (behind) return "update-available";
  if (info.modifiedLocally) return "local-changes";
  return "synced";
}

/** Lightweight remote version probe (no storage body). null on failure. */
export async function fetchRemoteVersion(
  plugin: ConfluenceToolsPlugin,
  pageId: string,
): Promise<number | null> {
  try {
    const page = await plugin.client().getPage(pageId);
    return page.version?.number ?? null;
  } catch {
    return null;
  }
}

/** Compact relative time, e.g. "just now", "5 min ago", "2 h ago", "3 d ago". */
export function relativeTime(iso?: string, nowMs = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((nowMs - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}
