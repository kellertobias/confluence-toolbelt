/**
 * Vitest global setup: register the node DOM adapter so the conversion code's
 * `getDom()` works in tests without each test wiring it up.
 */

import { nodeDeflater } from "../adapters/node/deflate.js";
import { nodeDom } from "../adapters/node/dom.js";
import { setDeflater } from "../storage-dom/deflate.js";
import { setDom } from "../storage-dom/dom.js";

setDom(nodeDom);
setDeflater(nodeDeflater);
