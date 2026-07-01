/**
 * Build a ConfluenceClient from process.env using the node fetch transport.
 *
 * Why: the ConfluenceClient class is platform-agnostic (HTTP injected). This
 * node-only factory supplies the fetch-backed transport and reads credentials
 * from the environment — the CLI's configuration source. The plugin builds its
 * client from settings + the requestUrl transport instead.
 */

import { ConfluenceClient } from "../../api.js";
import { nodeHttp } from "./http.js";

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
    http: nodeHttp,
  });
}
