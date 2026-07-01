/**
 * Durable MD_* token helpers.
 *
 * During conversion we replace Confluence-specific constructs (mentions,
 * inline comments, panels, images, code, etc.) with literal `MD_*` tokens so
 * they survive Turndown's HTML-to-markdown pass without being escaped or
 * mangled. These helpers cover both directions:
 *
 *   - `replace*CommentsWithTokens` / `replaceMentionTokensWithMacros` etc.
 *     translate between HTML-comment tags and durable tokens.
 *   - `decodeMdCommentTokens` turns tokens back into markdown (or Confluence
 *     storage) after the Turndown pass.
 */

import { base64ToUtf8 } from "../core/b64.js";
import { escapeHtml } from "./html-utils.js";
import { unescapeMarkdownUnderscores } from "./markdown-escapes.js";
import { turndown } from "./turndown.js";

/**
 * Replace mention HTML comments with durable tokens.
 *
 * Input example:  `<!-- mention:ACCOUNT_ID Display Name -->`
 * Output:         `MD_MENTION(<encoded-account-id>)`
 */
export function replaceMentionCommentsWithTokens(s: string): string {
  return s.replace(
    /<!--\s*mention:([^\s>]+)\s+([\s\S]*?)\s*-->/g,
    (_m, idRaw, labelRaw) => {
      const id = String(idRaw || "");
      const label = String(labelRaw || "");
      const accountId = selectAccountId(id, label);
      return `MD_MENTION(${encodeURIComponent(accountId)})`;
    },
  );
}

/**
 * Replace our markdown comment wrappers with durable tokens.
 *
 * Input examples:
 *   `<!-- comment:c1 -->`      → `MD_CMT_START(c1)`
 *   `<!-- commend-end:c1 -->`  → `MD_CMT_END(c1)`
 */
export function replaceCommentWrapperCommentsWithTokens(s: string): string {
  return s
    .replace(
      /<!--\s*comment:([^\s>]+)\s*-->/g,
      (_m, id) => `MD_CMT_START(${encodeURIComponent(String(id || ""))})`,
    )
    .replace(
      /<!--\s*commend-end:([^\s>]+)\s*-->/g,
      (_m, id) => `MD_CMT_END(${encodeURIComponent(String(id || ""))})`,
    );
}

/**
 * Render durable mention tokens as Confluence user mention macros.
 *
 * Supports both the bare `MD_MENTION(id)` form and the label-annotated
 * `MD_MENTION(id)[label]` form.
 */
export function replaceMentionTokensWithMacros(s: string): string {
  return s
    .replace(/MD(?:\\)?_MENTION\(([^)]+)\)(?:\\)?\[[^\]]*\]/g, (_m, encId) => {
      const accountId = decodeURIComponent(String(encId || ""));
      return `<ac:atlassian-user ac:account-id="${escapeHtml(accountId)}"/>`;
    })
    .replace(/MD(?:\\)?_MENTION\(([^)]+)\)/g, (_m, encId) => {
      const accountId = decodeURIComponent(String(encId || ""));
      return `<ac:atlassian-user ac:account-id="${escapeHtml(accountId)}"/>`;
    });
}

/**
 * Wrap `MD_CMT_START(id) ... MD_CMT_END(id)` spans into a single inline marker
 * element `<ac:inline-comment-marker ac:ref="id">innerHTML</ac:inline-comment-marker>`.
 *
 * Handles multiple pairs per string and drops any unbalanced start/end tokens
 * that might remain.
 */
export function wrapCommentTokenRangesToInlineMarkers(s: string): string {
  let out = s;
  // Replace repeatedly until no more pairs are found (supports multiple ranges).
  // Non-greedy inner to keep the shortest span for the same id.
  const pairRe =
    /MD(?:\\)?_CMT_START\(([^)]+)\)([\s\S]*?)MD(?:\\)?_CMT_END\(\1\)/g;
  let prev: string | undefined;
  do {
    prev = out;
    out = out.replace(pairRe, (_m, encId, inner) => {
      const id = decodeURIComponent(String(encId || ""));
      return `<ac:inline-comment-marker ac:ref="${escapeHtml(id)}">${inner}</ac:inline-comment-marker>`;
    });
  } while (out !== prev);
  // Drop any stray start/end tokens that might remain (unbalanced cases)
  out = out.replace(/MD(?:\\)?_CMT_START\(([^)]+)\)/g, "");
  out = out.replace(/MD(?:\\)?_CMT_END\(([^)]+)\)/g, "");
  return out;
}

/**
 * Heuristic to select the correct Atlassian account ID from compound inputs
 * like "siteId:accountId". Prefers UUID-looking tokens, then the last segment.
 */
function selectAccountId(id: string, label: string): string {
  const candidates: string[] = [];
  const add = (v?: string) => {
    if (v && !candidates.includes(v)) {
      candidates.push(v);
    }
  };
  add(id);
  add(label);
  add(id.split(":").pop() || id);
  add(label.split(":").pop() || label);
  const uuid = candidates.find((c) =>
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(c),
  );
  if (uuid) {
    return uuid;
  }
  return id.split(":").pop() || id;
}

/**
 * Decode all durable MD_* tokens back into markdown / Confluence storage.
 *
 * This is the inverse of `normalizeMacros` (for read paths) and the final
 * step after Turndown has converted the HTML body. Handles comments,
 * widgets, inline comment markers, page/attachment/URL links, panels, status,
 * images, mentions, code blocks, and mermaid diagrams.
 */
