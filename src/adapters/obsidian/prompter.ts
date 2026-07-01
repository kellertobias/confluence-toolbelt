/**
 * Prompter adapter backed by Obsidian UI (Notice for messages, SuggestModal for
 * single-select, a checkbox Modal for multi-select, a two-button Modal for
 * confirm).
 */

import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";

import type { Prompter, SelectChoice } from "../../core/ports.js";

class ChoiceSuggestModal<T> extends SuggestModal<SelectChoice<T>> {
  constructor(
    app: App,
    private readonly choices: SelectChoice<T>[],
    private readonly onPick: (value: T) => void,
    private readonly onCancel: () => void,
    message: string,
  ) {
    super(app);
    this.setPlaceholder(message);
  }

  private picked = false;

  getSuggestions(query: string): SelectChoice<T>[] {
    const q = query.toLowerCase();
    return this.choices.filter((c) => c.name.toLowerCase().includes(q));
  }

  renderSuggestion(item: SelectChoice<T>, el: HTMLElement): void {
    el.createEl("div", { text: item.name });
    if (item.message) el.createEl("small", { text: item.message });
  }

  onChooseSuggestion(item: SelectChoice<T>): void {
    this.picked = true;
    this.onPick(item.value);
  }

  onClose(): void {
    if (!this.picked) this.onCancel();
  }
}

export function obsidianPrompter(app: App): Prompter {
  return {
    select<T>(opts: {
      message: string;
      choices: SelectChoice<T>[];
    }): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        new ChoiceSuggestModal<T>(
          app,
          opts.choices,
          resolve,
          () => reject(new Error("cancelled")),
          opts.message,
        ).open();
      });
    },

    multiselect<T>(opts: {
      message: string;
      choices: SelectChoice<T>[];
    }): Promise<T[]> {
      return new Promise<T[]>((resolve, reject) => {
        const selected = new Set<number>();
        const modal = new Modal(app);
        modal.titleEl.setText(opts.message);
        opts.choices.forEach((choice, i) => {
          new Setting(modal.contentEl).setName(choice.name).addToggle((t) =>
            t.onChange((v) => {
              if (v) selected.add(i);
              else selected.delete(i);
            }),
          );
        });
        let confirmed = false;
        new Setting(modal.contentEl).addButton((b) =>
          b
            .setButtonText("OK")
            .setCta()
            .onClick(() => {
              confirmed = true;
              modal.close();
              resolve(
                [...selected].map((i) => opts.choices[i]!.value),
              );
            }),
        );
        modal.onClose = () => {
          if (!confirmed) reject(new Error("cancelled"));
        };
        modal.open();
      });
    },

    confirm(message: string): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const modal = new Modal(app);
        modal.contentEl.createEl("p", { text: message });
        let answered = false;
        new Setting(modal.contentEl)
          .addButton((b) =>
            b
              .setButtonText("Yes")
              .setCta()
              .onClick(() => {
                answered = true;
                modal.close();
                resolve(true);
              }),
          )
          .addButton((b) =>
            b.setButtonText("No").onClick(() => {
              answered = true;
              modal.close();
              resolve(false);
            }),
          );
        modal.onClose = () => {
          if (!answered) resolve(false);
        };
        modal.open();
      });
    },

    notify(message: string, level: "info" | "warn" | "error" = "info"): void {
      new Notice(
        level === "info" ? message : `[${level.toUpperCase()}] ${message}`,
      );
    },
  };
}
