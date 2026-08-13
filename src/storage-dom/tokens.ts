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
    // Thread bodies (`<!-- # Author: body -->`) are display-only metadata that
    // live between the comment wrappers. They must never enter Confluence
    // storage — Confluence keeps its own comment bodies keyed by ac:ref, so a
    // leaked tag would be re-added from the API on the next download and
    // compound on every round-trip. Drop them here.
    .replace(/<!--\s*#[\s\S]*?-->/g, "")
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
 * Decode a token payload.
 *
 * Payloads are always `encodeURIComponent`-ed, so a backslash can never occur
 * in one legitimately — every backslash we see was added by Turndown escaping
 * the token as it passed through a markdown conversion. Stripping them here
 * matters most for container tokens (`MD_PANEL`), whose payload is re-run
 * through Turndown: without it the nested tokens pick up a second escape layer
 * (`MD\\_CODE`) that no decoder regex matches, and a code block inside an info
 * panel silently vanishes.
 */
function decodePayload(v: unknown): string {
  return decodeURIComponent(String(v || "").replace(/\\/g, ""));
}

/** Tokens that decode into a fenced block, and therefore have to start on a
 * line of their own. */
const FENCE_TOKEN_RE = /^MD(?:\\)?_(?:CODE|MERMAID)\(/;

/**
 * Surround a decoded fenced block with the blank lines that make it a block.
 *
 * Confluence stores two code macros back to back inside one text node, so the
 * tokens arrive adjacent with nothing between them. Emitting each as
 * ` ```lang\nbody\n``` ` then glues the first block's closing fence onto the
 * second's opening one (` ``````json `), and that line is no longer a fence:
 * on the next upload the first code block stays open and swallows the second
 * one whole — its language gone, its body absorbed as text, and no warning.
 * The panel token already guards against exactly this; fenced blocks did not.
 *
 * Separators are derived from the *undecoded* string, so the pair is added
 * once rather than by both neighbours: a block followed by another fence token
 * adds nothing, leaving the next one to supply its own leading break.
 */
function asOwnBlock(
  rendered: string,
  match: string,
  offset: number,
  whole: string,
): string {
  const before = whole.slice(0, offset);
  const after = whole.slice(offset + match.length);
  const lead = before === "" || before.endsWith("\n\n")
    ? ""
    : before.endsWith("\n")
      ? "\n"
      : "\n\n";
  const trail = after === "" || after.startsWith("\n\n") || FENCE_TOKEN_RE.test(after)
    ? ""
    : after.startsWith("\n")
      ? "\n"
      : "\n\n";
  return `${lead}${rendered}${trail}`;
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
      (_m, enc) => `<!-- ${decodePayload(enc)} -->`,
    )
    .replace(
      /MD(?:\\)?_WIDGET\(([^)]+)\)/g,
      (_m, name) => `<!-- widget:${String(name).toUpperCase()} -->`,
    )
    // Inline comment start/end markers to markdown wrapper comments.
    // Handle both literal and Turndown-escaped forms (MD\_CMT\_START, etc.)
    .replace(
      /MD(?:\\)?_CMT(?:\\)?_START\(([^)]+)\)/g,
      (_m, enc) => `<!-- comment:${decodePayload(enc)} -->`,
    )
    .replace(
      /MD(?:\\)?_CMT(?:\\)?_END\(([^)]+)\)/g,
      (_m, enc) =>
        `<!-- commend-end:${decodePayload(enc)} -->`,
    )
    /**
     * Convert page link tokens to markdown links.
     * Format: `MD_PAGE_LINK~~ref~~text~~END` → `[text](ref)`
     */
    .replace(
      /MD(?:\\)?_PAGE(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, refEnc, textEnc) => {
        const pageRef = decodePayload(refEnc);
        const linkText = decodePayload(textEnc);
        return `[${linkText}](${pageRef})`;
      },
    )
    /**
     * Format: `MD_ATTACH_LINK~~filename~~text~~END` → `[text](#attachment:filename)`
     */
    .replace(
      /MD(?:\\)?_ATTACH(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, filenameEnc, textEnc) => {
        const filename = decodePayload(filenameEnc);
        const linkText = decodePayload(textEnc);
        return `[${linkText}](#attachment:${filename})`;
      },
    )
    /**
     * Format: `MD_URL_LINK~~url~~text~~END` → `[text](url)`
     */
    .replace(
      /MD(?:\\)?_URL(?:\\)?_LINK~~([^~]+)~~([^~]+)~~END/g,
      (_m, urlEnc, textEnc) => {
        const url = decodePayload(urlEnc);
        const linkText = decodePayload(textEnc);
        return `[${linkText}](${url})`;
      },
    )
    .replace(
      /MD(?:\\)?_PANEL\(([^,)]*),([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, colorEnc, iconEnc, bodyEnc) => {
        const color = decodePayload(colorEnc) || "info";
        const icon = decodePayload(iconEnc) || color;
        const innerHtml = decodePayload(bodyEnc);
        const innerMd = unescapeMarkdownUnderscores(
          decodeMdCommentTokens(turndown.turndown(innerHtml || "")),
        );
        const lines = innerMd.split(/\r?\n/);
        const outLines: string[] = [`> <!-- panel:${color}:${icon} -->`];
        for (const l of lines) {
          outLines.push(l.trim().length ? `> ${l}` : ">");
        }
        // A panel is a block. Confluence happily stores two of them back to
        // back (and puts them in one text node), so without explicit blank
        // lines the second one's preamble glues onto the first one's last line
        // and neither is recognized as a blockquote any more.
        return `\n\n${outLines.join("\n")}\n\n`;
      },
    );

  // Collapse the blank-line runs the panel separator can pile up. Done here,
  // before code/mermaid tokens are decoded, so it can never touch blank lines
  // that belong inside a fenced block.
  out = out.replace(/\n{3,}/g, "\n\n");

  out = out.replace(
      /MD(?:\\)?_STATUS\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, colorEnc, titleEnc) => {
        const color = decodePayload(colorEnc) || "grey";
        const title = decodePayload(titleEnc) || "Status";
        return `<!-- status:${color}:${title} -->`;
      },
    )
    // Jira issue link tokens → markdown links
    .replace(
      /MD(?:\\)?_JIRA(?:\\)?_LINK~~([^~]+)~~END/g,
      (_m, keyEnc) => {
        const key = decodePayload(keyEnc);
        return `[${key}](jira:${key})`;
      },
    )
    .replace(
      /MD(?:\\)?_IMAGE\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, refEnc, capEnc) => {
        const ref = decodePayload(refEnc);
        const cap = decodePayload(capEnc);
        const src = ref.startsWith("attach:") ? `#${ref.slice(7)}` : ref;
        return `![${cap || ""}](${src})`;
      },
    )
    .replace(
      /MD(?:\\)?_MENTION\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (_m, idEnc, visEnc) => {
        const id = decodePayload(idEnc);
        const vis = decodePayload(visEnc);
        const label = vis || id;
        return `<!-- mention:${id} ${label} -->`;
      },
    )
    // Expand macro markers → the paired authoring comments.
    .replace(
      /MD(?:\\)?_EXPAND(?:\\)?_START\(([^)]*)\)/g,
      (_m, titleEnc) => {
        const title = decodeURIComponent(String(titleEnc || ""));
        return title ? `<!-- expand:${title} -->` : "<!-- expand -->";
      },
    )
    .replace(/MD(?:\\)?_EXPAND(?:\\)?_END\(\)/g, () => "<!-- /expand -->")
    // Emit code blocks using fenced style ```lang\n...\n```
    .replace(
      /MD(?:\\)?_CODE\(([^)]*)\)(?:\\)?\[([\s\S]*?)(?:\\)?\]/g,
      (m, langEnc, bodyEnc, offset: number, whole: string) => {
        const lang = decodePayload(langEnc);
        const body = decodePayload(bodyEnc);
        const fence = `\`\`\`${lang ? String(lang) : ""}`;
        return asOwnBlock(`${fence}\n${body}\n\`\`\``, m, offset, whole);
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
    (m, encoded, offset: number, whole: string) => {
      const code = base64ToUtf8(String(encoded));
      return asOwnBlock(`\`\`\`mermaid\n${code}\n\`\`\``, m, offset, whole);
    },
  );

  return out;
}
