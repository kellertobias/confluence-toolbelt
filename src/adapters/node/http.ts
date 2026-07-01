/**
 * Node HTTP adapter backed by global fetch. Used by the CLI.
 *
 * Builds multipart/form-data via the platform FormData/Blob for attachment
 * uploads. (The Obsidian adapter hand-builds the multipart body because
 * requestUrl has no FormData support.)
 */

import type { HttpClient, HttpRequest, HttpResponse } from "../../core/ports.js";

export const nodeHttp: HttpClient = {
  async request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const init: RequestInit = {
      method: req.method ?? "GET",
      headers: req.headers,
      signal: AbortSignal.timeout(30_000),
    };

    if (req.multipartFields || req.multipartFiles) {
      const form = new FormData();
      for (const [k, v] of Object.entries(req.multipartFields ?? {})) {
        form.append(k, v);
      }
      for (const f of req.multipartFiles ?? []) {
        const blob = new Blob(
          [f.data as unknown as BlobPart],
          f.contentType ? { type: f.contentType } : {},
        );
        form.append(f.field, blob, f.filename);
      }
      init.body = form;
    } else if (req.body !== undefined) {
      init.body = req.body;
    }

    const res = await fetch(url, init);
    return {
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      text: () => res.text(),
      json: () => res.json(),
      bytes: async () => new Uint8Array(await res.arrayBuffer()),
    };
  },
};
