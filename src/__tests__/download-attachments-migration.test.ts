/**
 * Regression test: attachments downloaded by an older version of the plugin
 * (sitting directly next to the note) must be moved into `attachments/` the
 * next time the note is re-downloaded.
 */

import { describe, expect, it } from "vitest";

import { downloadReferencedAttachments } from "../core/pipeline/attachment-download.js";
import { posixPath } from "../adapters/obsidian/posix-path.js";
import type { FileSystem } from "../core/ports.js";

/** In-memory FileSystem fake covering only what downloadReferencedAttachments
 * touches. */
function fakeFs(seed: Record<string, Uint8Array>): FileSystem {
  const files = new Map(Object.entries(seed));
  const dirs = new Set<string>();
  return {
    async read() {
      throw new Error("not implemented");
    },
    async readBytes(path: string) {
      const data = files.get(path);
      if (!data) throw new Error(`not found: ${path}`);
      return data;
    },
    async write() {
      throw new Error("not implemented");
    },
    async writeBytes(path: string, data: Uint8Array) {
      files.set(path, data);
    },
    async exists(path: string) {
      return files.has(path) || dirs.has(path);
    },
    async mkdir(path: string) {
      dirs.add(path);
    },
    async remove(path: string) {
      files.delete(path);
    },
    async list() {
      return [...files.keys(), ...dirs];
    },
  } as unknown as FileSystem & { __files: Map<string, Uint8Array> };
}

describe("downloadReferencedAttachments migration", () => {
  it("moves an attachment already sitting next to the note into attachments/", async () => {
    const legacyBytes = new Uint8Array([1, 2, 3]);
    const notePath = "notes/Page.md";
    const fs = fakeFs({ "notes/diagram.png": legacyBytes });
    const ctx = {
      fs,
      path: posixPath,
      hasher: { async sha256Hex() { return "deadbeef"; } },
    };
    const remoteBytes = new Uint8Array([9, 9, 9]);
    const client = {
      async listAttachments() {
        return [
          {
            filename: "diagram.png",
            downloadPath: "/download/diagram.png",
          },
        ];
      },
      async downloadAttachmentData() {
        return remoteBytes;
      },
    };
    const sidecar: { imageHashes?: Record<string, string> } = {};

    await downloadReferencedAttachments(
      ctx as any,
      client as any,
      "123",
      "See ![[diagram.png]] below.",
      notePath,
      sidecar,
    );

    expect(await fs.exists("notes/attachments/diagram.png")).toBe(true);
    expect(await fs.exists("notes/diagram.png")).toBe(false);
    expect(sidecar.imageHashes).toEqual({ "diagram.png": "deadbeef" });
  });

  it("leaves local (non-Confluence) embeds untouched", async () => {
    const notePath = "notes/Page.md";
    const localBytes = new Uint8Array([5]);
    const fs = fakeFs({ "notes/local.png": localBytes });
    const ctx = {
      fs,
      path: posixPath,
      hasher: { async sha256Hex() { return "hash"; } },
    };
    const client = {
      async listAttachments() {
        return [];
      },
      async downloadAttachmentData() {
        throw new Error("should not be called");
      },
    };

    await downloadReferencedAttachments(
      ctx as any,
      client as any,
      "123",
      "![[local.png]]",
      notePath,
      {},
    );

    expect(await fs.exists("notes/local.png")).toBe(true);
    expect(await fs.exists("notes/attachments/local.png")).toBe(false);
  });

  it("reuses the attachments/ folder for a note at the vault root", async () => {
    const notePath = "Page.md";
    const fs = fakeFs({ "image.png": new Uint8Array([1]) });
    const ctx = {
      fs,
      path: posixPath,
      hasher: { async sha256Hex() { return "hash"; } },
    };
    const client = {
      async listAttachments() {
        return [{ filename: "image.png", downloadPath: "/d/image.png" }];
      },
      async downloadAttachmentData() {
        return new Uint8Array([2]);
      },
    };

    await downloadReferencedAttachments(
      ctx as any,
      client as any,
      "1",
      "![[image.png]]",
      notePath,
      {},
    );

    expect(await fs.exists("attachments/image.png")).toBe(true);
    expect(await fs.exists("image.png")).toBe(false);
  });
});
