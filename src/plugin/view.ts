/**
 * Confluence Tools side panel.
 *
 * Context-aware: on a synced note it offers Upload/Download Current plus a live
 * sync-status card (background-checks the remote version); off a synced note it
 * only offers New Page / Download All. Refreshes on note switch, on metadata
 * changes, and on a periodic timer.
 */

import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";

import {
  downloadAllCommand,
  downloadCommand,
  uploadCommand,
} from "./commands.js";
import type ConfluenceToolsPlugin from "./main.js";
import { NewPageModal } from "./new-page-modal.js";
import {
  checkLocalChanges,
  computeState,
  fetchRemoteVersion,
  getActiveNoteInfo,
  relativeTime,
  type ActiveNoteInfo,
  type SyncState,
} from "./sync-status.js";

export const CONFLUENCE_VIEW_TYPE = "confluence-tools-view";

/** remoteVersion: number = known, null = offline, undefined = still checking. */
type Remote = number | null | undefined;

const LABELS: Record<SyncState | "checking", string> = {
  checking: "Checking…",
  synced: "Up to date",
  "update-available": "Update available",
  "local-changes": "Local changes",
  diverged: "Remote + local changes",
  offline: "Offline",
};

export class ConfluenceToolsView extends ItemView {
  private readonly remoteCache = new Map<
    string,
    { ts: number; version: number | null }
  >();
  private busy = false;
  private lastInfo: ActiveNoteInfo | null = null;
  private lastRemote: Remote = undefined;
  private progressMsg: string | null = null;
  private progressEl?: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ConfluenceToolsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CONFLUENCE_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Confluence Tools";
  }
  getIcon(): string {
    return "cloud";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => void this.refresh()),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path === this.app.workspace.getActiveFile()?.path) {
          void this.refresh();
        }
      }),
    );
    // Periodic re-check of the open note (every 3 minutes).
    this.registerInterval(
      window.setInterval(() => void this.refresh(true), 180_000),
    );
    // Inline step progress while a command runs.
    this.register(
      this.plugin.onProgress((msg) => {
        this.progressMsg = msg;
        this.renderProgress();
      }),
    );
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  // -- data -----------------------------------------------------------------

  private async refresh(forceRemote = false): Promise<void> {
    if (this.busy) return;
    const info = getActiveNoteInfo(this.plugin);
    // Draw immediately with whatever remote version we already have cached.
    const cached = info ? this.cachedVersion(info.pageId) : undefined;
    this.draw(info, cached);

    if (info && this.plugin.settings.baseUrl) {
      // Definitive local-change detection (content vs. stored base) + remote.
      const modified = await checkLocalChanges(this.plugin, info);
      const remote = await this.remoteVersion(info.pageId, forceRemote);
      // Only apply if the user hasn't switched notes meanwhile.
      const current = getActiveNoteInfo(this.plugin);
      if (current && current.pageId === info.pageId && !this.busy) {
        current.modifiedLocally = modified;
        this.draw(current, remote);
      }
    }
  }

  private cachedVersion(pageId: string): Remote {
    const c = this.remoteCache.get(pageId);
    return c ? c.version : undefined;
  }

  private async remoteVersion(
    pageId: string,
    force: boolean,
  ): Promise<number | null> {
    const c = this.remoteCache.get(pageId);
    if (!force && c && Date.now() - c.ts < 30_000) return c.version;
    const version = await fetchRemoteVersion(this.plugin, pageId);
    this.remoteCache.set(pageId, { ts: Date.now(), version });
    return version;
  }

  private async run(action: () => Promise<void> | void): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.draw(this.lastInfo, this.lastRemote);
    try {
      await action();
    } finally {
      this.busy = false;
      // Force a fresh remote check after any action.
      if (this.lastInfo) this.remoteCache.delete(this.lastInfo.pageId);
      await this.refresh(true);
    }
  }

  // -- rendering ------------------------------------------------------------

  private draw(info: ActiveNoteInfo | null, remote: Remote): void {
    this.lastInfo = info;
    this.lastRemote = remote;

    const root = this.contentEl;
    root.empty();
    root.toggleClass("is-busy", this.busy);
    root.addClass("cf-view");

    const header = root.createDiv("cf-header");
    header.createSpan({ cls: "cf-brand", text: "Confluence" });
    const refresh = header.createSpan("cf-icon-btn");
    setIcon(refresh, "refresh-cw");
    refresh.setAttr("aria-label", "Re-check now");
    refresh.addEventListener("click", () => void this.refresh(true));

    this.progressEl = root.createDiv("cf-progress");
    this.renderProgress();

    if (!this.plugin.settings.baseUrl) {
      root.createDiv({
        cls: "cf-empty",
        text: "Add your Confluence URL and credentials in settings to begin.",
      });
      return;
    }

    const state: SyncState | "checking" =
      info && remote !== undefined ? computeState(info, remote) : "checking";

    if (info) {
      this.renderStatus(root, info, remote, state);
      const wantDownload =
        state === "update-available" || state === "diverged";
      const wantUpload = state === "local-changes" || state === "diverged";
      this.action(root, "upload", "Upload current", wantUpload, () =>
        uploadCommand(this.plugin),
      );
      this.action(root, "download", "Download current", wantDownload, () =>
        downloadCommand(this.plugin),
      );
      // Downloading re-pulls from Confluence, discarding local edits — warn
      // when the note has local changes so this reads as an intentional reset.
      if (state === "local-changes" || state === "diverged") {
        root.createDiv({
          cls: "cf-btn-hint",
          text: "Download resets your local changes",
        });
      }
      root.createDiv("cf-divider");
    } else {
      root.createDiv({
        cls: "cf-empty",
        text: "This note isn't linked to a Confluence page.",
      });
    }

    this.action(root, "file-plus", "New page", false, () =>
      new NewPageModal(this.plugin, () => void this.refresh(true)).open(),
    );
    this.action(root, "download-cloud", "Download all", false, () =>
      downloadAllCommand(this.plugin),
    );
  }

  private renderProgress(): void {
    const el = this.progressEl;
    if (!el) return;
    el.empty();
    if (this.progressMsg) {
      el.removeClass("is-hidden");
      el.createDiv("cf-spinner");
      el.createSpan({ cls: "cf-progress-text", text: this.progressMsg });
    } else {
      el.addClass("is-hidden");
    }
  }

  private renderStatus(
    root: HTMLElement,
    info: ActiveNoteInfo,
    remote: Remote,
    state: SyncState | "checking",
  ): void {
    const card = root.createDiv(`cf-status cf-status-${state}`);
    card.setAttr("aria-label", "Re-check now");
    card.addEventListener("click", () => void this.refresh(true));

    card.createSpan("cf-dot");
    const text = card.createDiv("cf-status-text");
    text.createDiv({ cls: "cf-status-label", text: LABELS[state] });
    text.createDiv({ cls: "cf-status-title", text: info.title });

    const parts: string[] = [];
    if (info.localVersion !== undefined) parts.push(`v${info.localVersion}`);
    if (typeof remote === "number" && remote !== info.localVersion) {
      parts.push(`remote v${remote}`);
    }
    if (info.downloadedAt) parts.push(`synced ${relativeTime(info.downloadedAt)}`);
    text.createDiv({ cls: "cf-status-meta", text: parts.join(" · ") });
  }

  private action(
    parent: HTMLElement,
    icon: string,
    label: string,
    emphasize: boolean,
    onClick: () => Promise<void> | void,
  ): void {
    const btn = parent.createEl("button", {
      cls: `cf-btn${emphasize ? " cf-btn-cta" : ""}`,
    });
    setIcon(btn.createSpan("cf-btn-icon"), icon);
    btn.createSpan({ cls: "cf-btn-label", text: label });
    btn.disabled = this.busy;
    btn.addEventListener("click", () => void this.run(onClick));
  }
}
