/**
 * Enrich `<ri:content-entity ri:content-id="ID"/>` elements by looking up
 * the space key for each referenced page and rewriting them as
 * `<ri:page ri:space-key="SPACE" ri:content-id="ID"/>`.
 *
 * Why: Confluence stores URL-paste links as bare content-entity refs with no
 * space information. The downstream converter needs `ri:space-key` to produce
 * the `page:SPACE:ID` format the user expects. A lightweight V1 API call per
 * unique ID resolves this; results are fetched in parallel.
 *
 * Note: The raw `storageHtml` (from Confluence) is kept unchanged for the
 * sync sidecar — only the value returned here is passed to the markdown
 * converter.
 */

export async function enrichContentEntityLinks(
  storageHtml: string,
  resolveSpaceKey: (pageId: string) => Promise<string | undefined>,
): Promise<string> {
  const ids = new Set<string>();
  for (const m of storageHtml.matchAll(
    /<ri:content-entity\b[^>]*\bri:content-id=["']([^"']+)["'][^>]*\/?>/gi,
  )) {
    if (m[1]) ids.add(m[1]);
  }
  if (ids.size === 0) return storageHtml;

  const pairs = await Promise.all(
    Array.from(ids).map(async (id) => [id, await resolveSpaceKey(id)] as const),
  );
  const spaceKeyMap = new Map<string, string>(
    pairs.filter((p): p is [string, string] => p[1] != null),
  );
  if (spaceKeyMap.size === 0) return storageHtml;

  return storageHtml.replace(
    /<ri:content-entity\b[^>]*\bri:content-id=["']([^"']+)["'][^>]*\/?>/gi,
    (match, id: string) => {
      const spaceKey = spaceKeyMap.get(id);
      return spaceKey
        ? `<ri:page ri:space-key="${spaceKey}" ri:content-id="${id}"/>`
        : match;
    },
  );
}
