/**
 * Node DOM adapter backed by linkedom. Used by the CLI and the unit tests.
 */

import { parseHTML } from "linkedom";

import type { DomAdapter, ParsedHtml } from "../../core/ports.js";

export const nodeDom: DomAdapter = {
  parse(html: string): ParsedHtml {
    const { document } = parseHTML(html);
    return { document, body: document.body };
  },
};
