/**
 * Progress + error reporting for long operations.
 *
 * Drives a single updating toast (Notice) through the operation's steps, plus
 * the plugin progress channel so the side panel shows inline progress. On
 * success a brief confirmation toast; on failure a longer error toast and a
 * console.error with the full error for diagnosis.
 */

import { Notice } from "obsidian";

import type ConfluenceToolsPlugin from "./main.js";

export class Progress {
  private notice: Notice | null = null;

  constructor(
    private readonly plugin: ConfluenceToolsPlugin,
    private readonly title: string,
  ) {}

  start(step?: string): void {
    const msg = this.format(step);
    this.notice = new Notice(msg, 0); // 0 = persist until hidden
    this.plugin.setProgress(msg);
  }

  step(step: string): void {
    const msg = this.format(step);
    if (this.notice) this.notice.setMessage(msg);
    else this.start(step);
    this.plugin.setProgress(msg);
  }

  done(message: string): void {
    this.clear();
    new Notice(message, 4000);
  }

  /** Clear silently (e.g. the user cancelled). */
  cancel(message?: string): void {
    this.clear();
    if (message) new Notice(message, 3000);
  }

  fail(err: unknown): void {
    this.clear();
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[confluence-tools] ${this.title} failed:`, err);
    new Notice(`${this.title} failed: ${message}`, 10000);
  }

  private clear(): void {
    this.notice?.hide();
    this.notice = null;
    this.plugin.setProgress(null);
  }

  private format(step?: string): string {
    return step ? `${this.title}: ${step}` : `${this.title}…`;
  }
}
