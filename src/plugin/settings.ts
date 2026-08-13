/**
 * Plugin settings: Confluence credentials (replaces the CLI's .env).
 */

import { App, PluginSettingTab, Setting } from "obsidian";

import type ConfluenceToolsPlugin from "./main.js";

/** Declared with the renderer ports it configures, re-exported here so the
 * settings module reads as one place. */
import type { DiagramTheme } from "../core/ports.js";

export type { DiagramTheme };

export interface ConfluenceToolsSettings {
  baseUrl: string;
  email: string;
  apiToken: string;
  accessToken: string;
  defaultSpaceId: string;
  /** After a download, run ObsidiSync and force our file to win on conflict. */
  autoSyncAfterDownload: boolean;
  /** Palette for rendered mermaid and Excalidraw diagrams. */
  diagramTheme: DiagramTheme;
}

export const DEFAULT_SETTINGS: ConfluenceToolsSettings = {
  baseUrl: "",
  email: "",
  apiToken: "",
  accessToken: "",
  defaultSpaceId: "",
  autoSyncAfterDownload: true,
  diagramTheme: "dark",
};

export class ConfluenceToolsSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ConfluenceToolsPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Confluence Tools" });

    new Setting(containerEl)
      .setName("Confluence base URL")
      .setDesc("e.g. https://your-company.atlassian.net/wiki")
      .addText((t) =>
        t
          .setPlaceholder("https://…/wiki")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => {
            this.plugin.settings.baseUrl = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Email")
      .setDesc("Atlassian account email (for API-token basic auth).")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.email)
          .onChange(async (v) => {
            this.plugin.settings.email = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API token")
      .setDesc("Create at id.atlassian.com → Security → API tokens.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.apiToken).onChange(async (v) => {
          this.plugin.settings.apiToken = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Access token (optional)")
      .setDesc("Bearer token alternative to email + API token.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.accessToken).onChange(async (v) => {
          this.plugin.settings.accessToken = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Default space ID (optional)")
      .setDesc("Used when creating a page without a parent (the space root).")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.defaultSpaceId)
          .onChange(async (v) => {
            this.plugin.settings.defaultSpaceId = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Diagram theme")
      .setDesc(
        "Palette for mermaid and Excalidraw diagrams rendered on upload. " +
          "Applies to both, so diagrams on a page match. Takes effect on the " +
          "next upload; already-published diagrams keep the theme they were " +
          "rendered with until the note changes.",
      )
      .addDropdown((d) =>
        d
          .addOption("dark", "Dark")
          .addOption("light", "Light")
          .setValue(this.plugin.settings.diagramTheme)
          .onChange(async (v) => {
            this.plugin.settings.diagramTheme = v as DiagramTheme;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-sync after download (ObsidiSync)")
      .setDesc(
        "If ObsidiSync is installed, run a sync after each download and force the downloaded file to win on the server if it conflicts.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.autoSyncAfterDownload)
          .onChange(async (v) => {
            this.plugin.settings.autoSyncAfterDownload = v;
            await this.plugin.saveSettings();
          }),
      );
  }
}
