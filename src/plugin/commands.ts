/**
 * Plugin command implementations: download, upload, search.
 *
 * Each ties Obsidian's vault/workspace to the shared core pipeline. Kept
 * node-free (vault I/O via adapters, conversion via the core).
 */

import { Modal, Notice, Setting, TFile } from "obsidian";
import { nanoid } from "nanoid";

import { parseFrontmatter } from "../core/dialect/frontmatter.js";
import {
  canonicalToObsidian,
  parseObsidianComments,
} from "../core/dialect/obsidian.js";
import {
  canonicalImagesToEmbeds,
  canonicalLinksToWiki,
  embedsToCanonicalImages,
  wikiLinksToCanonical,
} from "../core/dialect/links.js";
import { parseHeader } from "../md-header.js";
import { hasUnresolvedConflicts } from "../sync/conflict.js";
import { downloadReferencedAttachments } from "../core/pipeline/attachment-download.js";
import { downloadPageToObsidian } from "../core/pipeline/obsidian-download.js";
import { uploadObsidianPage } from "../core/pipeline/obsidian-upload.js";
import {
  parsePageId,
  readSidecar,
  writeSidecar,
} from "../core/pipeline/sidecar-store.js";
import type ConfluenceToolsPlugin from "./main.js";
import { syncAfterDownload } from "./obsidisync.js";
import { Progress } from "./progress.js";
import { buildPageIndex, mimeForFilename } from "./vault-index.js";

function sanitizeTitle(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "Untitled"
  );
}

class InputModal extends Modal {
  private submitted = false;
  constructor(
    plugin: ConfluenceToolsPlugin,
    private readonly opts: { title: string; placeholder?: string },
    private readonly onSubmit: (value: string) => void,
  ) {
    super(plugin.app);
  }
  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    const input = this.contentEl.createEl("input", { type: "text" });
    input.placeholder = this.opts.placeholder ?? "";
    input.style.width = "100%";
    const submit = () => {
      if (this.submitted) return;
      this.submitted = true;
      this.close();
      this.onSubmit(input.value.trim());
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("OK").setCta().onClick(submit),
    );
    window.setTimeout(() => input.focus(), 0);
  }
}

function askInput(
  plugin: ConfluenceToolsPlugin,
  opts: { title: string; placeholder?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new InputModal(plugin, opts, (v) => {
      answered = true;
      resolve(v || null);
    });
    const origClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      origClose();
      if (!answered) resolve(null);
    };
    modal.open();
  });
}

const genId = () => nanoid(6);

/** Upload each `![[embed]]` image referenced in the note as a Confluence
 * attachment, skipping any whose content hash is unchanged since last upload. */
async function uploadReferencedImages(
  plugin: ConfluenceToolsPlugin,
  note: TFile,
  pageId: string,
  markdown: string,
  sidecar: { imageHashes?: Record<string, string> },
): Promise<void> {
  const ctx = plugin.buildContext();
  const client = plugin.client();
  const names = new Set<string>();
  for (const m of markdown.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    names.add((m[1] ?? "").trim());
  }
  if (!names.size) return;
  sidecar.imageHashes = sidecar.imageHashes ?? {};

  for (const name of names) {
    const target = plugin.app.metadataCache.getFirstLinkpathDest(
      name,
      note.path,
    );
    if (!(target instanceof TFile)) continue;
    const bytes = new Uint8Array(await plugin.app.vault.readBinary(target));
    const hash = await ctx.hasher.sha256Hex(bytes);
    if (sidecar.imageHashes[name] === hash) continue; // unchanged → skip
    await client.uploadAttachment(pageId, name, bytes, mimeForFilename(name));
    sidecar.imageHashes[name] = hash;
  }
}

/** Apply link/image translation and write a downloaded page + sidecar to a note
 * path. Shared by single-page download, create, and download-all. */
