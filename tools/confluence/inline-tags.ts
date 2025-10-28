/**
 * Inline tag parser for mapping markdown blocks to Confluence storage node IDs.
 *
 * Tag format: `<!-- tag:tagtype nodeId:789 -->` placed immediately before block.
 */

export interface InlineTag {
  tagType?: string;
  nodeId?: string;
}

const TAG_RE = /<!--\s*tag:(?<type>[\w-]+)?\s+(?:nodeId:(?<id>[\w-:]+))\s*-->/;

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
    const m = line.match(TAG_RE);
    if (m) {
      flush();
      pendingTag = { tagType: m.groups?.type, nodeId: m.groups?.id };
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
  const parts = ["<!-- ", `tag:${t.tagType ?? "content"}`, t.nodeId ? ` nodeId:${t.nodeId}` : "", " -->"]; 
  return parts.join("") + "\n";
}


