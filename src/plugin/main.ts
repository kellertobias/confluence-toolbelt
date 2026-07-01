/**
 * Confluence Tools — Obsidian plugin entry point.
 *
 * Wires the Obsidian/browser adapters into the shared core, registers the DOM +
 * zlib providers, exposes settings, and registers commands. Must stay node-free
 * (enforced by the esbuild node-builtin guard) so it runs on mobile.
 */

import { Plugin, type WorkspaceLeaf } from "obsidian";

import { fflateDeflater } from "../adapters/obsidian/deflate.js";
import { browserDom } from "../adapters/obsidian/dom.js";
import { noopGit } from "../adapters/obsidian/git.js";
import { subtleHasher } from "../adapters/obsidian/hasher.js";
import { obsidianHttp } from "../adapters/obsidian/http.js";
import { posixPath } from "../adapters/obsidian/posix-path.js";
import { obsidianPrompter } from "../adapters/obsidian/prompter.js";
import { vaultFs } from "../adapters/obsidian/vault-fs.js";
import { ConfluenceClient } from "../api.js";
import type { ConfluenceConfig, CoreContext } from "../core/ports.js";
import { setDeflater } from "../storage-dom/deflate.js";
import { setDom } from "../storage-dom/dom.js";
import { changeGutterExtension } from "./change-gutter.js";
import { commentEditorExtension } from "./comment-editor.js";
import { renderConfluenceComments } from "./comment-render.js";
import {
  createCommand,
  downloadAllCommand,
  downloadCommand,
  searchCommand,
  uploadCommand,
} from "./commands.js";
import {
  ConfluenceToolsSettingTab,
  DEFAULT_SETTINGS,
  type ConfluenceToolsSettings,
} from "./settings.js";
import { CONFLUENCE_VIEW_TYPE, ConfluenceToolsView } from "./view.js";

export default class ConfluenceToolsPlugin extends Plugin {
  settings!: ConfluenceToolsSettings;

  /** Progress channel: the side panel subscribes to show inline step progress
   * while a command runs (null = idle). */
  private readonly progressListeners = new Set<(msg: string | null) => void>();

  onProgress(cb: (msg: string | null) => void): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  setProgress(msg: string | null): void {
    for (const cb of this.progressListeners) cb(msg);
  }

  /** Change-gutter invalidation channel: editors re-read their sidecar base
   * when a sync rewrites it (so freshly-synced notes show zero local changes). */
  private readonly gutterListeners = new Set<() => void>();

  onGutterInvalidate(cb: () => void): () => void {
    this.gutterListeners.add(cb);
    return () => this.gutterListeners.delete(cb);
  }

  invalidateGutter(): void {
    for (const cb of this.gutterListeners) cb();
  }

  async onload(): Promise<void> {
    // Register the browser DOM + zlib providers for the conversion core.
    setDom(browserDom);
    setDeflater(fflateDeflater);

    await this.loadSettings();
    this.addSettingTab(new ConfluenceToolsSettingTab(this.app, this));

    // Side panel with action buttons.
    this.registerView(
      CONFLUENCE_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new ConfluenceToolsView(leaf, this),
    );

    // Render Confluence comments (%%= … =%%) in reading view…
    this.registerMarkdownPostProcessor((el, ctx) =>
      renderConfluenceComments(this, el, ctx),
    );
    // …and decorate them in Live Preview (hide metadata, highlight, gutter icon).
    this.registerEditorExtension(commentEditorExtension(this));
    // Show local-vs-last-sync changes as colored bars in the editor gutter.
    this.registerEditorExtension(changeGutterExtension(this));

    this.addCommand({
      id: "open-view",
      name: "Open Confluence Tools panel",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "test-connection",
      name: "Test Confluence connection",
      callback: () => this.testConnection(),
    });
    this.addCommand({
      id: "download-page",
      name: "Download Confluence page",
      callback: () => downloadCommand(this),
    });
    this.addCommand({
      id: "upload-page",
      name: "Upload current note to Confluence",
      callback: () => uploadCommand(this),
    });
    this.addCommand({
      id: "create-page",
      name: "Create new Confluence page",
      callback: () => createCommand(this),
    });
    this.addCommand({
      id: "download-all",
      name: "Download all Confluence pages",
      callback: () => downloadAllCommand(this),
    });
    this.addCommand({
      id: "search",
      name: "Search Confluence and download",
      callback: () => searchCommand(this),
    });

    this.addRibbonIcon("cloud", "Confluence Tools", () => this.activateView());
  }

  /** Reveal the Confluence Tools side panel (right sidebar). */
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CONFLUENCE_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: CONFLUENCE_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** Build a fresh CoreContext from current settings + Obsidian adapters. */
  buildContext(): CoreContext {
    return {
      dom: browserDom,
      fs: vaultFs(this.app.vault.adapter),
      path: posixPath,
      hasher: subtleHasher,
      http: obsidianHttp,
      git: noopGit,
      prompter: obsidianPrompter(this.app),
      config: this.confluenceConfig(),
    };
  }

  confluenceConfig(): ConfluenceConfig {
    return {
      baseUrl: this.settings.baseUrl,
      email: this.settings.email || undefined,
      apiToken: this.settings.apiToken || undefined,
      accessToken: this.settings.accessToken || undefined,
    };
  }

  client(): ConfluenceClient {
    return new ConfluenceClient({
      ...this.confluenceConfig(),
      http: obsidianHttp,
    });
  }

  async testConnection(): Promise<void> {
    const prompter = obsidianPrompter(this.app);
    if (!this.settings.baseUrl) {
      prompter.notify("Set the Confluence base URL in settings first.", "warn");
      return;
    }
    try {
      await this.client().searchPages("test", 1);
      prompter.notify("Confluence connection OK.");
    } catch (e) {
      prompter.notify(
        `Connection failed: ${(e as Error).message}`,
        "error",
      );
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<ConfluenceToolsSettings> | null,
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
