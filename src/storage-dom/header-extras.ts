/**
 * Extract header extras (emoji / status / image) from a page's storage HTML.
 *
 * Heuristics:
 * - Emoji: shortcode `:name:` at start of title, or a leading unicode emoji.
 * - Status: the first Confluence Status macro, mapped to "color:Title".
 * - Image: first `<ri:url>` or `<img src>` in the body.
 */

const LEADING_EMOJI_TO_SHORTCODE: Record<string, string> = {
  "🚀": "rocket",
  "🔥": "fire",
  "✅": "white_check_mark",
  "⚠️": "warning",
  "🐛": "bug",
  "📌": "pushpin",
  "📷": "camera",
  "⭐": "star",
};

export function extractHeaderExtrasFromStorage(
  storageHtml: string,
  title: string,
): { emoji?: string; status?: string; image?: string } {
  const out: { emoji?: string; status?: string; image?: string } = {};

  const emojiShort = title?.match(/^:([a-z0-9_+-]+):\s*/i);
  if (emojiShort?.[1]) {
    out.emoji = emojiShort[1].toLowerCase();
  } else {
    const uni = title?.match(
      /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u,
    );
    const ch = uni?.[1];
    if (ch) {
      out.emoji = LEADING_EMOJI_TO_SHORTCODE[ch] || ch;
    }
  }

  const statusBlock = storageHtml.match(
    /<ac:structured-macro[^>]*\bac:name=["']status["'][^>]*>([\s\S]*?)<\/ac:structured-macro>/i,
  );
  if (statusBlock) {
    const inner = statusBlock[1] || "";
    const titleParam = inner.match(
      /<ac:parameter[^>]*\bac:name=["']title["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
    );
    const colourParam = inner.match(
      /<ac:parameter[^>]*\bac:name=["'](?:colour|color)["'][^>]*>([\s\S]*?)<\/ac:parameter>/i,
    );
    const label = (titleParam?.[1] || "").replace(/<[^>]+>/g, "").trim();
    const color = (colourParam?.[1] || "")
      .replace(/<[^>]+>/g, "")
      .trim()
      .toLowerCase();
    if (label || color) {
      out.status = `${color || "grey"}:${label || "Status"}`;
    }
  }

  const riUrl = storageHtml.match(
    /<ri:url[^>]*\bri:value=["']([^"']+)["'][^>]*>/i,
  );
  if (riUrl?.[1]) {
    out.image = riUrl[1];
  }
  if (!out.image) {
    const imgSrc = storageHtml.match(/<img[^>]*\bsrc=["']([^"']+)["'][^>]*>/i);
    if (imgSrc?.[1]) {
      out.image = imgSrc[1];
    }
  }

  return out;
}
