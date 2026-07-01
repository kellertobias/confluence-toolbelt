/**
 * Read/write the per-note `.<file>.json` sidecar through the FileSystem port.
 */

import type { FileSystem, PathUtil } from "../ports.js";
import type { ObsidianSidecar } from "../dialect/obsidian.js";

export function sidecarPathFor(path: PathUtil, notePath: string): string {
  const dir = path.dirname(notePath);
  const base = path.basename(notePath);
  return path.join(dir, `.${base}.json`);
}

export async function readSidecar(
  fs: FileSystem,
  path: PathUtil,
  notePath: string,
): Promise<ObsidianSidecar | null> {
  const p = sidecarPathFor(path, notePath);
  if (!(await fs.exists(p))) return null;
  try {
    return JSON.parse(await fs.read(p)) as ObsidianSidecar;
  } catch {
    return null;
  }
}

export async function writeSidecar(
  fs: FileSystem,
  path: PathUtil,
  notePath: string,
  sidecar: ObsidianSidecar,
): Promise<void> {
  const p = sidecarPathFor(path, notePath);
  await fs.write(p, `${JSON.stringify(sidecar, null, 2)}\n`);
}

/** Extract a numeric Confluence pageId from a raw id or a browser URL. */
export function parsePageId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/\/pages\/(\d+)/);
  return m ? (m[1] as string) : null;
}
