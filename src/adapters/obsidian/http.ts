/**
 * HTTP adapter backed by Obsidian's requestUrl (bypasses CORS, works on mobile).
 *
 * requestUrl has no FormData support, so attachment uploads are sent as a
 * hand-built multipart/form-data body (ArrayBuffer) with an explicit boundary.
 */

import { requestUrl } from "obsidian";

import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  MultipartFile,
} from "../../core/ports.js";

let boundarySeq = 0;

function buildMultipart(
  fields: Record<string, string>,
  files: MultipartFile[],
): { body: ArrayBuffer; contentType: string } {
  const boundary = `----ConfluenceToolsBoundary${Date.now()}x${boundarySeq++}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const f of files) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType ?? "application/octet-stream"}\r\n\r\n`,
      ),
    );
    chunks.push(f.data);
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return {
    body: out.buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export const obsidianHttp: HttpClient = {
  async request(url: string, req: HttpRequest = {}): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let body: string | ArrayBuffer | undefined = req.body;

    if (req.multipartFields || req.multipartFiles) {
      const mp = buildMultipart(req.multipartFields ?? {}, req.multipartFiles ?? []);
      body = mp.body;
      headers["Content-Type"] = mp.contentType;
    }

    const res = await requestUrl({
      url,
      method: req.method ?? "GET",
      headers,
      body,
      throw: false,
    });

    const ok = res.status >= 200 && res.status < 300;
    return {
      status: res.status,
      statusText: String(res.status),
      ok,
      text: async () => res.text,
      json: async () => {
        try {
          return res.json;
        } catch {
          return JSON.parse(res.text);
        }
      },
      bytes: async () => new Uint8Array(res.arrayBuffer),
    };
  },
};