async function writeDownloadedPage(
  plugin: ConfluenceToolsPlugin,
  result: Awaited<ReturnType<typeof downloadPageToObsidian>>,
  notePath: string,
  pageId: string,
): Promise<void> {
  const ctx = plugin.buildContext();
  const index = buildPageIndex(plugin.app);
  result.sidecar.images = result.sidecar.images ?? {};
  let markdown = canonicalLinksToWiki(result.markdown, (id) =>
    index.idToNote(id),
  );
  markdown = canonicalImagesToEmbeds(markdown, result.sidecar.images);
  // Carry over any locally-resolved comment refs from a prior sidecar.
  const prior = await readSidecar(ctx.fs, ctx.path, notePath);
  if (prior?.resolved?.length) {
    result.sidecar.resolved = [
      ...new Set([...(result.sidecar.resolved ?? []), ...prior.resolved]),
    ];
  }
  // Snapshot the written body (frontmatter stripped) as the change-gutter base.
  result.sidecar.baseObsidian = parseFrontmatter(markdown).body;
  await plugin.app.vault.adapter.write(notePath, markdown);
  // Fetch referenced attachment binaries so embeds (SVG/PNG/…) render, and
  // record their hashes so a subsequent upload skips the unchanged ones.
  await downloadReferencedAttachments(
    ctx,
    plugin.client(),
    pageId,
    markdown,
    notePath,
    result.sidecar,
  );
  await writeSidecar(ctx.fs, ctx.path, notePath, result.sidecar);
  plugin.invalidateGutter();
}

/** Locally-resolved comment refs recorded in a note's sidecar (for filtering on
 * re-download). */
async function loadResolvedRefs(
  plugin: ConfluenceToolsPlugin,
  notePath: string,
): Promise<string[] | undefined> {
  const ctx = plugin.buildContext();
  const sidecar = await readSidecar(ctx.fs, ctx.path, notePath);
  return sidecar?.resolved;
}

/** Resolve a single comment: strip its `%%= … =%%` markup from the note (keeping
 * the anchored text) and record its marker ref so it won't reappear on a future
 * download. */
export async function resolveComment(
  plugin: ConfluenceToolsPlugin,
  file: TFile,
  ids: string[],
): Promise<void> {
  try {
    const ctx = plugin.buildContext();
    const text = await plugin.app.vault.read(file);
    const comments = parseObsidianComments(text);
    const target = comments.find((c) => c.ids.some((id) => ids.includes(id)));
    if (!target) {
      new Notice("Comment not found in this note.");
      return;
    }
    await plugin.app.vault.modify(file, text.replace(target.raw, target.anchor));

    const sidecar = (await readSidecar(ctx.fs, ctx.path, file.path)) ?? {
      baseMarkdown: "",
      comments: {},
    };
    sidecar.resolved = sidecar.resolved ?? [];
    for (const id of target.ids) {
      const uuid = sidecar.comments?.[id]?.uuid;
      if (uuid && !sidecar.resolved.includes(uuid)) sidecar.resolved.push(uuid);
      if (sidecar.comments) delete sidecar.comments[id];
    }
    await writeSidecar(ctx.fs, ctx.path, file.path, sidecar);
    new Notice("Comment resolved.");
  } catch (e) {
    new Notice(`Resolve failed: ${(e as Error).message}`);
  }
}

/** The folder of the active note (where new downloads land), or "" for the
 * vault root when there's no active note. */
function activeFolder(plugin: ConfluenceToolsPlugin): string {
  const p = plugin.app.workspace.getActiveFile()?.parent?.path ?? "";
  return p === "/" ? "" : p;
}

async function readPageIdAt(
  plugin: ConfluenceToolsPlugin,
  notePath: string,
): Promise<string | null> {
  try {
    const txt = await plugin.app.vault.adapter.read(notePath);
    const pid = parseFrontmatter(txt).props.pageId;
    return pid ? String(pid) : null;
  } catch {
    return null;
  }
}

/** Decide where a downloaded page should be written, inside the active note's
 * folder. On a name clash: if the existing note is itself a Confluence download,
 * ask to overwrite (null = cancel); otherwise date-suffix the basename so a
 * hand-written note is never clobbered. */
