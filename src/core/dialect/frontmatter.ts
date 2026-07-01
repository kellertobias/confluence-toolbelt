/**
 * Minimal YAML front-matter for Obsidian properties.
 *
 * Why not a YAML library: we only emit/parse a flat map of scalar string/number
 * values (spaceId, pageId, title, status, confluenceVersion, …). A tiny,
 * dependency-free reader/writer keeps the browser bundle small and avoids a
 * YAML parser's surface area. Values that need quoting (containing ':' or '#',
 * or leading/trailing space) are double-quoted via JSON.
 */

export type FrontmatterValue = string | number | boolean;

export interface ParsedFrontmatter {
  props: Record<string, FrontmatterValue>;
  body: string;
}

const FENCE = "---";

function needsQuote(s: string): boolean {
  return (
    s.length === 0 ||
    // Quote strings that would otherwise parse back as a number/boolean so the
    // string type survives the round-trip (e.g. Confluence IDs like "456", and
    // large IDs that would lose precision as JS numbers).
    /^-?\d+$/.test(s) ||
    /^(true|false|null)$/i.test(s) ||
    /^[\s>!@#&*?|%{}\[\],"']/.test(s) ||
    /:\s|\s$|^\s|#/.test(s) ||
    s.includes(": ") ||
    s.endsWith(":")
  );
}

function emitScalar(value: FrontmatterValue): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return needsQuote(value) ? JSON.stringify(value) : value;
}

function parseScalar(raw: string): FrontmatterValue {
  const t = raw.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.replace(/^"|"$/g, "");
    }
  }
  if (/^-?\d+$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return t;
}

export function emitFrontmatter(props: Record<string, FrontmatterValue>): string {
  const keys = Object.keys(props);
  if (keys.length === 0) return "";
  const lines = [FENCE];
  for (const key of keys) {
    const value = props[key];
    if (value === undefined || value === "") continue;
    lines.push(`${key}: ${emitScalar(value as FrontmatterValue)}`);
  }
  lines.push(FENCE);
  return `${lines.join("\n")}\n`;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const text = markdown.replace(/^﻿/, "");
  if (!text.startsWith(`${FENCE}\n`) && !text.startsWith(`${FENCE}\r\n`)) {
    return { props: {}, body: markdown };
  }
  const rest = text.slice(text.indexOf("\n") + 1);
  const endIdx = rest.search(/^---\s*$/m);
  if (endIdx === -1) {
    return { props: {}, body: markdown };
  }
  const block = rest.slice(0, endIdx);
  const after = rest.slice(endIdx).replace(/^---\s*\r?\n?/, "");
  const props: Record<string, FrontmatterValue> = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (!m) continue;
    props[m[1] as string] = parseScalar(m[2] ?? "");
  }
  return { props, body: after };
}
