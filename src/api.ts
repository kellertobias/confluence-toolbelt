/**
 * Confluence Cloud REST v2 client helpers.
 *
 * Why: Centralize HTTP handling, auth headers, and core endpoints used by
 * download/upload/create commands.
 */

import { URL } from "node:url";

export interface ConfluenceClientOptions {
  baseUrl: string;
  email?: string;
  apiToken?: string;
  accessToken?: string; // optional bearer alternative
  debug?: boolean;
}

export interface PageResponseV2 {
  id: string;
  title: string;
  spaceId?: string;
  parentId?: string;
  parentType?: string;
  body?: { storage?: { value?: string } };
  version?: { number: number };
}

function buildAuthHeader(
  opts: ConfluenceClientOptions,
): Record<string, string> {
  if (opts.email && opts.apiToken) {
    const b64 = Buffer.from(`${opts.email}:${opts.apiToken}`).toString(
      "base64",
    );
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
  private readonly authHeaders: Record<string, string>;
  private readonly debug: boolean;

  constructor(opts: ConfluenceClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.debug = opts.debug ?? false;
    this.authHeaders = buildAuthHeader(opts);
    this.headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...this.authHeaders,
    };
  }

  private dbg(msg: string): void {
    if (this.debug) {
      console.log(`[debug:api] ${msg}`);
    }
  }

  private async fetchWithDebug(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const relPath = url.replace(this.base, "");
    const bodyLen = init.body ? String(init.body).length : 0;
    this.dbg(
      `→ ${method} ${relPath}${bodyLen ? ` (body ${bodyLen} bytes)` : ""}`,
    );
    const t = Date.now();
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    this.dbg(`← ${res.status} ${res.statusText} in ${Date.now() - t}ms`);
    return res;
  }

  private buildV1(
    pathname: string,
    query: Record<string, string | number | undefined> = {},
  ): string {
    const u = new URL(`/wiki/rest/api${pathname}`, this.base);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private build(
    pathname: string,
    query: Record<string, string | number | undefined> = {},
  ): string {
    const u = new URL(`/wiki${pathname}`, this.base);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  async getPage(pageId: string): Promise<PageResponseV2> {
    const url = this.build(`/api/v2/pages/${pageId}`);
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(
        `getPage ${pageId} failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json();
  }

  async getPageWithUi(pageId: string): Promise<any> {
    // Try to fetch richer metadata including icon/cover if available
    const url = this.build(`/api/v2/pages/${pageId}`, {
      expand: "icon,coverImage",
    } as any);
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      return this.getPage(pageId);
    }
    return res.json();
  }

  async getPageStorage(pageId: string): Promise<{
    title: string;
    storageHtml: string;
    version: number;
    spaceId?: string;
  }> {
    const url = this.build(`/api/v2/pages/${pageId}`, {
      "body-format": "storage",
    });
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `getPageStorage ${pageId} failed: ${res.status} ${res.statusText}\n${body.slice(0, 300)}`,
      );
    }
    const data: PageResponseV2 = await res.json();
    const storageHtml = data?.body?.storage?.value ?? "";
    const version = data?.version?.number ?? 1;
    this.dbg(
      `  page title="${data.title}" version=${version} storageHtml=${storageHtml.length} chars`,
    );
    return { title: data.title, storageHtml, version, spaceId: data.spaceId };
  }

  async getPageAtlasDoc(pageId: string): Promise<any | undefined> {
    const url = this.build(`/api/v2/pages/${pageId}`, {
      "body-format": "atlas_doc_format",
    });
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      return undefined;
    }
    const data = await res.json();
    const adf = (data as any)?.body?.atlas_doc_format?.value;
    try {
      return typeof adf === "string" ? JSON.parse(adf) : adf;
    } catch {
      return undefined;
    }
  }

  async getPageV1Content(pageId: string): Promise<any | undefined> {
    const url = this.buildV1(`/content/${pageId}`, {
      expand:
        "metadata,metadata.properties,body.storage,body.atlas_doc_format,space,version",
    });
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      return undefined;
    }
    return res.json();
  }

  async getPageSpaceKey(pageId: string): Promise<string | undefined> {
    try {
      const url = this.buildV1(`/content/${pageId}`, { expand: "space" });
      const res = await this.fetchWithDebug(url, { headers: this.headers });
      if (!res.ok) return undefined;
      const data = await res.json();
      return (data?.space?.key as string | undefined) || undefined;
    } catch {
      return undefined;
    }
  }

  async getPageComments(pageId: string): Promise<any[]> {
    const url = this.buildV1(`/content/${pageId}/descendant/comment`, {
      expand: "history,version,body.view,extensions.inlineProperties,extensions.resolution,ancestors",
      limit: 100,
    });
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    const results: any[] = data.results || [];
    // Exclude resolved inline comments — they should not appear in downloaded markdown.
    return results.filter(
      (c) => c.extensions?.resolution?.status !== "resolved",
    );
  }

  async updatePageStorage(
    pageId: string,
    nextHtml: string,
    currentVersion: number,
    title?: string,
    spaceId?: string,
  ): Promise<void> {
    const url = this.build(`/api/v2/pages/${pageId}`);
    const payload = {
      id: pageId,
      status: "current",
      version: { number: currentVersion + 1 },
      title,
      spaceId,
      body: { storage: { value: nextHtml, representation: "storage" } },
    };
    this.dbg(
      `  updatePageStorage pageId=${pageId} title="${title}" version=${currentVersion + 1} html=${nextHtml.length} chars`,
    );
    const res = await this.fetchWithDebug(url, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `updatePageStorage failed: ${res.status} ${res.statusText}\n${text}`,
      );
    }
  }

  get baseUrl(): string {
    return this.base;
  }

  /**
   * Full-text search using CQL, restricted to pages.
   * Returns at most `limit` results including an excerpt of matching text.
   */
  async searchPages(
    query: string,
    limit = 5,
  ): Promise<
    Array<{
      id: string;
      title: string;
      spaceKey: string;
      webUiPath: string;
      excerpt: string;
    }>
  > {
    const cql = `type=page AND text~"${query.replace(/"/g, '\\"')}"`;
    const url = this.buildV1("/search", {
      cql,
      limit,
      excerpt: "indexed",
      expand: "space",
    });
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `searchPages failed: ${res.status} ${res.statusText}\n${body.slice(0, 300)}`,
      );
    }
    const data = await res.json();
    return ((data as any).results ?? []).map((r: any) => {
      const webUiPath = String(r.url ?? r.content?._links?.webui ?? "");
      const spaceFromPath = webUiPath.match(/\/spaces\/([^/]+)\//)?.[1] ?? "";
      return {
        id: String(r.content?.id ?? ""),
        title: String(r.title ?? r.content?.title ?? ""),
        spaceKey: String(
          r.space?.key ?? r.content?.space?.key ?? spaceFromPath,
        ),
        webUiPath,
        excerpt: String(r.excerpt ?? ""),
      };
    });
  }

  /**
   * Look up a page by space key and title. Returns null if not found.
   * Used during download to resolve title-based page links to stable IDs.
   */
  async getPageByTitle(
    spaceKey: string,
    title: string,
  ): Promise<{ id: string; title: string } | null> {
    const url = this.buildV1("/content", {
      type: "page",
      spaceKey,
      title,
      expand: "version",
    });
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    const result = data?.results?.[0];
    if (!result) {
      return null;
    }
    return { id: String(result.id), title: String(result.title) };
  }

  async createPage(
    spaceId: string,
    title: string,
    parentId?: string,
  ): Promise<{ id: string }> {
    const url = this.build(`/api/v2/pages`);
    const payload: any = {
      spaceId,
      title,
      body: { storage: { value: "<p></p>", representation: "storage" } },
    };
    if (parentId) {
      payload.parentId = parentId;
    }
    const res = await this.fetchWithDebug(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `createPage failed: ${res.status} ${res.statusText}\n${text}`,
      );
    }
    return res.json();
  }

  /**
   * Find an existing attachment on a page by exact filename.
   *
   * Why: Confluence keys attachments by filename per page. Before uploading we
   * check whether one already exists so we can add a new version instead of
   * failing on a duplicate name.
   *
   * Returns the attachment id, or null when none matches.
   */
  async findAttachment(
    pageId: string,
    filename: string,
  ): Promise<{ id: string } | null> {
    const url = this.buildV1(`/content/${pageId}/child/attachment`, {
      filename,
      limit: 50,
    });
    const res = await this.fetchWithDebug(url, { headers: this.headers });
    if (!res.ok) {
      return null;
    }
    const data = await res.json().catch(() => ({}) as any);
    const results: any[] = (data as any)?.results ?? [];
    const match = results.find((r) => r?.title === filename) ?? undefined;
    return match ? { id: String(match.id) } : null;
  }

  /**
   * Upload (create or update) a binary attachment on a page.
   *
   * Why: Local images referenced in markdown must live on the page as
   * attachments for `<ri:attachment>` references to render. Re-uploading the
   * same filename should update it in place rather than fail.
   *
   * How: If an attachment with this filename already exists, POST the new bytes
   * to its `/data` endpoint (creating a new version); otherwise POST a fresh
   * attachment. Both use multipart/form-data and the `X-Atlassian-Token:
   * nocheck` header to bypass Confluence's XSRF guard.
   */
  async uploadAttachment(
    pageId: string,
    filename: string,
    data: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void> {
    const existing = await this.findAttachment(pageId, filename);

    const form = new FormData();
    const blob = new Blob(
      [data as unknown as BlobPart],
      contentType ? { type: contentType } : {},
    );
    form.append("file", blob, filename);
    form.append("minorEdit", "true");

    const pathname = existing
      ? `/content/${pageId}/child/attachment/${existing.id}/data`
      : `/content/${pageId}/child/attachment`;
    const url = this.buildV1(pathname);

    const headers: Record<string, string> = {
      ...this.authHeaders,
      Accept: "application/json",
      "X-Atlassian-Token": "nocheck",
    };

    const res = await this.fetchWithDebug(url, {
      method: "POST",
      headers,
      body: form as any,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `uploadAttachment ${filename} failed: ${res.status} ${res.statusText}\n${text.slice(0, 300)}`,
      );
    }
  }
}

export function fromEnv(debug = false): ConfluenceClient {
  const baseUrl =
    process.env.CONFLUENCE_BASE_URL || process.env.CONFLUENCE_URL || "";
  if (!baseUrl) {
    throw new Error("CONFLUENCE_BASE_URL (or CONFLUENCE_URL) must be set");
  }
  return new ConfluenceClient({
    baseUrl,
    email: process.env.CONFLUENCE_EMAIL,
    apiToken: process.env.CONFLUENCE_API_TOKEN,
    accessToken: process.env.CONFLUENCE_ACCESS_TOKEN,
    debug,
  });
}