async function resolveDownloadPath(
  plugin: ConfluenceToolsPlugin,
  title: string,
): Promise<string | null> {
  const folder = activeFolder(plugin);
  const base = sanitizeTitle(title);
  const join = (name: string) => (folder ? `${folder}/${name}` : name);
  const target = join(`${base}.md`);

  if (!(await plugin.app.vault.adapter.exists(target))) return target;

  const existingPageId = await readPageIdAt(plugin, target);
  if (existingPageId) {
    const ok = await plugin.buildContext().prompter.confirm(
      `"${base}.md" already exists (Confluence page ${existingPageId}). Overwrite with the latest from Confluence?`,
    );
    return ok ? target : null;
  }

  const date = new Date().toISOString().slice(0, 10);
  new Notice(
    `"${base}.md" exists and isn't a Confluence page — saving as "${base} ${date}.md".`,
  );
  return join(`${base} ${date}.md`);
}

/** Download a page (by URL/pageId, or re-pull the active note) into the vault. */
export async function downloadCommand(
  plugin: ConfluenceToolsPlugin,
  rawInput?: string,
): Promise<void> {
  if (!plugin.settings.baseUrl) {
    new Notice("Set the Confluence base URL in settings first.");
    return;
  }
  let input = rawInput;
  let activePath: string | undefined;
  if (!input) {
    const active = plugin.app.workspace.getActiveFile();
    if (active) {
      const md = await plugin.app.vault.read(active);
      const pid = parseFrontmatter(md).props.pageId;
      if (pid) {
        input = String(pid);
        activePath = active.path; // re-pulling the open note
      }
    }
  }
  if (!input) {
    input =
      (await askInput(plugin, {
        title: "Download Confluence page",
        placeholder: "Page URL or pageId",
      })) ?? undefined;
  }
  if (!input) return;

  const pageId = parsePageId(input);
  if (!pageId) {
    new Notice("Could not parse a pageId from that input.");
    return;
  }

  const progress = new Progress(plugin, "Download");
  try {
    progress.start("Fetching page…");
    const resolvedRefs = activePath
      ? await loadResolvedRefs(plugin, activePath)
      : undefined;
    const result = await downloadPageToObsidian(plugin.client(), pageId, {
      genId,
      now: new Date().toISOString(),
      onStep: (m) => progress.step(m),
      resolvedRefs,
    });

    let notePath: string | null;
    if (activePath) {
      // Re-pulling the open note: write back to the same file (after confirm).
      const ok = await plugin.buildContext().prompter.confirm(
        `Overwrite "${activePath}" with the latest from Confluence?`,
      );
      notePath = ok ? activePath : null;
    } else {
      notePath = await resolveDownloadPath(plugin, result.title);
    }
    if (!notePath) {
      progress.cancel("Download cancelled.");
      return;
    }

    progress.step("Writing note…");
    await writeDownloadedPage(plugin, result, notePath, pageId);
    const file = plugin.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof TFile) {
      await plugin.app.workspace.getLeaf(false).openFile(file);
    }
    progress.step("Syncing…");
    await syncAfterDownload(plugin, [notePath]);
    progress.done(`Downloaded "${result.title}" (v${result.version}).`);
  } catch (e) {
    progress.fail(e);
  }
}

/** Create a new Confluence page (optionally under a parent) and pull it in.
 * Shared by the palette command and the New Page dialog. */
