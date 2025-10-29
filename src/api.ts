/**
 * Confluence Cloud REST v2 client helpers.
 *
 * Why: Centralize HTTP handling, auth headers, and core endpoints used by
 * download/upload/create commands.
 */

import { URL } from "url";

export interface ConfluenceClientOptions {
  baseUrl: string;
  email?: string;
  apiToken?: string;
  accessToken?: string; // optional bearer alternative
}

export interface PageResponseV2 {
  id: string;
  title: string;
  spaceId?: string;
  body?: { storage?: { value?: string } };
  version?: { number: number };
}

function buildAuthHeader(opts: ConfluenceClientOptions): Record<string, string> {
  if (opts.email && opts.apiToken) {
    const b64 = Buffer.from(`${opts.email}:${opts.apiToken}`).toString("base64");
    return { Authorization: `Basic ${b64}` };
  }
  if (opts.accessToken) {
    return { Authorization: `Bearer ${opts.accessToken}` };
  }
  return {};
}

export class ConfluenceClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(opts: ConfluenceClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...buildAuthHeader(opts),
    };
  }

  private buildV1(pathname: string, query: Record<string, string | number | undefined> = {}): string {
    const u = new URL("/wiki/rest/api" + pathname, this.base);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private build(pathname: string, query: Record<string, string | number | undefined> = {}): string {
    const u = new URL("/wiki" + pathname, this.base);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async getPage(pageId: string): Promise<PageResponseV2> {
    const url = this.build(`/api/v2/pages/${pageId}`);
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`getPage ${pageId} failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async getPageWithUi(pageId: string): Promise<any> {
    // Try to fetch richer metadata including icon/cover if available
    const url = this.build(`/api/v2/pages/${pageId}`, { expand: 'icon,coverImage' } as any);
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return this.getPage(pageId);
    return res.json();
  }

  async getPageStorage(pageId: string): Promise<{ title: string; storageHtml: string; version: number; spaceId?: string }>
  {
    const url = this.build(`/api/v2/pages/${pageId}`, { "body-format": "storage" });
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`getPageStorage ${pageId} failed: ${res.status} ${res.statusText}`);
    const data: PageResponseV2 = await res.json();
    const storageHtml = data?.body?.storage?.value ?? "";
    const version = data?.version?.number ?? 1;
    return { title: data.title, storageHtml, version, spaceId: data.spaceId };
  }

  async getPageAtlasDoc(pageId: string): Promise<any | undefined> {
    const url = this.build(`/api/v2/pages/${pageId}`, { "body-format": "atlas_doc_format" });
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return undefined;
    const data = await res.json();
    const adf = (data as any)?.body?.atlas_doc_format?.value;
    try {
      return typeof adf === 'string' ? JSON.parse(adf) : adf;
    } catch {
      return undefined;
    }
  }

  async getPageV1Content(pageId: string): Promise<any | undefined> {
    const url = this.buildV1(`/content/${pageId}`, {
      expand: "metadata,metadata.properties,body.storage,body.atlas_doc_format,space,version",
    });
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return undefined;
    return res.json();
  }

  async updatePageStorage(pageId: string, nextHtml: string, currentVersion: number, title?: string, spaceId?: string): Promise<void> {
    const url = this.build(`/api/v2/pages/${pageId}`);
    const payload = {
      id: pageId,
      status: "current",
      version: { number: currentVersion + 1 },
      title,
      spaceId,
      body: { storage: { value: nextHtml, representation: "storage" } },
    };
    const res = await fetch(url, { method: "PUT", headers: this.headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`updatePageStorage failed: ${res.status} ${res.statusText}\n${text}`);
    }
  }

  async createPage(spaceId: string, title: string, parentId?: string): Promise<{ id: string }>{
    const url = this.build(`/api/v2/pages`);
    const payload: any = {
      spaceId,
      title,
      body: { storage: { value: "<p></p>", representation: "storage" } },
    };
    if (parentId) payload.parentId = parentId;
    const res = await fetch(url, { method: "POST", headers: this.headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`createPage failed: ${res.status} ${res.statusText}\n${text}`);
    }
    return res.json();
  }
}

export function fromEnv(): ConfluenceClient {
  const baseUrl = process.env.CONFLUENCE_BASE_URL || process.env.CONFLUENCE_URL || "";
  if (!baseUrl) throw new Error("CONFLUENCE_BASE_URL (or CONFLUENCE_URL) must be set");
  return new ConfluenceClient({
    baseUrl,
    email: process.env.CONFLUENCE_EMAIL,
    apiToken: process.env.CONFLUENCE_API_TOKEN,
    accessToken: process.env.CONFLUENCE_ACCESS_TOKEN,
  });
}


