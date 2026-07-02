/**
 * Download attachments referenced as `![[embed]]`s in a note's markdown into
 * an `attachments/` folder next to the note.
 *
 * Platform-agnostic: takes plain ports (FileSystem/PathUtil/Hasher) and a
 * ConfluenceClient slice rather than an Obsidian plugin instance, so it can
 * run under the Node CLI's tsconfig/tests as well as the plugin.
 */

import type { ConfluenceClient } from "../../api.js";
import type { CoreContext } from "../ports.js";

/** Download every attachment referenced as an embed in `markdown` into an
 * `attachments/` folder next to the note (created on demand, reused when it
 * already exists), so Obsidian can resolve and render it. Wikilink embeds keep
 * the bare filename — Obsidian resolves `![[name]]` across folders.
 *
 * Also migrates attachments downloaded by an older version of this plugin
 * (sitting directly next to the note): every referenced attachment is
 * re-fetched and (re)written into `attachments/` on each call, so a stale
 * sibling copy is always found and removed — the move isn't gated on the
 * remote content having changed. */
export async function downloadReferencedAttachments(
  ctx: Pick<CoreContext, "fs" | "path" | "hasher">,
  client: Pick<ConfluenceClient, "listAttachments" | "downloadAttachmentData">,
  pageId: string,
  markdown: string,
  notePath: string,
  sidecar: { imageHashes?: Record<string, string> },
): Promise<void> {
  const names = new Set<string>();
  for (const m of markdown.matchAll(/!\[\[([^\]\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    names.add((m[1] ?? "").trim());
  }
  if (!names.size) return;

  let attachments: Awaited<ReturnType<typeof client.listAttachments>>;
  try {
    attachments = await client.listAttachments(pageId);
  } catch {
    return;
  }
  const byName = new Map(attachments.map((a) => [a.filename, a]));
  const wanted = [...names].filter((n) => byName.has(n));
  if (!wanted.length) return; // all embeds are local images, not attachments
  const dir = ctx.path.dirname(notePath);
  const folder = dir && dir !== "." ? dir : "";
  const attachmentsDir = folder ? `${folder}/attachments` : "attachments";
  await ctx.fs.mkdir(attachmentsDir);
  sidecar.imageHashes = sidecar.imageHashes ?? {};

  for (const name of wanted) {
    const att = byName.get(name);
    if (!att) continue;
    try {
      const bytes = await client.downloadAttachmentData(att.downloadPath);
      await ctx.fs.writeBytes(`${attachmentsDir}/${name}`, bytes);
      // Migrate: drop a copy sitting directly next to the note from before
      // attachments moved into the subfolder, so `![[name]]` can't resolve to
      // the stale sibling.
      const legacy = folder ? `${folder}/${name}` : name;
      if (await ctx.fs.exists(legacy)) await ctx.fs.remove(legacy);
      sidecar.imageHashes[name] = await ctx.hasher.sha256Hex(bytes);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[confluence-tools] attachment "${name}" failed:`, e);
    }
  }
}