export async function createConfluencePage(
  plugin: ConfluenceToolsPlugin,
  title: string,
  parentRaw?: string,
): Promise<void> {
  const client = plugin.client();
  let spaceId = plugin.settings.defaultSpaceId || undefined;
  let parentId: string | undefined;

  const progress = new Progress(plugin, "Create page");
  try {
    if (parentRaw) {
      parentId = parsePageId(parentRaw) ?? undefined;
      if (!parentId) {
        new Notice("Could not parse a pageId from the parent input.");
        return;
      }
      progress.start("Resolving parent…");
      const parent = await client.getPageStorage(parentId);
      spaceId = parent.spaceId || spaceId;
    }
    if (!spaceId) {
      new Notice(
        "No space to create in — set a default Space ID in settings, or give a parent page.",
      );
      return;
    }

    progress.step("Creating page…");
    const created = await client.createPage(spaceId, title, parentId);
    const result = await downloadPageToObsidian(client, created.id, {
      genId,
      now: new Date().toISOString(),
      onStep: (m) => progress.step(m),
    });
    const notePath = await resolveDownloadPath(plugin, title);
    if (!notePath) {
      progress.cancel(
        `Created page ${created.id} in Confluence — skipped writing a local note.`,
      );
      return;
    }
    progress.step("Writing note…");
    await writeDownloadedPage(plugin, result, notePath, created.id);
    const file = plugin.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof TFile) {
      await plugin.app.workspace.getLeaf(false).openFile(file);
    }
    progress.step("Syncing…");
    await syncAfterDownload(plugin, [notePath]);
    progress.done(`Created "${title}" (page ${created.id}).`);
  } catch (e) {
    progress.fail(e);
  }
}

/** Palette command: prompt for title + parent, then create. */
export async function createCommand(plugin: ConfluenceToolsPlugin): Promise<void> {
  if (!plugin.settings.baseUrl) {
    new Notice("Set the Confluence base URL in settings first.");
    return;
  }
  const title = await askInput(plugin, {
    title: "New Confluence page",
    placeholder: "Page title",
  });
  if (!title) return;
  const parentRaw = await askInput(plugin, {
    title: "Parent page (optional)",
    placeholder: "Parent URL/pageId — leave blank for the space root",
  });
  await createConfluencePage(plugin, title, parentRaw ?? undefined);
}

/** Re-download every note in the vault that has a pageId (overwriting local
 * changes — guarded by a confirm). */
