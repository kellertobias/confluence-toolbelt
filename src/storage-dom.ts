/**
 * Storage DOM helpers — public entry point.
 *
 * Why: We translate Confluence storage HTML to markdown blocks with nodeId
 * tags, and replace specific nodes by nodeId for partial updates. The heavy
 * lifting lives in focused modules under `./storage-dom/`; this file simply
 * re-exports the public surface so consumers can keep importing from
 * `./storage-dom.js`.
 */

export { extractHeaderExtrasFromStorage } from "./storage-dom/header-extras.js";
export {
  markdownToStorageHtml,
  naiveMarkdownToStorageHtml,
} from "./storage-dom/markdown-to-storage.js";
export { replaceNodesById } from "./storage-dom/replace-nodes.js";
export {
  type MappedNode,
  storageToMarkdownBlocks,
} from "./storage-dom/storage-to-markdown.js";
export { detectUnsupportedFeatures } from "./storage-dom/unsupported-features.js";
