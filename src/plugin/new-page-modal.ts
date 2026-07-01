/**
 * Unified "New Page" dialog: download an existing Confluence page (by URL/pageId
 * or full-text search) or create a brand-new page — in one place.
 */

import { Modal, Notice, setIcon } from "obsidian";

import { parsePageId } from "../core/pipeline/sidecar-store.js";
import { createConfluencePage, downloadCommand } from "./commands.js";
import type ConfluenceToolsPlugin from "./main.js";

type Mode = "existing" | "create";

export class NewPageModal extends Modal {
  private mode: Mode = "existing";
  private body!: HTMLElement;

  constructor(
    private readonly plugin: ConfluenceToolsPlugin,
    private readonly onDone?: () => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("cf-modal");
    this.titleEl.setText("New Confluence page");

    const seg = this.contentEl.createDiv("cf-seg");
    const existingBtn = this.segButton(seg, "download", "Download existing");
    const createBtn = this.segButton(seg, "file-plus", "Create new");
    const sync = () => {
      existingBtn.toggleClass("is-active", this.mode === "existing");
      createBtn.toggleClass("is-active", this.mode === "create");
    };
    existingBtn.addEventListener("click", () => {
      this.mode = "existing";
      sync();
      this.renderBody();
    });
    createBtn.addEventListener("click", () => {
      this.mode = "create";
      sync();
      this.renderBody();
    });
    sync();

    this.body = this.contentEl.createDiv("cf-modal-body");
    this.renderBody();
  }

  private segButton(parent: HTMLElement, icon: string, label: string): HTMLElement {
    const b = parent.createDiv("cf-seg-btn");
    setIcon(b.createSpan("cf-seg-icon"), icon);
    b.createSpan({ text: label });
    return b;
  }

  private renderBody(): void {
    this.body.empty();
    if (this.mode === "existing") this.renderExisting();
    else this.renderCreate();
  }

  // -- download existing ----------------------------------------------------

  private renderExisting(): void {
    this.body.createDiv({
      cls: "cf-field-hint",
      text: "Paste a page URL or ID, or type to search.",
    });

    const row = this.body.createDiv("cf-input-row");
    const input = row.createEl("input", {
      type: "text",
      placeholder: "URL, page ID, or search terms…",
      cls: "cf-input",
    });
    const go = row.createEl("button", { cls: "cf-input-btn", text: "Go" });
    const results = this.body.createDiv("cf-results");

    const submit = async () => {
      const value = input.value.trim();
      if (!value) return;
      const direct = parsePageId(value);
      if (direct) {
        this.close();
        await downloadCommand(this.plugin, direct);
        this.onDone?.();
        return;
      }
      await this.search(value, results);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
    });
    go.addEventListener("click", () => void submit());
    window.setTimeout(() => input.focus(), 0);
  }

  private async search(query: string, results: HTMLElement): Promise<void> {
    results.empty();
    results.createDiv({ cls: "cf-results-status", text: "Searching…" });
    try {
      const hits = await this.plugin.client().searchPages(query, 12);
      results.empty();
      if (!hits.length) {
        results.createDiv({ cls: "cf-results-status", text: "No results." });
        return;
      }
      for (const hit of hits) {
        const row = results.createDiv("cf-result");
        row.createDiv({ cls: "cf-result-title", text: hit.title });
        const meta = hit.excerpt.replace(/<[^>]+>/g, "").trim();
        row.createDiv({
          cls: "cf-result-meta",
          text: [hit.spaceKey, meta].filter(Boolean).join(" · ").slice(0, 120),
        });
        row.addEventListener("click", async () => {
          this.close();
          await downloadCommand(this.plugin, hit.id);
          this.onDone?.();
        });
      }
    } catch (e) {
      results.empty();
      results.createDiv({
        cls: "cf-results-status",
        text: `Search failed: ${(e as Error).message}`,
      });
    }
  }

  // -- create new -----------------------------------------------------------

  private renderCreate(): void {
    this.body.createDiv({
      cls: "cf-field-hint",
      text: "Creates a page in Confluence and opens it here.",
    });

    const titleInput = this.labeledInput("Title", "Page title");
    const parentInput = this.labeledInput(
      "Parent (optional)",
      "Parent URL/page ID — blank for the space root",
    );

    const actions = this.body.createDiv("cf-modal-actions");
    const create = actions.createEl("button", {
      cls: "mod-cta",
      text: "Create page",
    });
    const run = async () => {
      const title = titleInput.value.trim();
      if (!title) {
        new Notice("Enter a page title.");
        return;
      }
      this.close();
      await createConfluencePage(
        this.plugin,
        title,
        parentInput.value.trim() || undefined,
      );
      this.onDone?.();
    };
    create.addEventListener("click", () => void run());
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void run();
    });
    window.setTimeout(() => titleInput.focus(), 0);
  }

  private labeledInput(label: string, placeholder: string): HTMLInputElement {
    const field = this.body.createDiv("cf-field");
    field.createDiv({ cls: "cf-field-label", text: label });
    return field.createEl("input", {
      type: "text",
      placeholder,
      cls: "cf-input",
    });
  }
}
