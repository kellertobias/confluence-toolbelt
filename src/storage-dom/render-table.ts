/**
 * Render a parsed `<table>` element back into GFM markdown.
 *
 * Three entry points:
 *   - `renderTableMarkdown` for regular tables (preserves layout hints and
 *     inline `<!-- cell:bg:... -->` markers).
 *   - `renderReqListMarkdown` for our requirement tables (rendered as a
 *     bullet list of `REQ(ID, VERB): ...` / `nREQ(...)` items).
 *   - `renderDefListMarkdown` for our definition-list tables (rendered as a
 *     `<!-- deflist ... -->` comment followed by `- KEYWORD(key): value`
 *     bullet items).
 */

import { parseHTML } from 'linkedom';

import { decodeBasicEntities, gcdNum } from './html-utils.js';
import { tableWidthToLayoutName } from './table-layout.js';
import { decodeMdCommentTokens } from './tokens.js';

/**
 * Convert a data-req-table back to a markdown bullet list of REQ/nREQ items.
 *
 * Expects a table with header [ID | Requirement] and body rows where:
 * - The verb is inside a <strong> with an inline color style
 * - Struck-through rows (<s>/<del>) produce nREQ
 */
export function renderReqListMarkdown(tableEl: Element): string {
  const rows = Array.from(tableEl.querySelectorAll('tr')) as Element[];
  const lines: string[] = [];

  for (const row of rows) {
    const cells = Array.from((row as any).querySelectorAll('td')) as Element[];
    if (cells.length < 2) {
      continue;
    }

    const idHtml = String((cells[0] as any).innerHTML || '');
    const descHtml = String((cells[1] as any).innerHTML || '');

    const strippedId = idHtml.replace(/<!--[\s\S]*?-->/g, '').trim();
    const isStruck =
      /<s\b|<del\b/i.test(strippedId) ||
      /<s\b|<del\b/i.test(descHtml.replace(/<!--[\s\S]*?-->/g, '').trim());

    const id = decodeBasicEntities(idHtml.replace(/<[^>]+>/g, '').trim());

    const verbMatch = descHtml.match(
      /<strong[^>]*\bstyle="[^"]*\bcolor\s*:[^"]*"[^>]*>([^<]+)<\/strong>/i,
    );
    const verb = (verbMatch?.[1] || '').trim();

    const desc = decodeBasicEntities(descHtml.replace(/<[^>]+>/g, '').trim());

    if (!id && !desc) {
      continue;
    }

    const prefix = isStruck ? 'nREQ' : 'REQ';
    if (verb) {
      lines.push(`- ${prefix}(${id}, ${verb}): ${desc}`);
    } else {
      lines.push(`- ${prefix}(${id}): ${desc}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert a data-deflist table back to a deflist comment + bullet list.
 *
 * Expects a table carrying `data-deflist-keyword` and `data-deflist-columns`
 * attributes. Each body row becomes a `- KEYWORD(key): value` item. Values
 * containing `<br/>` are split across indented continuation lines so the
 * original multi-line shape is preserved.
 */
export function renderDefListMarkdown(tableEl: Element): string {
  const getAttr = (name: string): string =>
    (tableEl as any).getAttribute?.(name) || '';
  const keyword = getAttr('data-deflist-keyword') || 'KEY';
  const columnsAttr = getAttr('data-deflist-columns');
  const columns = columnsAttr
    ? columnsAttr
        .split(',')
        .map((c: string) => c.trim())
        .filter(Boolean)
    : [];

  // Preserve column labels as they appear in the comment. Quote values that
  // contain spaces or commas so the parser can recover them unambiguously.
  const quotedColumns = needsQuoting(columnsAttr)
    ? `"${columnsAttr}"`
    : columnsAttr;
  const configLine = `<!-- deflist keyword="${keyword}" columns=${quotedColumns || columns.join(',')} -->`;

  const rows = Array.from(tableEl.querySelectorAll('tbody tr')) as Element[];
  // Fallback for tables without an explicit tbody.
  const fallbackRows =
    rows.length === 0
      ? (Array.from(tableEl.querySelectorAll('tr')) as Element[]).filter(
          (r) => (r.querySelector('td') as Element | null) !== null,
        )
      : rows;

  const lines: string[] = [configLine];

  for (const row of fallbackRows) {
    const cells = Array.from((row as any).querySelectorAll('td')) as Element[];
    if (cells.length < 2) {
      continue;
    }

    const keyHtml = String((cells[0] as any).innerHTML || '');
    const valueHtml = String((cells[1] as any).innerHTML || '');

    const key = decodeBasicEntities(
      keyHtml
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .trim(),
    );

    const valueText = extractMultilineCellText(valueHtml);

    if (!valueText) {
      lines.push(`- ${keyword}(${key}):`);
      continue;
    }

    const valueLines = valueText.split('\n');
    const firstLine = valueLines[0] || '';
    lines.push(`- ${keyword}(${key}): ${firstLine}`);
    for (let j = 1; j < valueLines.length; j++) {
      lines.push(`  ${valueLines[j]}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert an HTML cell body into plain text, mapping `<br/>` (and a few other
 * block boundaries) to actual newlines so we can split multi-line values back
 * into continuation lines.
 */
function extractMultilineCellText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|li)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeBasicEntities(text);
  // Some cells encode newlines as the literal two-char `\n` escape (see how
  // `render-table` emits them for regular GFM tables); normalize those too.
  text = text.replace(/\\n/g, '\n');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l, idx, arr) => !(l === '' && (idx === 0 || idx === arr.length - 1)),
    )
    .join('\n')
    .trim();
}

