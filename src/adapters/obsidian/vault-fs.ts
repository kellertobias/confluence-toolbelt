/**
 * FileSystem adapter backed by the Obsidian vault DataAdapter (desktop + mobile).
 * Paths are vault-relative POSIX strings.
 */

import type { DataAdapter } from "obsidian";

import type { FileSystem } from "../../core/ports.js";

export function vaultFs(adapter: DataAdapter): FileSystem {
  return {
    async read(path: string): Promise<string> {
      return adapter.read(path);
    },
    async readBytes(path: string): Promise<Uint8Array> {
      return new Uint8Array(await adapter.readBinary(path));
    },
    async write(path: string, data: string): Promise<void> {
      await adapter.write(path, data);
    },
    async writeBytes(path: string, data: Uint8Array): Promise<void> {
      const buf = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer;
      await adapter.writeBinary(path, buf);
    },
    async exists(path: string): Promise<boolean> {
      return adapter.exists(path);
    },
    async list(dir: string): Promise<string[]> {
      const res = await adapter.list(dir);
      return [...res.files, ...res.folders];
    },
  };
}
