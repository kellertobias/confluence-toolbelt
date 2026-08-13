/**
 * "Download page tree" dialog: pick a Confluence page, a destination folder in
 * the vault, and how much of the hierarchy to pull.
 *
 * The folder list comes from the vault itself so the user never types a path.
 */

import { Modal, Notice, Setting, TFolder } from "obsidian";

import { parsePageId } from "../core/pipeline/sidecar-store.js";
import { downloadTreeCommand } from "./commands.js";
import type ConfluenceToolsPlugin from "./main.js";

/** Every folder in the vault, root first, as vault-relative paths ("" = root). */
function vaultFolders(plugin: ConfluenceToolsPlugin): string[] {
  const out: string[] = [""];
  for (const f of plugin.app.vault.getAllLoadedFiles()) {
    if (f instanceof TFolder && f.path && f.path !== "/") {
      out.push(f.path);
    }
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

export class DownloadTreeModal extends Modal {
  private folder: string;
  private depth = ""; // "" = all levels
  private overwrite = false;

  constructor(
    private readonly plugin: ConfluenceToolsPlugin,
    private readonly onDone?: () => void,
  ) {
    super(plugin.app);
    const active = plugin.app.workspace.getActiveFile()?.parent?.path ?? "";
    this.folder = active === "/" ? "" : active;
  }

  onOpen(): void {
    this.modalEl.addClass("cf-modal");
    this.titleEl.setText("Download Confluence page tree");
    this.contentEl.createDiv({
      cls: "cf-field-hint",
      text: "Downloads the page and every child page you can access. Child pages land in a folder named after their parent.",
    });

    const field = this.contentEl.createDiv("cf-field");
    field.createDiv({ cls: "cf-field-label", text: "Page" });
    const input = field.createEl("input", {
      type: "text",
      placeholder: "Page URL or page ID",
      cls: "cf-input",
    });

    const folders = vaultFolders(this.plugin);
    new Setting(this.contentEl)
      .setName("Destination folder")
      .setDesc("Where the top page is written")
      .addDropdown((d) => {
        for (const f of folders) {
          d.addOption(f, f === "" ? "/ (vault root)" : f);
        }
        d.setValue(folders.includes(this.folder) ? this.folder : "");
        d.onChange((v) => {
          this.folder = v;
        });
      });

    new Setting(this.contentEl)
      .setName("Levels")
      .setDesc("How deep to follow child pages")
      .addDropdown((d) => {
        d.addOption("", "All levels");
        d.addOption("0", "This page only");
        d.addOption("1", "1 level of children");
        d.addOption("2", "2 levels");
        d.addOption("3", "3 levels");
        d.setValue(this.depth);
        d.onChange((v) => {
          this.depth = v;
        });
      });

    new Setting(this.contentEl)
      .setName("Overwrite local changes")
      .setDesc(
        "Off: notes edited since their last sync are skipped and listed afterwards.",
      )
      .addToggle((t) =>
        t.setValue(this.overwrite).onChange((v) => {
          this.overwrite = v;
        }),
      );

    const actions = this.contentEl.createDiv("cf-modal-actions");
    const go = actions.createEl("button", {
      cls: "mod-cta",
      text: "Download tree",
    });

    const run = async () => {
      const value = input.value.trim();
      const pageId = value ? parsePageId(value) : null;
      if (!pageId) {
        new Notice("Enter a Confluence page URL or page ID.");
        return;
      }
      this.close();
      await downloadTreeCommand(this.plugin, {
        pageId,
        folder: this.folder,
        maxDepth: this.depth === "" ? undefined : Number(this.depth),
        overwriteLocalChanges: this.overwrite,
      });
      this.onDone?.();
    };

    go.addEventListener("click", () => void run());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void run();
    });
    window.setTimeout(() => input.focus(), 0);
  }
}
