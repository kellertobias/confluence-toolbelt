/**
 * Platform adapter interfaces (ports) for the shared conversion/sync core.
 *
 * Why: the core must run unchanged in two hosts — the Node CLI and the Obsidian
 * plugin (Electron renderer + mobile). Anything platform-specific (DOM parsing,
 * file I/O, hashing, HTTP, git, interactive prompts) is injected through these
 * interfaces so the core itself imports zero node built-ins and bundles for the
 * browser. The CLI supplies node-backed adapters; the plugin supplies
 * Obsidian/Web-API-backed adapters.
 */

/** A parsed HTML document plus its body element, abstracting linkedom vs the
 * renderer's native DOMParser. Implementations must return a `body` whose
 * `ownerDocument`/`document` can create and replace child nodes (used by the
 * partial-update path). */
export interface ParsedHtml {
  /** The owning document — used for createElement during DOM mutation. */
  document: any;
  /** The <body> element to iterate / mutate. */
  body: any;
}

export interface DomAdapter {
  /** Parse a storage-HTML fragment and return `{ document, body }`. The
   * fragment may be a bare text token with no tags; implementations must still
   * yield a valid body element. Implementations must NOT require the caller to
   * pre-wrap the fragment in <html><body>. */
  parse(html: string): ParsedHtml;
}

/** Minimal async filesystem surface backed by node:fs/promises (CLI) or the
 * Obsidian Vault DataAdapter (plugin). All paths are host-native: absolute for
 * the CLI, vault-relative POSIX for the plugin. */
export interface FileSystem {
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, data: string): Promise<void>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Create a directory (parent must exist; no-op if it already does). */
  mkdir(path: string): Promise<void>;
  /** Delete a file. */
  remove(path: string): Promise<void>;
  /** List immediate child paths of a directory (files + folders). */
  list(dir: string): Promise<string[]>;
}

/** Path utilities. node:path on the CLI; a tiny POSIX implementation on mobile
 * (Obsidian vault paths are always POSIX-relative). */
export interface PathUtil {
  join(...parts: string[]): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  extname(p: string): string;
}

export interface Hasher {
  /** SHA-256 of the bytes as lowercase hex. Async because Web Crypto's
   * subtle.digest is async. */
  sha256Hex(data: Uint8Array): Promise<string>;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<any>;
  /** Raw response body, for binary downloads (attachments). */
  bytes(): Promise<Uint8Array>;
}

export interface MultipartFile {
  field: string;
  filename: string;
  data: Uint8Array;
  contentType?: string;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  /** JSON/text body. Mutually exclusive with `multipart`. */
  body?: string;
  /** Multipart form fields (text) + files. The adapter builds the body and
   * sets the Content-Type boundary. Used only for attachment upload. */
  multipartFields?: Record<string, string>;
  multipartFiles?: MultipartFile[];
}

/** HTTP transport. CLI wraps global fetch; plugin wraps Obsidian `requestUrl`
 * (bypasses CORS, works on mobile). The multipart path exists because
 * `requestUrl` has no FormData support. */
export interface HttpClient {
  request(url: string, req?: HttpRequest): Promise<HttpResponse>;
}

/** Version-control surface. simple-git on the CLI; a no-op on mobile (where the
 * sidecar base replaces git history). `show` returns null when unavailable so
 * callers fall back to the sidecar. */
export interface Git {
  show(ref: string): Promise<string | null>;
  listChangedMarkdown(): Promise<string[]>;
  diff(file: string): Promise<string>;
  commitFile(file: string): Promise<void>;
}

export interface SelectChoice<T> {
  name: string;
  message?: string;
  value: T;
}

/** Interactive prompts. enquirer + console on the CLI; Obsidian Modal/Notice in
 * the plugin. */
export interface Prompter {
  select<T>(opts: { message: string; choices: SelectChoice<T>[] }): Promise<T>;
  multiselect<T>(opts: {
    message: string;
    choices: SelectChoice<T>[];
  }): Promise<T[]>;
  confirm(message: string): Promise<boolean>;
  notify(message: string, level?: "info" | "warn" | "error"): void;
}

/** zlib (deflate, zlib-wrapped) compressor. node:zlib on the CLI, fflate's
 * `zlibSync` in the plugin. Used only for the mermaid.ink `pako:` image URL. */
export interface Deflater {
  zlib(data: Uint8Array): Uint8Array;
}

/** Renders an Excalidraw drawing from the vault to a raster image.
 *
 * Only the Obsidian plugin can implement this — rendering goes through the
 * Excalidraw plugin's own `ExcalidrawAutomate` API, which has no equivalent
 * outside the app. The CLI leaves this undefined, and the upload path then
 * treats every drawing as unrenderable (see `uploadCommand`). */
export interface DiagramRenderer {
  /** True when the Excalidraw plugin is installed, enabled, and exposing its
   * automation API. Checked per upload, not cached — the user can toggle the
   * plugin at any time. */
  available(): boolean;
  /** Render the drawing at `path` (a vault-relative note path) to PNG bytes.
   * Returns null when the file isn't a drawing or rendering failed; the caller
   * distinguishes that from `available() === false`. */
  renderPng(path: string, scale: number): Promise<Uint8Array | null>;
}

/** Renders mermaid source to a raster image.
 *
 * Plugin-only, but for a different reason than `DiagramRenderer`: mermaid is
 * bundled, so the code would run anywhere — it is the rasterization that needs
 * a DOM (`canvas`, `Image`). The CLI leaves this undefined and keeps emitting
 * the `mermaid.ink` URL, which is also the plugin's fallback when a render
 * fails. */
export interface MermaidRenderer {
  /** Whether this environment can rasterize at all. Cheap enough to check per
   * upload; a headless context answers false rather than throwing mid-render. */
  available(): boolean;
  /** Render mermaid `source` to PNG bytes, or null when it could not be drawn
   * (invalid syntax, or a diagram type this mermaid version doesn't know). */
  renderPng(source: string, scale: number): Promise<Uint8Array | null>;
}

export interface ConfluenceConfig {
  baseUrl: string;
  email?: string;
  apiToken?: string;
  accessToken?: string;
  debug?: boolean;
}

/** Bundle of adapters threaded through the core pipeline. Not a module-level
 * singleton so the plugin can hold per-vault contexts. */
export interface CoreContext {
  dom: DomAdapter;
  fs: FileSystem;
  path: PathUtil;
  hasher: Hasher;
  http: HttpClient;
  git: Git;
  prompter: Prompter;
  config: ConfluenceConfig;
  /** Absent on the CLI, where Excalidraw rendering is impossible. */
  diagrams?: DiagramRenderer;
  /** Absent on the CLI, which has no DOM to rasterize with. */
  mermaid?: MermaidRenderer;
}
