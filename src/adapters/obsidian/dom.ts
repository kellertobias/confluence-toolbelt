/**
 * DOM adapter backed by the renderer's native DOMParser (desktop + mobile).
 *
 * DOMParser always synthesizes <html>/<head>/<body>, so a fragment OR a full
 * `<html><body>…` string both yield the same `body`. We return the live
 * `document` too because the partial-update path (replaceNodesById) needs
 * createElement on the owning document.
 */

import type { DomAdapter, ParsedHtml } from "../../core/ports.js";

export const browserDom: DomAdapter = {
  parse(html: string): ParsedHtml {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { document: doc, body: doc.body };
  },
};
