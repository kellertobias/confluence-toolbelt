/**
 * No-op git adapter for the plugin. Mobile has no git, and the per-note sidecar
 * (baseMarkdown) replaces git history as the three-way merge base. `show`
 * returns null so base resolution falls back to the sidecar.
 */

import type { Git } from "../../core/ports.js";

export const noopGit: Git = {
  async show(): Promise<string | null> {
    return null;
  },
  async listChangedMarkdown(): Promise<string[]> {
    return [];
  },
  async diff(): Promise<string> {
    return "";
  },
  async commitFile(): Promise<void> {
    /* no-op */
  },
};