export async function downloadAllCommand(
  plugin: ConfluenceToolsPlugin,
): Promise<void> {
  if (!plugin.settings.baseUrl) {
    new Notice("Set the Confluence base URL in settings first.");
    return;
  }
  const targets: { path: string; pageId: string }[] = [];
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    const pid = plugin.app.metadataCache.getFileCache(f)?.frontmatter?.pageId;
    if (pid !== undefined && pid !== null && pid !== "") {
      targets.push({ path: f.path, pageId: String(pid) });
    }
  }
  if (!targets.length) {
    new Notice("No notes with a pageId to refresh.");
    return;
  }
  const ok = await plugin.buildContext().prompter.confirm(
    `Re-download ${targets.length} page(s) from Confluence? Local changes to these notes will be overwritten.`,
  );
  if (!ok) return;

  const client = plugin.client();
  let done = 0;
  let failed = 0;
  const written: string[] = [];
  const progress = new Progress(plugin, "Download all");
  progress.start(`0/${targets.length}`);
  for (const t of targets) {
    const name = t.path.split("/").pop() ?? t.path;
    progress.step(`${done + failed + 1}/${targets.length} — ${name}`);
    try {
      const result = await downloadPageToObsidian(client, t.pageId, {
        genId,
        now: new Date().toISOString(),
        resolvedRefs: await loadResolvedRefs(plugin, t.path),
      });
      await writeDownloadedPage(plugin, result, t.path, t.pageId);
      written.push(t.path);
      done++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[confluence-tools] Download all: ${t.path} failed:`, e);
      failed++;
    }
  }
  // One sync for the whole batch; conflicting downloads win on the server.
  if (written.length) {
    progress.step("Syncing…");
    await syncAfterDownload(plugin, written);
  }
  progress.done(
    `Downloaded ${done} page(s)${failed ? `, ${failed} failed (see console)` : ""}.`,
  );
}

/** Upload the active note back to Confluence. */
export async function uploadCommand(
  plugin: ConfluenceToolsPlugin,
): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) {
    new Notice("No active note to upload.");
    return;
  }
  const markdown = await plugin.app.vault.read(file);
  if (hasUnresolvedConflicts(markdown)) {
    new Notice(
      "This note still has unresolved conflict markers — resolve them before uploading.",
    );
    return;
  }
  const props = parseFrontmatter(markdown).props;
  const pageId = props.pageId ? String(props.pageId) : null;
  if (!pageId) {
    new Notice("This note has no pageId property — download it first.");
    return;
  }

  const ctx = plugin.buildContext();
  const sidecar = (await readSidecar(ctx.fs, ctx.path, file.path)) ?? {
    baseMarkdown: "",
    comments: {},
  };

  const progress = new Progress(plugin, "Upload");
  try {
    progress.start("Uploading images…");
    // Upload referenced vault images as attachments (skipping unchanged ones).
    await uploadReferencedImages(plugin, file, pageId, markdown, sidecar);

    // Translate [[wikilinks]] → pageid: links and ![[embeds]] → attachment refs.
    const index = buildPageIndex(plugin.app);
    let canonicalish = wikiLinksToCanonical(markdown, (n) => index.noteToId(n));
    canonicalish = embedsToCanonicalImages(canonicalish, sidecar.images);

    const result = await uploadObsidianPage(
      plugin.client(),
      pageId,
      canonicalish,
      sidecar,
      (m) => progress.step(m),
    );

    if (result.status === "conflict") {
      // Remote advanced and the edits conflict. Surface the merged document
      // (with <<<<<<< / >>>>>>> markers) in the note for the user to resolve,
      // and refresh only the comment map — keep base + version so the next
      // upload re-merges against the original base.
      const conv = canonicalToObsidian(result.canonical, {
        genId,
        downloadedAt: new Date().toISOString(),
      });
      let conflictMd = canonicalLinksToWiki(conv.markdown, (id) =>
        index.idToNote(id),
      );
      conflictMd = canonicalImagesToEmbeds(
        conflictMd,
        conv.sidecar.images ?? {},
      );
      await plugin.app.vault.modify(file, conflictMd);
      sidecar.comments = conv.sidecar.comments;
      await writeSidecar(ctx.fs, ctx.path, file.path, sidecar);
      progress.cancel();
      new Notice(
        "Remote changed and your edits conflict. Conflict markers written to the note — resolve them, then upload again.",
        10000,
      );
      return;
    }

    // Refresh the sidecar base + version for the next sync. The just-uploaded
    // note body becomes the new change-gutter base (no local changes now).
    const uploadedAt = new Date().toISOString();
    sidecar.baseMarkdown = parseHeader(result.canonical).body;
    sidecar.baseObsidian = parseFrontmatter(markdown).body;
    sidecar.version = result.newVersion;
    sidecar.downloadedAt = uploadedAt;
    await writeSidecar(ctx.fs, ctx.path, file.path, sidecar);
    // Sync the note's frontmatter to the new version so the status panel (which
    // reads frontmatter, not the sidecar) shows "up to date" rather than
    // "remote + local changes".
    await plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fm.confluenceVersion = result.newVersion;
      fm.confluenceDownloadedAt = uploadedAt;
    });
    plugin.invalidateGutter();
    progress.done(`Uploaded "${file.basename}" (v${result.newVersion}).`);
  } catch (e) {
    progress.fail(e);
  }
}

/** Search Confluence and download a chosen result. */
export async function searchCommand(
  plugin: ConfluenceToolsPlugin,
): Promise<void> {
  if (!plugin.settings.baseUrl) {
    new Notice("Set the Confluence base URL in settings first.");
    return;
  }
  const query = await askInput(plugin, {
    title: "Search Confluence",
    placeholder: "Search query",
  });
  if (!query) return;

  try {
    const results = await plugin.client().searchPages(query, 10);
    if (!results.length) {
      new Notice("No results.");
      return;
    }
    const choice = await plugin.buildContext().prompter.select({
      message: "Select a page to download",
      choices: results.map((r) => ({
        name: `${r.title}  ·  ${r.spaceKey}`,
        message: r.excerpt.replace(/<[^>]+>/g, "").slice(0, 80),
        value: r.id,
      })),
    });
    if (choice) await downloadCommand(plugin, choice);
  } catch (e) {
    new Notice(`Search failed: ${(e as Error).message}`);
  }
}