function needsQuoting(value: string): boolean {
  return /[\s]/.test(value);
}

export function renderTableMarkdown(tableEl: Element): string {
  // Extract table width: prefer data-table-width (pixel), fall back to legacy
  // data-layout.
  const tableWidthAttr =
    (tableEl as any).getAttribute?.('data-table-width') || '';
  const tableWidthPx = tableWidthAttr ? parseInt(tableWidthAttr, 10) : 0;

  const legacyLayout = (
    (tableEl as any).getAttribute?.('data-layout') || ''
  ).toLowerCase();
  const legacyLayoutMap: Record<string, string> = {
    'full-width': 'full',
    wide: 'wider',
  };

  let mappedLayout = '';
  if (tableWidthPx > 0) {
    mappedLayout = tableWidthToLayoutName(tableWidthPx);
    if (mappedLayout === 'content') {
      mappedLayout = '';
    }
  } else if (legacyLayoutMap[legacyLayout]) {
    mappedLayout = legacyLayoutMap[legacyLayout] || '';
  }

  const colEls = Array.from(tableEl.querySelectorAll('col')) as Element[];
  const colPixelWidths = colEls
    .map((col) => {
      const style = (col as any).getAttribute?.('style') || '';
      const m = style.match(/width:\s*([\d.]+)/);
      return m ? parseFloat(m[1]) : 0;
    })
    .filter((w) => w > 0);

  let shares: number[] = [];
  if (colPixelWidths.length > 0) {
    const rounded = colPixelWidths.map((w) => Math.round(w));
    const g = rounded.reduce((a, b) => gcdNum(a, b));
    shares = rounded.map((w) => w / g);
    if (shares.every((s) => s === shares[0])) {
      shares = [];
    }
  }

  let configComment = '';
  if (mappedLayout) {
    configComment = `<!-- table:${mappedLayout}`;
    if (shares.length > 0) {
      configComment += ` ${shares.join(',')}`;
    }
    configComment += ' -->';
  } else if (shares.length > 0) {
    configComment = `<!-- table:content ${shares.join(',')} -->`;
  }

  // Build GFM table; preserve inline HTML comments inside cells.
  const rows = Array.from(tableEl.querySelectorAll('tr')) as Element[];
  if (rows.length === 0) {
    return '';
  }
  const matrix: string[][] = rows.map((tr) => {
    const cells = Array.from(tr.querySelectorAll('th,td')) as Element[];
    return cells.map((cell) =>
      getCellTextWithComments(cell).trim().replace(/\s+/g, ' '),
    );
  });
  const colCount = Math.max(0, ...matrix.map((r) => r.length));
  const lines: string[] = [];
  const first = matrix[0] || [];
  const header = first.concat(
    Array(Math.max(0, colCount - first.length)).fill(''),
  );
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${new Array(colCount).fill('---').join(' | ')} |`);
  for (let i = 1; i < matrix.length; i++) {
    const rowBase = matrix[i] || [];
    const row = rowBase.concat(
      Array(Math.max(0, colCount - rowBase.length)).fill(''),
    );
    lines.push(`| ${row.join(' | ')} |`);
  }
  const tableOut = lines.join('\n');
  const decoded = decodeMdCommentTokens(tableOut);
  if (configComment) {
    return `${configComment}\n${decoded}`;
  }
  return decoded;
}

function getCellTextWithComments(cell: Element): string {
  let html = String((cell as any).innerHTML || '');
  // Detect if cell content is struck through (<s> or <del> wrapping).
  const strippedForDetect = html.replace(/<!--[\s\S]*?-->/g, '').trim();
  const cellIsStrikethrough =
    /^<p[^>]*><(?:s|del)[^>]*>[\s\S]*<\/(?:s|del)><\/p>$/i.test(
      strippedForDetect,
    ) || /^<(?:s|del)[^>]*>[\s\S]*<\/(?:s|del)>$/i.test(strippedForDetect);
  // Strip <s>/<del> tags (content kept; strike formatting dropped — the nREQ
  // token handles the semantics).
  html = html.replace(/<\/?(?:s|del)\b[^>]*>/gi, '');

  // Extract styling color markers encoded as MD_COMMENT tokens or real comments.
  let styleColor: string | undefined;
  html = html.replace(/MD_COMMENT\(([^)]+)\)/g, (_m, enc) => {
    const comment = decodeURIComponent(String(enc));
    const m = comment.match(/^(?:table|cell):bg:([#a-z0-9_-]+)$/i);
    if (m) {
      styleColor = String(m[1]).toLowerCase();
      return '';
    }
    // keep non-style comments as tokens for later global decoding
    return `MD_COMMENT(${encodeURIComponent(comment)})`;
  });
  html = html.replace(
    /<!--\s*(?:table|cell):bg:([#a-z0-9_-]+)\s*-->/gi,
    (_m, color) => {
      styleColor = String(color).toLowerCase();
      return '';
    },
  );

  // Convert block/line-break tags to newlines, then strip remaining tags.
  html = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h\d)>/gi, '\n');
  let text = html.replace(/<[^>]+>/g, '');
  text = decodeBasicEntities(text);
  /**
   * Encode line breaks in table cells as literal \n escape sequences.
   *
   * Why: Table cells in markdown are single-line; actual newlines would break
   * the GFM table structure. We encode them as the literal two-character
   * sequence \n so they survive round-trips and can be decoded to <br/> on
   * upload.
   */
  text = text.replace(/\r?\n/g, '\\n');
  // Strip trailing literal \n escapes that come from closing </p> or </li>.
  text = text.replace(/(\\n)+$/, '');
  // Collapse consecutive spaces to a single space.
  text = text.replace(/[ \t]+/g, ' ').trim();
  if (cellIsStrikethrough) {
    text = text.replace(/\bREQ\s*\(/g, 'nREQ(');
  }
  if (styleColor) {
    text = text.length
      ? `${text} <!-- cell:bg:${styleColor} -->`
      : `<!-- cell:bg:${styleColor} -->`;
  }
  return text;
}

/**
 * Replace `MD_TABLE(<index>)` tokens (emitted by the fallback path in
 * `storageToMarkdownBlocks`) with the rendered GFM for the table at that
 * index.
 */
export function replaceTableTokens(markdown: string, tables: string[]): string {
  return markdown.replace(/MD(?:\\)?_TABLE\((\d+)\)/g, (_m, num) => {
    const i = Number(num);
    const html = tables[i] || '';
    const { document } = parseHTML(html);
    const table = document.querySelector('table') as Element | null;
    if (!table) {
      return '';
    }
    return `\n${renderTableMarkdown(table)}\n`;
  });
}