export function decodeMdCommentTokens(s: string): string {
  let out = s
    .replace(
      /MD(?:\\)?_COMMENT\(([^)]+)\)/g,
      (_m, enc) => `<!-- ${decodeURIComponent(String(enc))} -->`,
    )
    .replace(
      /MD(?:\\)?_WIDGET\(([^)]+)\)/g,
      (_m, name) => `<!-- widget:${String(name).toUpperCase()} -->`,
    )
    // Inline comment start/end markers to markdown wrapper comments.
    // Handle both literal and Turndown-escaped forms (MD\_CMT\_START, etc.)
    .replace(
      /MD(?:\\)?_CMT(?:\\)?_START\(([^)]+)\)/g,
      (_m, enc) => `<!-- comment:${decodeURIComponent(String(enc || ""))} -->`,
    )
    .replace(
      /MD(?:\\)?_CMT(?:\\)?_END\(([^)]+)\)/g,
      (_m, enc) =>
        `<!-- commend-end:${decodeURIComponent(String(enc || ""))} -->`,
    )
    /**
     * Convert page link tokens to markdown links.
     * Format: `MD_PAGE_LINK~~ref~~text~~END` → `[text](ref)`
     */
    .replace(
      /MD(?:\\)?_PAGE(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, refEnc, textEnc) => {
        const pageRef = decodeURIComponent(String(refEnc || ""));
        const linkText = decodeURIComponent(String(textEnc || ""));
        return `[${linkText}](${pageRef})`;
      },
    )
    /**
     * Format: `MD_ATTACH_LINK~~filename~~text~~END` → `[text](#attachment:filename)`
     */
    .replace(
      /MD(?:\\)?_ATTACH(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, filenameEnc, textEnc) => {
        const filename = decodeURIComponent(String(filenameEnc || ""));
        const linkText = decodeURIComponent(String(textEnc || ""));
        return `[${linkText}](#attachment:${filename})`;
      },
    )
    /**
     * Format: `MD_URL_LINK~~url~~text~~END` → `[text](url)`
     */
    .replace(
      /MD(?:\\)?_URL(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, urlEnc, textEnc) => {
        const url = decodeURIComponent(String(urlEnc || ""));
        const linkText = decodeURIComponent(String(textEnc || ""));
        return `[${linkText}](${url})`;
      },
    )
    .replace(
      /MD(?:\\)?_PANEL\(([^,)]*),([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, colorEnc, iconEnc, bodyEnc) => {
        const color = decodeURIComponent(String(colorEnc || "")) || "info";
        const icon = decodeURIComponent(String(iconEnc || "")) || color;
        const innerHtml = decodeURIComponent(String(bodyEnc || ""));
        const innerMd = unescapeMarkdownUnderscores(
          decodeMdCommentTokens(turndown.turndown(innerHtml || "")),
        );
        const lines = innerMd.split(/\r?\n/);
        const outLines: string[] = [`> <!-- panel:${color}:${icon} -->`];
        for (const l of lines) {
          outLines.push(l.trim().length ? `> ${l}` : ">");
        }
        return outLines.join("\n");
      },
    )
    .replace(
      /MD(?:\\)?_STATUS\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, colorEnc, titleEnc) => {
        const color = decodeURIComponent(String(colorEnc || "")) || "grey";
        const title = decodeURIComponent(String(titleEnc || "")) || "Status";
        return `<!-- status:${color}:${title} -->`;
      },
    )
    // Jira issue link tokens → markdown links
    .replace(
      /MD(?:\\)?_JIRA(?:\\)?_LINK~~([^~]+)~~END/g,
      (_m, keyEnc) => {
        const key = decodeURIComponent(String(keyEnc || ""));
        return `[${key}](jira:${key})`;
      },
    )
    .replace(
      /MD(?:\\)?_IMAGE\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, refEnc, capEnc) => {
        const ref = decodeURIComponent(String(refEnc || ""));
        const cap = decodeURIComponent(String(capEnc || ""));
        const src = ref.startsWith("attach:") ? `#${ref.slice(7)}` : ref;
        return `![${cap || ""}](${src})`;
      },
    )
    .replace(
      /MD(?:\\)?_MENTION\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, idEnc, visEnc) => {
        const id = decodeURIComponent(String(idEnc || ""));
        const vis = decodeURIComponent(String(visEnc || ""));
        const label = vis || id;
        return `<!-- mention:${id} ${label} -->`;
      },
    )
    // Emit code blocks using fenced style ```lang\n...\n```
    .replace(
      /MD(?:\\)?_CODE\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, langEnc, bodyEnc) => {
        const lang = decodeURIComponent(String(langEnc || ""));
        const body = decodeURIComponent(String(bodyEnc || ""));
        const fence = `\`\`\`${lang ? String(lang) : ""}`;
        return `${fence}\n${body}\n\`\`\``;
      },
    );

  // Normalize spacing around comment wrappers so they don't glue to words.
  // Use [ \t] instead of \s to avoid collapsing newlines (e.g. in panel output).
  out = out
    .replace(/(\S)<!--[ \t]*comment:/g, "$1 <!-- comment:")
    .replace(/(\S)<!--[ \t]*commend-end:/g, "$1 <!-- commend-end:")
    .replace(/-->[ \t]*(\S)/g, "--> $1");

  // Mermaid diagram tokens → fenced mermaid block (after spacing normalization
  // to avoid mangling decoded content like -->> in sequence diagrams).
  out = out.replace(
    /MD(?:\\)?_MERMAID\(([A-Za-z0-9+/=]+)\)/g,
    (_m, encoded) => {
      const code = base64ToUtf8(String(encoded));
      return `\`\`\`mermaid\n${code}\n\`\`\``;
    },
  );

  return out;
}
