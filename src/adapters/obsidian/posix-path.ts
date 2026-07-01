/**
 * POSIX path utilities for Obsidian vault-relative paths.
 *
 * Why not node:path: it doesn't exist on mobile. Vault paths are always
 * forward-slash, relative-to-vault-root, so a small pure implementation covers
 * everything the core needs (sidecar paths, link resolution, image folders).
 */

import type { PathUtil } from "../../core/ports.js";

function normalize(p: string): string {
  const isAbs = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!isAbs) parts.push("..");
    } else {
      parts.push(seg);
    }
  }
  const out = (isAbs ? "/" : "") + parts.join("/");
  return out === "" ? "." : out;
}

export const posixPath: PathUtil = {
  join(...parts: string[]): string {
    return normalize(parts.filter((p) => p && p.length).join("/"));
  },
  dirname(p: string): string {
    const norm = p.replace(/\/+$/, "");
    const idx = norm.lastIndexOf("/");
    if (idx === -1) return ".";
    if (idx === 0) return "/";
    return norm.slice(0, idx);
  },
  basename(p: string, ext?: string): string {
    const norm = p.replace(/\/+$/, "");
    const base = norm.slice(norm.lastIndexOf("/") + 1);
    if (ext && base.endsWith(ext)) return base.slice(0, base.length - ext.length);
    return base;
  },
  resolve(...parts: string[]): string {
    let resolved = "";
    for (const part of parts) {
      if (!part) continue;
      resolved = part.startsWith("/") ? part : `${resolved}/${part}`;
    }
    return normalize(resolved || ".");
  },
  relative(from: string, to: string): string {
    const f = normalize(from).split("/").filter(Boolean);
    const t = normalize(to).split("/").filter(Boolean);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    const up = f.slice(i).map(() => "..");
    return [...up, ...t.slice(i)].join("/") || ".";
  },
  extname(p: string): string {
    const base = p.slice(p.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot <= 0 ? "" : base.slice(dot);
  },
};
