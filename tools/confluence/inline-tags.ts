/**
 * Inline tag parser for mapping markdown blocks to Confluence storage node IDs.
 *
 * Supported formats (both parsed; emitter prefers the simple node tag):
 * - `<!-- node:789 -->`
 * - `<!-- tag:content nodeId:789 -->` (legacy; still accepted)
 */

export interface InlineTag {
  tagType?: string;
  nodeId?: string;
}

const LEGACY_TAG_RE = /<!--\s*tag:(?<type>[\w-]+)?\s+(?:nodeId:(?<id>[\w-:]+))\s*-->/;
const NODE_TAG_RE = /<!--\s*node:(?<id>[\w-:]+)\s*-->/;

export interface MarkdownBlock {
  tag?: InlineTag;
  text: string;
}

export function parseBlocks(markdownBody: string): MarkdownBlock[] {
  const lines = markdownBody.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let pendingTag: InlineTag | undefined;
  let current: string[] = [];

  function flush() {
    if (current.length === 0) return;
    blocks.push({ tag: pendingTag, text: current.join("\n").trimEnd() });
    pendingTag = undefined;
    current = [];
  }

  for (const line of lines) {
    const nodeMatch = line.match(NODE_TAG_RE);
    const legacyMatch = nodeMatch ? null : line.match(LEGACY_TAG_RE);
    if (nodeMatch || legacyMatch) {
      flush();
      if (nodeMatch) {
        pendingTag = { tagType: "content", nodeId: nodeMatch.groups?.id };
      } else if (legacyMatch) {
        pendingTag = { tagType: legacyMatch.groups?.type, nodeId: legacyMatch.groups?.id };
      }
      continue;
    }
    current.push(line);
    if (/^\s*$/.test(line)) {
      // consider paragraph boundary
      flush();
    }
  }
  flush();
  return blocks.filter((b) => b.text.trim() !== "");
}

export function emitTag(t: InlineTag): string {
  // Prefer the concise node tag format when nodeId is present.
  if (t.nodeId) {
    return `<!-- node:${t.nodeId} -->\n`;
  }
  const parts = ["<!-- ", `tag:${t.tagType ?? "content"}`, " -->"];
  return parts.join("") + "\n";
}


